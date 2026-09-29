import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	PeriPageClient,
	type BluetoothApi,
	type BluetoothCharacteristic,
	type BluetoothDevice,
	type BluetoothGattServer
} from './index.js';

class Characteristic extends EventTarget implements BluetoothCharacteristic {
	value?: DataView;
	startNotifications = vi.fn(async () => this);
	writeValueWithoutResponse = vi
		.fn<(bytes: Uint8Array<ArrayBuffer>) => Promise<void>>()
		.mockResolvedValue(undefined);

	notify(bytes: Uint8Array) {
		// Notifications may expose a view into a larger buffer, not its entire contents.
		const padded = Uint8Array.of(0xff, ...bytes, 0xff);
		this.value = new DataView(padded.buffer, 1, bytes.length);
		this.dispatchEvent(new Event('characteristicvaluechanged'));
	}
}

function fixture() {
	const response = new Characteristic();
	const write = new Characteristic();
	const status = new Characteristic();
	const flow = { returnCredits: true, initialCredits: 4, complete: true };
	status.startNotifications.mockImplementation(async () => {
		status.notify(Uint8Array.of(1, flow.initialCredits));
		status.notify(Uint8Array.of(2, 100, 0));
		return status;
	});
	const encoder = new TextEncoder();
	const answers = new Map<string, Uint8Array>([
		['10 ff 50 f1', Uint8Array.of(0, 35)],
		['10 ff 20 f0', encoder.encode('IP-200')],
		['10 ff 20 f1', encoder.encode('V1.36_203dpi')],
		['10 ff 30 10', encoder.encode('v3.38.21_AY')],
		['10 ff 30 11', encoder.encode('PeriPage_TEST')],
		['10 ff 20 f2', encoder.encode('TEST1234567890')],
		['10 ff 30 12', Uint8Array.of(1, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5, 6)]
	]);
	const writes: string[] = [];
	write.writeValueWithoutResponse.mockImplementation(async (bytes) => {
		const command = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(' ');
		writes.push(command);
		const answer = answers.get(command);
		if (answer) queueMicrotask(() => response.notify(answer));
		if (flow.returnCredits) queueMicrotask(() => status.notify(Uint8Array.of(1, 1)));
		if (flow.complete && command === '10 ff fe 45') {
			queueMicrotask(() => response.notify(Uint8Array.of(0xaa)));
		}
	});
	const service = {
		getCharacteristic: vi.fn(async (uuid: number) => {
			const characteristic = new Map([
				[0xff01, response],
				[0xff02, write],
				[0xff03, status]
			]).get(uuid);
			if (!characteristic) throw new Error('Unexpected characteristic');
			return characteristic;
		})
	};
	const gatt: BluetoothGattServer = {
		connected: false,
		connect: vi.fn(async () => {
			Object.assign(gatt, { connected: true });
			return gatt;
		}),
		disconnect: vi.fn(() => {
			if (gatt.connected) {
				Object.assign(gatt, { connected: false });
				device.dispatchEvent(new Event('gattserverdisconnected'));
			}
		}),
		getPrimaryService: vi.fn(async (uuid: number) => {
			if (uuid !== 0xff00) throw new Error('Unexpected service');
			return service;
		})
	};
	const device: BluetoothDevice = Object.assign(new EventTarget(), {
		name: 'PeriPage_TEST_BLE',
		gatt
	});
	const api: BluetoothApi = { requestDevice: vi.fn(async () => device) };
	const client = new PeriPageClient(() => api);
	return { client, api, device, gatt, response, write, status, answers, writes, flow };
}

async function connect(client: PeriPageClient) {
	const operation = client.connect();
	await vi.runAllTimersAsync();
	await operation;
}

describe('PeriPage connection lifecycle', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('requests the chooser immediately and reads verified A6 replies without print commands', async () => {
		const f = fixture();
		const operation = f.client.connect();
		expect(f.api.requestDevice).toHaveBeenCalledExactlyOnceWith({
			filters: [{ namePrefix: 'PeriPage' }],
			optionalServices: [0xff00]
		});
		await vi.runAllTimersAsync();
		await operation;
		expect(f.client.state.phase).toBe('connected');
		expect(f.client.state.info).toEqual({
			battery: 35,
			model: 'IP-200',
			firmware: 'V1.36_203dpi',
			hardware: 'v3.38.21_AY',
			name: 'PeriPage_TEST',
			serial: 'TEST1234567890',
			mac: '01:02:03:04:05:06'
		});
		expect(f.writes[0]).toBe('10 ff fe 01 00 00 00 00 00 00 00 00 00 00 00 00');
		expect(f.writes.slice(1)).toEqual([...f.answers.keys()]);
		expect(f.response.startNotifications).toHaveBeenCalledOnce();
		expect(f.status.startNotifications).toHaveBeenCalledOnce();
		f.client.dispose();
	});

	it('connects and refreshes when the browser misses the initial FF03 notifications', async () => {
		const f = fixture();
		f.status.startNotifications.mockResolvedValue(f.status);
		await connect(f.client);
		expect(f.client.state).toMatchObject({
			phase: 'connected',
			info: { model: 'IP-200', firmware: 'V1.36_203dpi' }
		});
		expect(f.writes).toHaveLength(8);
		const refresh = f.client.refresh();
		await vi.runAllTimersAsync();
		await refresh;
		expect(f.client.state.phase).toBe('connected');
		expect(f.writes).toHaveLength(15);
		f.client.dispose();
	});

	it('only bootstraps initialization if no credits ever arrive', async () => {
		const f = fixture();
		f.status.startNotifications.mockResolvedValue(f.status);
		f.flow.returnCredits = false;
		await connect(f.client);
		expect(f.writes).toEqual(['10 ff fe 01 00 00 00 00 00 00 00 00 00 00 00 00']);
		expect(f.client.state).toMatchObject({ phase: 'error', error: { code: 'timeout' } });
		expect(f.gatt.connected).toBe(false);
	});

	it('clears live information on manual disconnect and can reconnect', async () => {
		const f = fixture();
		await connect(f.client);
		f.client.disconnect();
		expect(f.gatt.connected).toBe(false);
		expect(f.client.state).toMatchObject({
			phase: 'disconnected',
			notice: 'user',
			updatedAt: null,
			info: { battery: null, model: null }
		});
		await connect(f.client);
		expect(f.client.state).toMatchObject({
			phase: 'connected',
			notice: null,
			error: null,
			info: { battery: 35 }
		});
		expect(f.writes).toHaveLength(16);
		f.client.dispose();
	});

	it('distinguishes unexpected connection loss from manual disconnect', async () => {
		const f = fixture();
		await connect(f.client);
		f.gatt.disconnect();
		expect(f.client.state).toMatchObject({
			phase: 'disconnected',
			notice: 'lost',
			updatedAt: null,
			info: { battery: null },
			error: null
		});
		expect(f.client.state.events.at(-1)?.kind).toBe('lost');
	});

	it.each(['manual', 'unexpected'] as const)(
		'ignores late replies after %s disconnection during a query',
		async (kind) => {
			const f = fixture();
			f.answers.delete('10 ff 50 f1');
			const operation = f.client.connect();
			await vi.advanceTimersByTimeAsync(160);
			expect(f.client.state.phase).toBe('reading');
			if (kind === 'manual') f.client.disconnect();
			else f.gatt.disconnect();
			f.response.notify(Uint8Array.of(0, 95));
			await vi.runAllTimersAsync();
			await operation;
			expect(f.client.state).toMatchObject({
				phase: 'disconnected',
				notice: kind === 'manual' ? 'user' : 'lost',
				info: { battery: null },
				error: null
			});
			expect(f.writes).toHaveLength(2);
		}
	);

	it('treats cancellation in the device chooser as a normal outcome', async () => {
		const f = fixture();
		vi.mocked(f.api.requestDevice).mockRejectedValue(
			new DOMException('Cancelled', 'NotFoundError')
		);
		await f.client.connect();
		expect(f.client.state).toMatchObject({ phase: 'idle', notice: 'cancelled', error: null });
		expect(f.gatt.connect).not.toHaveBeenCalled();
	});

	it('reports permission rejection and allows another attempt', async () => {
		const f = fixture();
		vi.mocked(f.api.requestDevice).mockRejectedValueOnce(
			new DOMException('Denied', 'NotAllowedError')
		);
		await f.client.connect();
		expect(f.client.state).toMatchObject({ phase: 'error', error: { code: 'permission' } });
		await connect(f.client);
		expect(f.client.state.phase).toBe('connected');
		f.client.dispose();
	});

	it('does not let a cancelled chooser overwrite a newer connection', async () => {
		const f = fixture();
		const old = fixture();
		let select!: (device: BluetoothDevice) => void;
		vi.mocked(f.api.requestDevice).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					select = resolve;
				})
		);
		const oldAttempt = f.client.connect();
		f.client.disconnect();
		expect(f.client.state).toMatchObject({ phase: 'idle', notice: 'cancelled', error: null });
		await connect(f.client);
		select(old.device);
		await oldAttempt;
		expect(old.gatt.connect).not.toHaveBeenCalled();
		expect(f.client.state.phase).toBe('connected');
		expect(f.gatt.connected).toBe(true);
		f.client.dispose();
	});

	it('disconnects a GATT connection that resolves after the connection timeout', async () => {
		const f = fixture();
		let complete!: () => void;
		vi.mocked(f.gatt.connect).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					complete = () => {
						Object.assign(f.gatt, { connected: true });
						resolve(f.gatt);
					};
				})
		);
		const operation = f.client.connect();
		await vi.runAllTimersAsync();
		await operation;
		expect(f.client.state).toMatchObject({ phase: 'error', error: { code: 'timeout' } });
		complete();
		await Promise.resolve();
		expect(f.gatt.connected).toBe(false);
		expect(f.client.state.phase).toBe('error');
	});

	it('stops on a missing untagged reply so late data cannot be assigned to the next field', async () => {
		const f = fixture();
		f.answers.delete('10 ff 50 f1');
		await connect(f.client);
		expect(f.client.state).toMatchObject({ phase: 'error', error: { code: 'timeout' } });
		expect(f.writes).toHaveLength(2);
		expect(f.gatt.connected).toBe(false);
		f.response.notify(Uint8Array.of(0, 50));
		expect(f.client.state.info.battery).toBeNull();
	});

	it('rejects malformed battery data instead of presenting a fabricated percentage', async () => {
		const f = fixture();
		f.answers.set('10 ff 50 f1', Uint8Array.of(0, 255));
		await connect(f.client);
		expect(f.client.state).toMatchObject({
			phase: 'error',
			error: { code: 'response' },
			info: { battery: null }
		});
		expect(f.gatt.connected).toBe(false);
	});

	it('serializes refresh requests and ignores repeated connect clicks', async () => {
		const f = fixture();
		const first = f.client.connect();
		await f.client.connect();
		await vi.runAllTimersAsync();
		await first;
		f.answers.set('10 ff 50 f1', Uint8Array.of(0, 72));
		const refresh = f.client.refresh();
		await f.client.refresh();
		await vi.runAllTimersAsync();
		await refresh;
		expect(f.api.requestDevice).toHaveBeenCalledOnce();
		expect(f.writes).toHaveLength(15);
		expect(f.client.state.info.battery).toBe(72);
		expect(f.client.state.events.at(-1)?.kind).toBe('refreshed');
		f.client.dispose();
	});

	it('releases pending work and listeners on component disposal', async () => {
		const f = fixture();
		f.answers.delete('10 ff 50 f1');
		const listener = vi.fn();
		f.client.subscribe(listener);
		const operation = f.client.connect();
		await vi.advanceTimersByTimeAsync(160);
		f.client.dispose();
		listener.mockClear();
		f.response.notify(Uint8Array.of(0, 35));
		await vi.runAllTimersAsync();
		await operation;
		expect(listener).not.toHaveBeenCalled();
		expect(f.gatt.connected).toBe(false);
	});

	it('handles a synchronously failing write without an unhandled reply promise', async () => {
		const f = fixture();
		f.write.writeValueWithoutResponse.mockImplementation(async () => {});
		f.write.writeValueWithoutResponse.mockImplementationOnce(async () => {});
		f.write.writeValueWithoutResponse.mockImplementationOnce(() => {
			throw new Error('Write failed');
		});
		await connect(f.client);
		expect(f.client.state).toMatchObject({ phase: 'error', error: { code: 'connection' } });
		expect(f.gatt.connected).toBe(false);
	});
});

describe('credit-controlled raster printing', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it.each([true, false])(
		'connects and prints once with initial FF03 delivery: %s',
		async (initialGrant) => {
			const f = fixture();
			if (!initialGrant) f.status.startNotifications.mockResolvedValue(f.status);
			const image = { width: 8, height: 1, data: Uint8Array.of(0x80) };
			const job = f.client.print(image);
			expect(f.api.requestDevice).toHaveBeenCalledOnce();
			expect(f.client.state.phase).toBe('choosing');
			image.data[0] = 0; // The pending job keeps the image captured at the click.
			await f.client.print(image);
			await vi.runAllTimersAsync();
			await job;
			expect(f.writes.filter((value) => value === '10 ff fe 45')).toHaveLength(1);
			expect(f.write.writeValueWithoutResponse.mock.calls.map(([bytes]) => bytes)).toContainEqual(
				Uint8Array.of(0x80, ...new Uint8Array(47))
			);
			expect(f.client.state).toMatchObject({ phase: 'connected', notice: 'sent' });
			f.client.dispose();
		}
	);

	it('does not print after cancelling or failing the connection', async () => {
		const f = fixture();
		vi.mocked(f.api.requestDevice).mockRejectedValueOnce(
			new DOMException('Cancelled', 'NotFoundError')
		);
		await f.client.print({ width: 8, height: 1, data: Uint8Array.of(0) });
		expect(f.client.state.notice).toBe('cancelled');
		expect(f.writes).toEqual([]);
		f.answers.delete('10 ff 50 f1');
		const job = f.client.print({ width: 8, height: 1, data: Uint8Array.of(0) });
		await vi.runAllTimersAsync();
		await job;
		expect(f.client.state.phase).toBe('error');
		expect(f.writes.some((value) => value.startsWith('1d 76'))).toBe(false);
	});

	it('does not carry a cancelled print request over to a newer connection', async () => {
		const f = fixture();
		let select!: (device: BluetoothDevice) => void;
		vi.mocked(f.api.requestDevice).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					select = resolve;
				})
		);
		const job = f.client.print({ width: 8, height: 1, data: Uint8Array.of(0) });
		f.client.disconnect();
		await connect(f.client);
		select(f.device);
		await job;
		expect(f.client.state.phase).toBe('connected');
		expect(f.writes.some((value) => value.startsWith('1d 76'))).toBe(false);
		f.client.dispose();
	});

	it('sends the raw raster, automatic feed and end marker in order and allows a second job', async () => {
		const f = fixture();
		await connect(f.client);
		const source = Uint8Array.of(0x80, 0xff, 0x01, 0x00);
		const before = f.write.writeValueWithoutResponse.mock.calls.length;
		const job = f.client.print({ width: 9, height: 2, data: source });
		expect(f.client.state.phase).toBe('printing');
		await f.client.refresh();
		await f.client.print({ width: 1, height: 1, data: Uint8Array.of(0) });
		await vi.runAllTimersAsync();
		await job;
		const writes = f.write.writeValueWithoutResponse.mock.calls
			.slice(before)
			.map(([bytes]) => bytes);
		const body = new Uint8Array(96);
		body.set([0x80, 0x80]);
		body[48] = 1;
		expect(Uint8Array.from(writes.flatMap((bytes) => [...bytes]))).toEqual(
			Uint8Array.of(
				0x10,
				0xff,
				0xfe,
				1,
				...new Uint8Array(12),
				0x1d,
				0x76,
				0x30,
				0,
				48,
				0,
				2,
				0,
				...body,
				0x1b,
				0x4a,
				96,
				0x10,
				0xff,
				0xfe,
				0x45
			)
		);
		expect(Math.max(...writes.map((bytes) => bytes.length))).toBe(96);
		expect(source).toEqual(Uint8Array.of(0x80, 0xff, 1, 0));
		expect(f.client.state).toMatchObject({ phase: 'connected', notice: 'sent' });
		const next = f.client.print({ width: 1, height: 1, data: Uint8Array.of(0x80) });
		await vi.runAllTimersAsync();
		await next;
		expect(f.client.state).toMatchObject({ phase: 'connected', notice: 'sent' });
		f.client.dispose();
	});

	it('honors an explicit zero grant even before initialization', async () => {
		const f = fixture();
		f.flow.initialCredits = 0;
		await connect(f.client);
		expect(f.writes).toEqual([]);
		expect(f.client.state).toMatchObject({ phase: 'error', error: { code: 'timeout' } });
	});

	it('pauses on zero grants, spends one credit per write and resumes with additive grants', async () => {
		const f = fixture();
		await connect(f.client);
		f.flow.returnCredits = false;
		f.status.notify(Uint8Array.of(1, 0));
		const count = f.writes.length;
		const job = f.client.print({ width: 384, height: 10, data: new Uint8Array(480) });
		await vi.advanceTimersByTimeAsync(60);
		expect(f.writes).toHaveLength(count);
		f.status.notify(Uint8Array.of(1, 1));
		await vi.advanceTimersByTimeAsync(60);
		expect(f.writes).toHaveLength(count + 5); // Four unspent initial credits + one new credit.
		expect(f.client.state.phase).toBe('printing');
		f.status.notify(Uint8Array.of(1, 5));
		await vi.runAllTimersAsync();
		await job;
		expect(f.writes).toHaveLength(count + 10);
		expect(f.client.state.notice).toBe('sent');
		f.client.dispose();
	});

	it.each(['normal', 'missing', 'late'] as const)(
		'prints 384 by 192 within six seconds with 200 ms refills and %s startup notifications',
		async (startup) => {
			const f = fixture();
			if (startup !== 'normal') f.status.startNotifications.mockResolvedValue(f.status);
			const write = f.write.writeValueWithoutResponse.getMockImplementation()!;
			if (startup === 'late') {
				f.write.writeValueWithoutResponse.mockImplementationOnce(async (bytes) => {
					f.status.notify(Uint8Array.of(1, 4));
					f.status.notify(Uint8Array.of(2, 100, 0));
					await write(bytes);
				});
			}
			await connect(f.client);
			// Refresh must not restore the startup window a second time.
			const refresh = f.client.refresh();
			await vi.runAllTimersAsync();
			await refresh;
			f.flow.returnCredits = false;
			let inFlight = 0;
			let peakInFlight = 0;
			f.write.writeValueWithoutResponse.mockImplementation(async (bytes) => {
				inFlight++;
				peakInFlight = Math.max(peakInFlight, inFlight);
				setTimeout(() => {
					inFlight--;
					f.status.notify(Uint8Array.of(1, 1));
				}, 200);
				await write(bytes);
			});
			const before = f.writes.length;
			const job = f.client.print({ width: 384, height: 192, data: new Uint8Array(9216) });
			await vi.advanceTimersByTimeAsync(6000);
			expect(f.client.state).toMatchObject({ phase: 'connected', notice: 'sent' });
			expect(peakInFlight).toBe(4);
			expect(f.writes.length - before).toBe(98);
			await job;
			f.client.dispose();
		}
	);

	it('does not replace an observed one-credit window with the profile fallback', async () => {
		const f = fixture();
		f.flow.initialCredits = 1;
		await connect(f.client);
		f.flow.returnCredits = false;
		const before = f.writes.length;
		const job = f.client.print({ width: 384, height: 1, data: new Uint8Array(48) });
		await vi.advanceTimersByTimeAsync(100);
		expect(f.writes.length - before).toBe(1);
		f.client.disconnect();
		await job;
	});

	it('does not assume the A6 startup window for an unknown firmware', async () => {
		const f = fixture();
		f.status.startNotifications.mockResolvedValue(f.status);
		f.answers.set('10 ff 20 f1', new TextEncoder().encode('OtherFirmware'));
		await connect(f.client);
		f.flow.returnCredits = false;
		const before = f.writes.length;
		const refresh = f.client.refresh();
		await vi.advanceTimersByTimeAsync(100);
		expect(f.writes.length - before).toBe(1);
		f.client.disconnect();
		await refresh;
	});

	it('honors a smaller printer packet limit', async () => {
		const f = fixture();
		await connect(f.client);
		f.status.notify(Uint8Array.of(2, 8, 0));
		const count = f.write.writeValueWithoutResponse.mock.calls.length;
		const job = f.client.print({ width: 384, height: 1, data: new Uint8Array(48) });
		await vi.runAllTimersAsync();
		await job;
		expect(
			f.write.writeValueWithoutResponse.mock.calls
				.slice(count)
				.every(([bytes]) => bytes.length <= 8)
		).toBe(true);
		expect(f.client.state.notice).toBe('sent');
		f.client.dispose();
	});

	it('does not accept a completion byte before the end marker or retry an uncertain job', async () => {
		const f = fixture();
		await connect(f.client);
		f.flow.complete = false;
		const job = f.client.print({ width: 8, height: 1, data: Uint8Array.of(0) });
		f.response.notify(Uint8Array.of(0xaa));
		await vi.runAllTimersAsync();
		await job;
		expect(f.client.state).toMatchObject({ phase: 'error', error: { code: 'timeout' } });
		expect(f.writes.filter((bytes) => bytes === '10 ff fe 45')).toHaveLength(1);
		expect(f.gatt.connected).toBe(false);
	});

	it('stops writes when disconnected while waiting for credit and resets credit on reconnect', async () => {
		const f = fixture();
		await connect(f.client);
		f.status.notify(Uint8Array.of(1, 0));
		const count = f.writes.length;
		const job = f.client.print({ width: 8, height: 1, data: Uint8Array.of(0xff) });
		f.client.disconnect();
		f.status.notify(Uint8Array.of(1, 20));
		await vi.runAllTimersAsync();
		await job;
		expect(f.writes).toHaveLength(count);
		expect(f.client.state).toMatchObject({ phase: 'disconnected', notice: 'user' });
		f.flow.initialCredits = 0;
		await connect(f.client);
		expect(f.writes).toHaveLength(count);
		expect(f.client.state.phase).toBe('error');
	});

	it('rejects invalid images and unknown printer profiles before sending print data', async () => {
		const f = fixture();
		await connect(f.client);
		const count = f.writes.length;
		await expect(
			f.client.print({ width: 385, height: 1, data: new Uint8Array(49) })
		).rejects.toThrow('Invalid raster');
		await expect(
			f.client.print({ width: 384, height: 1, data: new Uint8Array(47) })
		).rejects.toThrow('Invalid raster');
		expect(f.writes).toHaveLength(count);
		expect(f.client.state.phase).toBe('connected');
		f.client.disconnect();
		f.answers.set('10 ff 20 f1', new TextEncoder().encode('OtherFirmware'));
		await connect(f.client);
		const afterReconnect = f.writes.length;
		await expect(f.client.print({ width: 8, height: 1, data: Uint8Array.of(0) })).rejects.toThrow(
			'Unsupported printer'
		);
		expect(f.writes).toHaveLength(afterReconnect);
		f.client.dispose();
	});
});
