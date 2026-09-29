import {
	a6Raster,
	emptyInfo,
	END_PRINT,
	FEED_AFTER_PRINT,
	INFO_QUERIES,
	INITIALIZE,
	PrinterCredits,
	RESPONSE,
	SERVICE,
	STATUS,
	supportsRasterPrinting,
	WRITE,
	type PrinterInfo
} from './protocol.js';
import type { Raster } from './raster.js';

// The small Web Bluetooth surface used here also makes disconnect races testable.
export interface BluetoothCharacteristic extends EventTarget {
	readonly value?: DataView;
	startNotifications(): Promise<BluetoothCharacteristic>;
	writeValueWithoutResponse(value: Uint8Array<ArrayBuffer>): Promise<void>;
}

export interface BluetoothGattServer {
	readonly connected: boolean;
	connect(): Promise<BluetoothGattServer>;
	disconnect(): void;
	getPrimaryService(uuid: number): Promise<{
		getCharacteristic(uuid: number): Promise<BluetoothCharacteristic>;
	}>;
}

export interface BluetoothDevice extends EventTarget {
	readonly name?: string;
	readonly gatt?: BluetoothGattServer;
}

export interface BluetoothApi {
	requestDevice(options: {
		filters: { namePrefix: string }[];
		optionalServices: number[];
	}): Promise<BluetoothDevice>;
}

export type Phase =
	| 'idle'
	| 'choosing'
	| 'connecting'
	| 'reading'
	| 'connected'
	| 'printing'
	| 'disconnected'
	| 'error';
export type Notice = 'cancelled' | 'user' | 'lost' | 'sent' | null;
export type EventKind =
	| 'choosing'
	| 'connecting'
	| 'reading'
	| 'connected'
	| 'refreshed'
	| 'printing'
	| 'sent'
	| 'cancelled'
	| 'user'
	| 'lost'
	| 'error';
export type ErrorCode = 'timeout' | 'response' | 'permission' | 'connection';

export interface PrinterState {
	phase: Phase;
	deviceName: string | null;
	info: PrinterInfo;
	updatedAt: number | null;
	notice: Notice;
	error: { code: ErrorCode; detail: string } | null;
	events: { id: number; at: number; kind: EventKind }[];
}

export function initialState(): PrinterState {
	return {
		phase: 'idle',
		deviceName: null,
		info: emptyInfo(),
		updatedAt: null,
		notice: null,
		error: null,
		events: []
	};
}

export function browserBluetooth(): BluetoothApi | undefined {
	if (typeof navigator === 'undefined') return undefined;
	return (navigator as Navigator & { bluetooth?: BluetoothApi }).bluetooth;
}

class PrinterError extends Error {
	constructor(
		readonly code: ErrorCode,
		message: string
	) {
		super(message);
	}
}

interface Session {
	abort: AbortController;
	device?: BluetoothDevice;
	response?: BluetoothCharacteristic;
	write?: BluetoothCharacteristic;
	status?: BluetoothCharacteristic;
	credits: PrinterCredits;
	wakeWriter?: () => void;
	printCompleted?: () => void;
	onDisconnect: () => void;
	onResponse: () => void;
	onStatus: () => void;
	pending?: { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void };
}

export class PeriPageClient {
	#state = initialState();
	#listeners = new Set<(state: PrinterState) => void>();
	#session?: Session;
	#eventId = 0;
	#requestingPrint = false;

	constructor(private readonly bluetooth: () => BluetoothApi | undefined = browserBluetooth) {}

	get state(): PrinterState {
		return this.#state;
	}

	subscribe(listener: (state: PrinterState) => void): () => void {
		this.#listeners.add(listener);
		listener(this.#state);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	async connect(): Promise<boolean> {
		if (this.#session) return false;
		const api = this.bluetooth();
		if (!api) return false;
		const session: Session = {
			abort: new AbortController(),
			credits: new PrinterCredits(),
			onStatus: () => {
				const value = session.status?.value;
				if (this.#session !== session || !value) return;
				session.credits.accept(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
				session.wakeWriter?.();
			},
			onDisconnect: () => {
				if (this.#session !== session) return;
				this.#release(session);
				this.#update(
					{
						phase: 'disconnected',
						notice: 'lost',
						info: emptyInfo(),
						updatedAt: null,
						error: null
					},
					'lost'
				);
			},
			onResponse: () => {
				const value = session.response?.value;
				if (this.#session !== session || !value) return;
				const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
				// An unsolicited print-completion byte is not an information response.
				if (bytes.length === 1 && bytes[0] === 0xaa) {
					session.printCompleted?.();
					return;
				}
				session.pending?.resolve(bytes);
			}
		};
		this.#session = session;
		this.#update(
			{
				phase: 'choosing',
				deviceName: null,
				info: emptyInfo(),
				updatedAt: null,
				notice: null,
				error: null
			},
			'choosing'
		);

		try {
			// Keep requestDevice in the click's call stack to preserve user activation.
			// FF00 is discovered after connecting; the A6 advertises FEE7 instead.
			const device = await this.#step(
				api.requestDevice({
					filters: [{ namePrefix: 'PeriPage' }],
					optionalServices: [SERVICE]
				}),
				session,
				0
			);
			this.#assertCurrent(session);
			session.device = device;
			device.addEventListener('gattserverdisconnected', session.onDisconnect);
			this.#update({ phase: 'connecting', deviceName: device.name ?? 'PeriPage' }, 'connecting');
			if (!device.gatt) throw new Error('The selected device has no GATT server');
			const connecting = device.gatt.connect();
			void connecting.then(
				(server) => {
					// A cancelled connection can still resolve. Never close a newer session.
					if (this.#session !== session && this.#session?.device !== device) server.disconnect();
				},
				() => {}
			);
			const server = await this.#step(connecting, session);
			this.#assertCurrent(session);
			const service = await this.#step(server.getPrimaryService(SERVICE), session);
			this.#assertCurrent(session);
			session.response = await this.#step(service.getCharacteristic(RESPONSE), session);
			this.#assertCurrent(session);
			session.write = await this.#step(service.getCharacteristic(WRITE), session);
			this.#assertCurrent(session);
			session.status = await this.#step(service.getCharacteristic(STATUS), session);
			this.#assertCurrent(session);
			session.response.addEventListener('characteristicvaluechanged', session.onResponse);
			session.status.addEventListener('characteristicvaluechanged', session.onStatus);
			// GATT operations must be serialized, including notification setup.
			await this.#step(session.response.startNotifications(), session);
			this.#assertCurrent(session);
			await this.#step(session.status.startNotifications(), session);
			this.#assertCurrent(session);
			// The browser can miss the initial FF03 grant during notification setup.
			// Bootstrap with the single, short initialization write used by the
			// original connection flow. Its returned credit unlocks later writes.
			// If a grant (including an explicit pause) arrived, respect it normally.
			if (!session.credits.canWrite && !session.credits.paused) {
				session.credits.bootstrapInitialization();
				await this.#step(session.write.writeValueWithoutResponse(INITIALIZE.slice()), session);
			} else {
				await this.#write(INITIALIZE, session);
			}
			this.#assertCurrent(session);
			await this.#step(new Promise<void>((resolve) => setTimeout(resolve, 160)), session);
			await this.#readInfo(session, false);
			return this.#session === session && this.#state.phase === 'connected';
		} catch (error) {
			this.#fail(session, error);
			return false;
		}
	}

	async refresh(): Promise<void> {
		const session = this.#session;
		if (!session || this.#state.phase !== 'connected') return;
		try {
			await this.#readInfo(session, true);
		} catch (error) {
			this.#fail(session, error);
		}
	}

	async print(raster: Raster): Promise<void> {
		if (
			this.#requestingPrint ||
			['choosing', 'connecting', 'reading', 'printing'].includes(this.#state.phase)
		)
			return;
		// Snapshot and validate before opening the chooser so changes made by the
		// caller during connection cannot replace the requested image.
		const { header, body } = a6Raster(raster);
		this.#requestingPrint = true;
		try {
			// connect() calls requestDevice synchronously, preserving the click gesture.
			if (!this.#session && !(await this.connect())) return;
			const session = this.#session;
			if (!session || this.#state.phase !== 'connected') return;
			if (!supportsRasterPrinting(this.#state.info)) throw new Error('Unsupported printer profile');
			await this.#printRaster(header, body, session);
		} finally {
			this.#requestingPrint = false;
		}
	}

	async #printRaster(header: Uint8Array, body: Uint8Array, session: Session): Promise<void> {
		this.#update({ phase: 'printing', notice: null, error: null }, 'printing');
		try {
			await this.#write(INITIALIZE.subarray(0, 4), session);
			await this.#step(new Promise<void>((resolve) => setTimeout(resolve, 5)), session);
			await this.#write(INITIALIZE.subarray(4), session);
			await this.#write(header, session);
			await this.#write(body, session);
			await this.#write(FEED_AFTER_PRINT, session);
			await this.#step(new Promise<void>((resolve) => setTimeout(resolve, 50)), session);
			let complete!: () => void;
			const completion = new Promise<void>((resolve) => {
				complete = resolve;
			});
			await this.#write(END_PRINT, session, () => {
				session.printCompleted = complete;
			});
			await this.#step(completion, session, 30000);
			this.#assertCurrent(session);
			// AA acknowledges the job; it does not prove paper movement or print quality.
			this.#update({ phase: 'connected', notice: 'sent' }, 'sent');
		} catch (error) {
			this.#fail(session, error);
		} finally {
			session.printCompleted = undefined;
		}
	}

	disconnect(): void {
		if (!this.#session) return;
		const cancelled = this.#state.phase === 'choosing';
		this.#release(this.#session);
		this.#update(
			{
				phase: cancelled ? 'idle' : 'disconnected',
				notice: cancelled ? 'cancelled' : 'user',
				info: emptyInfo(),
				updatedAt: null,
				error: null
			},
			cancelled ? 'cancelled' : 'user'
		);
	}

	dispose(): void {
		this.#listeners.clear();
		if (this.#session) this.#release(this.#session);
	}

	async #readInfo(session: Session, refreshing: boolean): Promise<void> {
		this.#assertCurrent(session);
		this.#update({ phase: 'reading', notice: null, error: null }, 'reading');
		for (const query of INFO_QUERIES) {
			const reply = new Promise<Uint8Array>((resolve, reject) => {
				session.pending = { resolve, reject };
			});
			try {
				const [, bytes] = await Promise.all([
					this.#write(query.command, session),
					this.#step(reply, session, 3000)
				]);
				this.#assertCurrent(session);
				try {
					this.#update({ info: query.apply(this.#state.info, bytes) });
				} catch {
					throw new PrinterError('response', `Invalid ${query.field} response`);
				}
			} finally {
				session.pending?.reject(new DOMException('Query ended', 'AbortError'));
				session.pending = undefined;
			}
		}
		if (supportsRasterPrinting(this.#state.info)) session.credits.applyV136Profile();
		this.#update(
			{ phase: 'connected', updatedAt: Date.now() },
			refreshing ? 'refreshed' : 'connected'
		);
	}

	async #write(bytes: Uint8Array, session: Session, beforeLastWrite?: () => void): Promise<void> {
		for (let offset = 0; offset < bytes.length;) {
			this.#assertCurrent(session);
			while (!session.credits.canWrite) {
				try {
					await this.#step(
						new Promise<void>((resolve) => {
							session.wakeWriter = resolve;
						}),
						session,
						10000
					);
				} finally {
					session.wakeWriter = undefined;
				}
			}
			this.#assertCurrent(session);
			// The tested A6 accepts 100-byte writes. Honor any smaller FF03 limit;
			// unknown profiles keep the conservative default until identified.
			const chunk = bytes.slice(offset, offset + Math.min(100, session.credits.packetBytes));
			session.credits.available--;
			if (offset + chunk.length === bytes.length) beforeLastWrite?.();
			await this.#step(session.write!.writeValueWithoutResponse(chunk), session);
			offset += chunk.length;
		}
	}

	#assertCurrent(session: Session): void {
		if (this.#session !== session || session.abort.signal.aborted) {
			throw new DOMException('Connection ended', 'AbortError');
		}
	}

	#step<T>(operation: Promise<T>, session: Session, timeout = 12000): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const signal = session.abort.signal;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const clear = () => {
				clearTimeout(timer);
				signal.removeEventListener('abort', onAbort);
			};
			const onAbort = () => {
				clear();
				reject(new DOMException('Connection ended', 'AbortError'));
			};
			signal.addEventListener('abort', onAbort, { once: true });
			if (timeout)
				timer = setTimeout(() => {
					clear();
					reject(new PrinterError('timeout', 'The printer did not respond in time'));
				}, timeout);
			operation.then(
				(value) => {
					clear();
					if (signal.aborted || this.#session !== session) onAbort();
					else resolve(value);
				},
				(error) => {
					clear();
					reject(error);
				}
			);
			if (signal.aborted || this.#session !== session) onAbort();
		});
	}

	#release(session: Session): void {
		if (this.#session === session) this.#session = undefined;
		session.device?.removeEventListener('gattserverdisconnected', session.onDisconnect);
		session.response?.removeEventListener('characteristicvaluechanged', session.onResponse);
		session.status?.removeEventListener('characteristicvaluechanged', session.onStatus);
		session.abort.abort();
		session.pending?.reject(new DOMException('Connection ended', 'AbortError'));
		session.pending = undefined;
		session.printCompleted = undefined;
		session.wakeWriter = undefined;
		session.device?.gatt?.disconnect();
	}

	#fail(session: Session, error: unknown): void {
		// Cancellation or link loss already set the correct state. Ignore late failures.
		if (this.#session !== session) return;
		const name = error instanceof Error ? error.name : '';
		const cancelled = this.#state.phase === 'choosing' && name === 'NotFoundError';
		this.#release(session);
		if (cancelled) {
			this.#update({ phase: 'idle', notice: 'cancelled' }, 'cancelled');
			return;
		}
		const code =
			error instanceof PrinterError
				? error.code
				: ['SecurityError', 'NotAllowedError'].includes(name)
					? 'permission'
					: 'connection';
		this.#update(
			{
				phase: 'error',
				notice: null,
				info: emptyInfo(),
				updatedAt: null,
				error: { code, detail: error instanceof Error ? error.message : String(error) }
			},
			'error'
		);
	}

	#update(patch: Partial<PrinterState>, event?: EventKind): void {
		this.#state = { ...this.#state, ...patch };
		if (event)
			this.#state.events = [
				...this.#state.events.slice(-9),
				{ id: ++this.#eventId, at: Date.now(), kind: event }
			];
		for (const listener of this.#listeners) listener(this.#state);
	}
}
