import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	PeriPageClient,
	type BluetoothApi,
	type BluetoothCharacteristic,
	type BluetoothDevice,
	type BluetoothGattServer
} from './client';

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
	return { client, api, device, gatt, response, write, status, answers, writes };
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
