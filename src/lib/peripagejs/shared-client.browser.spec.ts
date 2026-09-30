import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialState, type PrinterState } from './client.js';
import { SharedPeriPageClient } from './shared-client.js';
import type { Raster } from './raster.js';

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((yes) => (resolve = yes));
	return { promise, resolve };
}

class Printer {
	state = initialState();
	listeners = new Set<(state: PrinterState) => void>();
	gate?: ReturnType<typeof deferred>;
	log: string[] = [];
	connect = vi.fn(async () => {
		this.update({ phase: 'choosing' });
		this.update({
			phase: 'connected',
			deviceName: 'PeriPage_TEST',
			notice: null,
			info: { ...initialState().info, model: 'IP-200', firmware: 'V1.36_203dpi', battery: 35 }
		});
		return this.state.phase === 'connected';
	});
	print = vi.fn(async (raster: Raster) => {
		this.log.push(`print:${raster.data[0]}`);
		this.update({ phase: 'printing', notice: null });
		await this.gate?.promise;
		if (this.state.phase !== 'printing') return;
		this.log.push('sent');
		this.update({ phase: 'connected', notice: 'sent' });
	});
	refresh = vi.fn(async () => {
		this.log.push('refresh');
		this.update({ phase: 'connected', info: { ...this.state.info, battery: 80 } });
	});
	disconnect = vi.fn(() =>
		this.update({ ...initialState(), phase: 'disconnected', notice: 'user' })
	);
	dispose = vi.fn(() => {
		this.state = initialState();
		this.listeners.clear();
	});
	subscribe(listener: (state: PrinterState) => void) {
		this.listeners.add(listener);
		listener(this.state);
		return () => this.listeners.delete(listener);
	}
	update(patch: Partial<PrinterState>) {
		this.state = { ...this.state, ...patch };
		for (const listener of this.listeners) listener(this.state);
	}
}

const clients: SharedPeriPageClient[] = [];
const channels: BroadcastChannel[] = [];
const raster = (byte = 0x81): Raster => ({ width: 8, height: 1, data: Uint8Array.of(byte) });

async function tab(scope: string, printer = new Printer()) {
	const client = new SharedPeriPageClient(scope, printer);
	clients.push(client);
	client.start();
	await expect.poll(() => client.state.ready).toBe(true);
	return { client, printer };
}

function observe(scope: string) {
	const channel = new BroadcastChannel(`peripagejs:${scope}:printer:v1`);
	channels.push(channel);
	const messages: { type: string; owner?: string; status?: string; id?: string }[] = [];
	channel.onmessage = (event) => messages.push(event.data);
	return { channel, messages };
}

afterEach(() => {
	for (const client of clients.splice(0)) client.dispose();
	for (const channel of channels.splice(0)) channel.close();
});

describe('shared printer with real browser channels and locks', () => {
	it('discovers an existing connection, prints and refreshes without another chooser', async () => {
		const scope = crypto.randomUUID();
		const owner = await tab(scope);
		await owner.client.connect();
		expect(owner.client.state.error).toBeNull();
		const follower = await tab(scope);
		expect(follower.client.state).toMatchObject({
			phase: 'connected',
			connection: 'remote',
			info: { battery: 35 }
		});
		await follower.client.print(raster());
		await follower.client.refresh();
		expect(owner.printer.print).toHaveBeenCalledExactlyOnceWith(raster());
		expect(owner.printer.refresh).toHaveBeenCalledOnce();
		expect(follower.printer.connect).not.toHaveBeenCalled();
		expect(follower.printer.print).not.toHaveBeenCalled();
		expect(follower.client.state).toMatchObject({ job: 'sent', info: { battery: 80 } });
		expect(owner.client.state.job).toBe('idle');
	});

	it('opens only one chooser for simultaneous connection requests', async () => {
		const scope = crypto.randomUUID();
		const a = await tab(scope);
		const b = await tab(scope);
		expect(await Promise.all([a.client.connect(), b.client.connect()])).toEqual([true, true]);
		expect(a.printer.connect.mock.calls.length + b.printer.connect.mock.calls.length).toBe(1);
		expect([a.client.state.connection, b.client.state.connection].sort()).toEqual([
			'local',
			'remote'
		]);
	});

	it('serializes jobs and refreshes, snapshots queued rasters and ignores repeated clicks', async () => {
		const scope = crypto.randomUUID();
		const owner = await tab(scope);
		await owner.client.connect();
		const follower = await tab(scope);
		const observer = observe(scope);
		owner.printer.gate = deferred();
		const first = owner.client.print(raster(1));
		await expect.poll(() => owner.client.state.job).toBe('printing');
		const image = raster(2);
		const second = follower.client.print(image);
		image.data[0] = 99;
		await follower.client.print(raster(3));
		const refresh = follower.client.refresh();
		await expect
			.poll(() => observer.messages.filter((m) => m.status === 'accepted').length)
			.toBe(2);
		expect(follower.client.state.job).toBe('queued');
		expect(owner.printer.log).toEqual(['print:1']);
		owner.printer.gate.resolve();
		await Promise.all([first, second, refresh]);
		expect(owner.printer.log).toEqual(['print:1', 'sent', 'print:2', 'sent', 'refresh']);
		expect(follower.client.state.job).toBe('sent');
	});

	it('queues concurrent first prints behind one chooser and completes connection before sending', async () => {
		const scope = crypto.randomUUID();
		const owner = await tab(scope);
		const follower = await tab(scope);
		const selection = deferred();
		const connect = owner.printer.connect.getMockImplementation()!;
		owner.printer.connect.mockImplementationOnce(async () => {
			owner.printer.update({ phase: 'choosing' });
			await selection.promise;
			return connect();
		});
		const first = owner.client.print(raster(1));
		await expect.poll(() => follower.client.state.phase).toBe('choosing');
		const second = follower.client.print(raster(2));
		selection.resolve();
		await Promise.all([first, second]);
		expect(owner.printer.connect).toHaveBeenCalledOnce();
		expect(follower.printer.connect).not.toHaveBeenCalled();
		expect(owner.printer.print).toHaveBeenCalledTimes(2);
		expect(owner.client.state.job).toBe('sent');
		expect(follower.client.state.job).toBe('sent');
	});

	it('detaches a closing follower without disconnecting and discovers again on page restore', async () => {
		const scope = crypto.randomUUID();
		const owner = await tab(scope);
		await owner.client.connect();
		const follower = await tab(scope);
		follower.client.stop();
		expect(owner.client.state.phase).toBe('connected');
		expect(owner.printer.disconnect).not.toHaveBeenCalled();
		follower.client.start();
		await expect.poll(() => follower.client.state.connection).toBe('remote');
		await follower.client.print(raster());
		expect(owner.printer.print).toHaveBeenCalledOnce();
		expect(follower.printer.connect).not.toHaveBeenCalled();
	});

	it('drops active and queued jobs when the owner closes, without reprinting after reconnect', async () => {
		const scope = crypto.randomUUID();
		const owner = await tab(scope);
		await owner.client.connect();
		const a = await tab(scope);
		const b = await tab(scope);
		owner.printer.gate = deferred();
		const first = a.client.print(raster(1)).catch((error: Error) => error);
		await expect.poll(() => a.client.state.job).toBe('printing');
		const second = b.client.print(raster(2)).catch((error: Error) => error);
		owner.client.stop();
		expect(await first).toBeInstanceOf(Error);
		expect(await second).toBeInstanceOf(Error);
		expect(a.client.state).toMatchObject({
			phase: 'disconnected',
			notice: 'lost',
			info: { model: null }
		});
		expect(b.printer.connect).not.toHaveBeenCalled();
		owner.printer.gate.resolve();
		expect(await b.client.connect()).toBe(true);
		expect(b.printer.print).not.toHaveBeenCalled();
		expect(owner.printer.print).toHaveBeenCalledTimes(1);
	});

	it('disconnects all tabs on explicit disconnect and propagates physical connection loss', async () => {
		const scope = crypto.randomUUID();
		const owner = await tab(scope);
		await owner.client.connect();
		const follower = await tab(scope);
		follower.client.disconnect();
		await expect.poll(() => follower.client.state.notice).toBe('user');
		expect(owner.printer.disconnect).toHaveBeenCalledOnce();
		expect(follower.client.state.info.model).toBeNull();
		await owner.client.connect();
		await expect.poll(() => follower.client.state.connection).toBe('remote');
		owner.printer.update({ ...initialState(), phase: 'disconnected', notice: 'lost' });
		await expect.poll(() => follower.client.state.notice).toBe('lost');
		expect(follower.printer.connect).not.toHaveBeenCalled();
	});

	it('releases a cancelled chooser and cancels ownership acquisition on pagehide', async () => {
		const scope = crypto.randomUUID();
		const cancelled = await tab(scope);
		cancelled.printer.connect.mockImplementationOnce(async () => {
			cancelled.printer.update({ ...initialState(), notice: 'cancelled' });
			return false;
		});
		expect(await cancelled.client.connect()).toBe(false);
		const next = await tab(scope);
		expect(await next.client.connect()).toBe(true);
		next.client.stop();
		const last = await tab(scope);
		const connecting = last.client.connect();
		last.client.stop();
		expect(await connecting).toBe(false);
		expect(last.printer.connect).not.toHaveBeenCalled();
	});

	it('rejects expired deliveries and deduplicates a delivered job by its ID', async () => {
		const scope = crypto.randomUUID();
		const observer = observe(scope);
		const owner = await tab(scope);
		await owner.client.connect();
		await expect.poll(() => observer.messages.some((m) => m.type === 'state')).toBe(true);
		const token = observer.messages.find((m) => m.type === 'state')!.owner;
		const request = {
			type: 'request',
			owner: token,
			from: 'test',
			id: 'expired',
			expires: Date.now() - 1,
			command: { action: 'print', raster: raster() }
		};
		observer.channel.postMessage(request);
		await expect
			.poll(() => observer.messages.find((m) => m.id === 'expired')?.status)
			.toBe('error');
		expect(owner.printer.print).not.toHaveBeenCalled();
		request.id = 'one-job';
		request.expires = Date.now() + 10_000;
		observer.channel.postMessage(request);
		await expect
			.poll(() => observer.messages.filter((m) => m.id === 'one-job' && m.status === 'done').length)
			.toBe(1);
		observer.channel.postMessage(request);
		await expect
			.poll(() => observer.messages.filter((m) => m.id === 'one-job' && m.status === 'done').length)
			.toBe(2);
		expect(owner.printer.print).toHaveBeenCalledOnce();
	});

	it('detects a vanished owner through its lock, even without a goodbye message', async () => {
		const scope = crypto.randomUUID();
		const name = `peripagejs:${scope}:printer:v1`;
		const token = crypto.randomUUID();
		const held = deferred(),
			release = deferred();
		const lock = navigator.locks.request(name, () =>
			navigator.locks.request(`${name}:${token}`, async () => {
				held.resolve();
				await release.promise;
			})
		);
		await held.promise;
		const observer = observe(scope);
		observer.channel.onmessage = (event) => {
			if (event.data.type === 'hello')
				observer.channel.postMessage({
					type: 'state',
					owner: token,
					state: { ...initialState(), phase: 'connected' }
				});
		};
		try {
			const follower = await tab(scope);
			expect(follower.client.state.connection).toBe('remote');
			const pending = follower.client.print(raster()).catch((error: Error) => error);
			observer.channel.onmessage = null;
			release.resolve();
			await lock;
			expect(await pending).toBeInstanceOf(Error);
			await expect.poll(() => follower.client.state.notice).toBe('lost');
			expect(follower.printer.connect).not.toHaveBeenCalled();
		} finally {
			release.resolve();
			await lock;
		}
	});

	it('isolates different deployment paths on the same origin', async () => {
		const a = await tab(crypto.randomUUID());
		await a.client.connect();
		const b = await tab(crypto.randomUUID());
		expect(b.client.state.connection).toBeNull();
		expect(await b.client.connect()).toBe(true);
		expect(a.printer.connect).toHaveBeenCalledOnce();
		expect(b.printer.connect).toHaveBeenCalledOnce();
	});
});
