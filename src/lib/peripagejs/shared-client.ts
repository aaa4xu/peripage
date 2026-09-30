import { initialState, PeriPageClient, type PrinterState } from './client.js';
import { a6Raster } from './protocol.js';
import type { Raster } from './raster.js';

export interface SharedPrinterState extends PrinterState {
	ready: boolean;
	connection: 'local' | 'remote' | null;
	job: 'idle' | 'queued' | 'printing' | 'sent' | 'error';
}

type Client = Pick<
	PeriPageClient,
	'state' | 'subscribe' | 'connect' | 'refresh' | 'print' | 'disconnect' | 'dispose'
>;
type Command = { action: 'print'; raster: Raster } | { action: 'refresh' };
type Request = {
	type: 'request';
	owner: string;
	from: string;
	id: string;
	expires: number;
	command: Command;
};
type Reply = {
	type: 'reply';
	owner: string;
	to: string;
	id: string;
	status: 'accepted' | 'started' | 'done' | 'error';
	error?: string;
};
type Message =
	| { type: 'hello' }
	| { type: 'state'; owner: string; state: PrinterState }
	| { type: 'disconnect'; owner: string }
	| Request
	| Reply;
type Pending = {
	owner: string;
	command: Command;
	timer: ReturnType<typeof setTimeout>;
	resolve: () => void;
	reject: (error: Error) => void;
};

const DELIVERY_TIMEOUT = 10_000;
const closed = () => new Error('The printer connection closed. The job will not be retried.');
const active = (state: PrinterState) =>
	['choosing', 'connecting', 'reading', 'connected', 'printing'].includes(state.phase);

/** One tab owns BLE; other tabs use its serialized command queue on the same origin. */
export class SharedPeriPageClient {
	#state: SharedPrinterState = {
		...initialState(),
		ready: false,
		connection: null,
		job: 'idle'
	};
	#listeners = new Set<(state: SharedPrinterState) => void>();
	#channel?: BroadcastChannel;
	#locks?: LockManager;
	#lifetime?: AbortController;
	#watch?: AbortController;
	#unsubscribe?: () => void;
	#peer = '';
	#owner?: string;
	#lastOwner?: string;
	#release?: () => void;
	#retired = new Set<string>();
	#connecting?: Promise<boolean>;
	#discovery?: { promise: Promise<void>; finish: () => void };
	#pending = new Map<string, Pending>();
	#queue: Request[] = [];
	#replies = new Map<string, Reply>();
	#processing?: string;
	readonly #name: string;

	constructor(
		scope = '/',
		private readonly client: Client = new PeriPageClient()
	) {
		// Include the deployment path, but not the locale or label hash.
		this.#name = `peripagejs:${scope}:printer:v1`;
	}

	get state(): SharedPrinterState {
		return this.#state;
	}

	subscribe(listener: (state: SharedPrinterState) => void): () => void {
		this.#listeners.add(listener);
		listener(this.#state);
		return () => this.#listeners.delete(listener);
	}

	/** Browser-only setup, separate from construction for SSR and page-cache restoration. */
	start(): void {
		if (this.#lifetime || typeof window === 'undefined') return;
		this.#lifetime = new AbortController();
		if (!window.isSecureContext) {
			this.#update({ ready: true });
			return;
		}
		this.#peer = crypto.randomUUID();
		this.#unsubscribe = this.client.subscribe((state) => {
			if (!this.#release || !this.#owner) return;
			this.#publish(state);
			if (!active(state)) this.#endOwnership();
			else if (state.phase === 'connected') void this.#drain();
		});
		if (typeof BroadcastChannel === 'undefined' || !navigator.locks) {
			this.#update({ ready: true });
			return;
		}
		this.#locks = navigator.locks;
		this.#channel = new BroadcastChannel(this.#name);
		this.#channel.onmessage = (event: MessageEvent<Message>) => this.#receive(event.data);
		void this.#discover();
	}

	connect(): Promise<boolean> {
		if (this.#connecting) return this.#connecting;
		if (!this.#lifetime) return Promise.resolve(false);
		const operation = this.#connect();
		this.#connecting = operation;
		void operation.finally(() => {
			if (this.#connecting === operation) {
				this.#connecting = undefined;
				void this.#drain();
			}
		});
		return operation;
	}

	async #connect(): Promise<boolean> {
		const lifetime = this.#lifetime;
		try {
			if (!this.#state.ready) await this.#discover();
			if (!lifetime || lifetime.signal.aborted) return false;
			if (this.#owner) return await this.#waitConnected();
			if (!(await this.#claim())) {
				// A simultaneous click in another tab won the lock. Reuse its chooser/session.
				await this.#discover();
				return !lifetime.signal.aborted && this.#owner ? await this.#waitConnected() : false;
			}
			if (lifetime.signal.aborted) return false;
			const connected = await this.client.connect();
			// Unsupported Bluetooth and chooser cancellation must also release ownership.
			if (!connected && this.#lifetime === lifetime && this.#release) this.#endOwnership();
			return connected;
		} catch (error) {
			if (lifetime?.signal.aborted) return false;
			this.#update({ phase: 'error', error: { code: 'connection', detail: String(error) } });
			this.#endOwnership();
			return false;
		}
	}

	async print(raster: Raster): Promise<void> {
		const lifetime = this.#lifetime;
		if (!lifetime || lifetime.signal.aborted) return;
		if (this.#state.job === 'queued' || this.#state.job === 'printing') return;
		a6Raster(raster);
		const snapshot = { ...raster, data: raster.data.slice() };
		this.#update({ job: 'queued' });
		try {
			if (!this.#owner && !(await this.connect())) {
				if (!lifetime.signal.aborted) this.#update({ job: 'idle' });
				return;
			}
			if (lifetime.signal.aborted) return;
			await this.#request({ action: 'print', raster: snapshot });
			this.#update({ job: 'sent' });
		} catch (error) {
			if (!lifetime.signal.aborted) this.#update({ job: 'error' });
			throw error;
		}
	}

	async refresh(): Promise<void> {
		if (!this.#owner) return;
		try {
			await this.#request({ action: 'refresh' });
		} catch (error) {
			this.#update({ error: { code: 'connection', detail: String(error) } });
		}
	}

	/** Explicitly disconnects the shared printer, regardless of which tab owns it. */
	disconnect(): void {
		if (this.#release) this.client.disconnect();
		else if (this.#owner) this.#post({ type: 'disconnect', owner: this.#owner });
	}

	/** Closing a follower only detaches it. Closing the owner drops all unfinished jobs. */
	stop(): void {
		if (!this.#lifetime) return;
		this.#lifetime.abort();
		this.#unsubscribe?.();
		if (this.#release) {
			this.#publish(this.#lostState());
			this.client.dispose();
			this.#endOwnership();
		}
		this.#watch?.abort();
		this.#watch = undefined;
		this.#rejectPending();
		this.#discovery?.finish();
		this.#channel?.close();
		this.#channel = undefined;
		this.#locks = undefined;
		this.#owner = undefined;
		this.#lifetime = undefined;
		this.#connecting = undefined;
		this.#update({ ...initialState(), ready: false, connection: null, job: 'idle' });
	}

	dispose(): void {
		this.stop();
		this.#listeners.clear();
	}

	async #discover(): Promise<void> {
		if (!this.#locks || !this.#lifetime || this.#lifetime.signal.aborted) return;
		if (this.#discovery) return this.#discovery.promise;
		this.#update({ ready: false });
		let finish!: () => void;
		const promise = new Promise<void>((resolve) => (finish = resolve));
		const probe = new AbortController();
		const timer = setTimeout(() => {
			this.#update({
				phase: 'error',
				error: { code: 'connection', detail: 'The connected tab is not responding. Open that tab.' }
			});
			this.#discovery?.finish();
		}, DELIVERY_TIMEOUT);
		const discovery = {
			promise,
			finish: () => {
				if (this.#discovery !== discovery) return;
				clearTimeout(timer);
				probe.abort();
				this.#discovery = undefined;
				this.#update({ ready: true });
				finish();
			}
		};
		this.#discovery = discovery;
		this.#post({ type: 'hello' });
		try {
			const locks = await this.#locks.query();
			if (!locks.held?.some((lock) => lock.name === this.#name)) discovery.finish();
			else if (this.#discovery === discovery) {
				// The last owner may have closed just before we subscribed, so there
				// may be nobody left to answer hello. Observe the actual lock release.
				void this.#locks
					.request(this.#name, { signal: probe.signal }, () => {})
					.then(
						() => discovery.finish(),
						() => {}
					);
			}
		} catch {
			discovery.finish();
		}
		return promise;
	}

	#claim(): Promise<boolean> {
		const lifetime = this.#lifetime;
		if (!lifetime || lifetime.signal.aborted) return Promise.resolve(false);
		const owner = crypto.randomUUID();
		const hold = () =>
			new Promise<void>((release) => {
				this.#owner = owner;
				this.#release = release;
				this.#replies.clear();
			});
		if (!this.#locks) {
			void hold();
			return Promise.resolve(true);
		}
		const locks = this.#locks;
		return new Promise((resolve, reject) => {
			void locks
				.request(this.#name, { ifAvailable: true }, async (lock) => {
					if (!lock || lifetime.signal.aborted) return resolve(false);
					// A separate session lock lets followers observe owner death without
					// joining the ownership lock's queue or relying on background timers.
					await locks.request(`${this.#name}:${owner}`, { signal: lifetime.signal }, () => {
						if (lifetime.signal.aborted) return resolve(false);
						const held = hold();
						resolve(true);
						return held;
					});
				})
				.catch(reject);
		});
	}

	#waitConnected(): Promise<boolean> {
		const done = () => ['connected', 'printing'].includes(this.#state.phase);
		if (done() || !active(this.#state)) return Promise.resolve(done());
		return new Promise((resolve) => {
			const listener = () => {
				if (done() || !active(this.#state)) {
					this.#listeners.delete(listener);
					resolve(done());
				}
			};
			this.#listeners.add(listener);
		});
	}

	#receive(message: Message): void {
		if (!message || !this.#lifetime || this.#lifetime.signal.aborted) return;
		if (message.type === 'hello') {
			if (this.#release && this.#owner) this.#publish(this.client.state);
		} else if (message.type === 'state') {
			if (this.#release) return;
			if (this.#retired.has(message.owner)) {
				// A terminal snapshot can arrive just after the session-lock observer.
				if (!this.#owner && this.#lastOwner === message.owner && !active(message.state))
					this.#update({ ...message.state, ready: true, connection: null });
				return;
			}
			if (this.#owner && this.#owner !== message.owner) return;
			this.#owner = message.owner;
			this.#update({
				...message.state,
				ready: true,
				connection: active(message.state) ? 'remote' : null
			});
			this.#discovery?.finish();
			if (!active(message.state)) {
				this.#forgetOwner();
			} else if (!this.#watch && this.#locks) {
				const watch = (this.#watch = new AbortController());
				void this.#locks
					.request(`${this.#name}:${message.owner}`, { signal: watch.signal }, () => {
						if (this.#watch !== watch) return;
						this.#update({ ...this.#lostState(), connection: null });
						this.#forgetOwner();
						void this.#discover();
					})
					.catch(() => {}); // Aborted when a terminal snapshot or pagehide already handled it.
			}
		} else if (message.type === 'reply') {
			if (message.to !== this.#peer) return;
			const pending = this.#pending.get(message.id);
			if (!pending || pending.owner !== message.owner) return;
			clearTimeout(pending.timer);
			if (message.status === 'started' && pending.command.action === 'print')
				this.#update({ job: 'printing' });
			if (message.status === 'done' || message.status === 'error') {
				this.#pending.delete(message.id);
				if (message.status === 'done') pending.resolve();
				else pending.reject(new Error(message.error));
			}
		} else if (message.owner === this.#owner && this.#release) {
			if (message.type === 'disconnect') this.client.disconnect();
			else if (message.type === 'request') this.#enqueue(message);
		}
	}

	#request(command: Command): Promise<void> {
		if (!this.#owner || !this.#lifetime || this.#lifetime.signal.aborted)
			return Promise.reject(closed());
		const request: Request = {
			type: 'request',
			owner: this.#owner,
			from: this.#peer,
			id: crypto.randomUUID(),
			expires: Date.now() + DELIVERY_TIMEOUT,
			command
		};
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(request.id);
				reject(new Error('The connected tab did not confirm the job. Check it before retrying.'));
			}, DELIVERY_TIMEOUT);
			this.#pending.set(request.id, { owner: request.owner, command, timer, resolve, reject });
			if (this.#release) this.#enqueue(request);
			else this.#post(request);
		});
	}

	#enqueue(request: Request): void {
		const previous = this.#replies.get(request.id);
		if (previous) {
			this.#sendReply(previous);
			return;
		}
		try {
			// Never execute a command which arrived after its sender stopped waiting.
			if (Date.now() >= request.expires) throw new Error('The queued request expired.');
			if (request.command.action === 'print') a6Raster(request.command.raster);
			else if (request.command.action !== 'refresh') throw new Error('Unknown printer command');
			this.#queue.push(request);
			this.#reply(request, 'accepted');
			void this.#drain();
		} catch (error) {
			this.#reply(request, 'error', String(error));
		}
	}

	async #drain(): Promise<void> {
		const owner = this.#owner;
		if (
			!owner ||
			!this.#release ||
			this.#processing ||
			this.#connecting ||
			this.client.state.phase !== 'connected'
		)
			return;
		this.#processing = owner;
		try {
			while (this.#owner === owner && this.#queue.length) {
				const request = this.#queue.shift()!;
				try {
					if (this.client.state.phase !== 'connected') throw closed();
					this.#reply(request, 'started');
					if (request.command.action === 'print') await this.client.print(request.command.raster);
					else await this.client.refresh();
					if (this.#owner !== owner || this.client.state.phase !== 'connected') throw closed();
					if (request.command.action === 'print' && this.client.state.notice !== 'sent')
						throw closed();
					this.#reply(request, 'done');
				} catch (error) {
					this.#reply(request, 'error', String(error));
				}
			}
		} finally {
			if (this.#processing === owner) this.#processing = undefined;
		}
	}

	#reply(request: Request, status: Reply['status'], error?: string): void {
		const reply: Reply = {
			type: 'reply',
			owner: request.owner,
			to: request.from,
			id: request.id,
			status,
			error
		};
		this.#replies.set(request.id, reply);
		this.#sendReply(reply);
	}

	#sendReply(reply: Reply): void {
		if (reply.to === this.#peer) this.#receive(reply);
		else this.#post(reply);
	}

	#publish(state: PrinterState): void {
		if (!this.#owner) return;
		this.#update({ ...state, ready: true, connection: active(state) ? 'local' : null });
		this.#post({ type: 'state', owner: this.#owner, state });
	}

	#endOwnership(): void {
		for (const request of this.#queue) this.#reply(request, 'error', closed().message);
		this.#queue = [];
		this.#processing = undefined;
		this.#release?.();
		this.#release = undefined;
		this.#forgetOwner();
	}

	#forgetOwner(): void {
		if (this.#owner) {
			this.#retired.add(this.#owner);
			this.#lastOwner = this.#owner;
		}
		this.#owner = undefined;
		this.#watch?.abort();
		this.#watch = undefined;
		this.#rejectPending();
	}

	#rejectPending(): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(closed());
		}
		this.#pending.clear();
	}

	#lostState(): PrinterState {
		const events = this.#state.events;
		return {
			...initialState(),
			phase: 'disconnected',
			notice: 'lost',
			deviceName: this.#state.deviceName,
			events: [
				...events,
				{ id: (events.at(-1)?.id ?? 0) + 1, at: Date.now(), kind: 'lost' as const }
			].slice(-30)
		};
	}

	#post(message: Message): void {
		this.#channel?.postMessage(message);
	}

	#update(patch: Partial<SharedPrinterState>): void {
		this.#state = { ...this.#state, ...patch };
		for (const listener of this.#listeners) listener(this.#state);
	}
}
