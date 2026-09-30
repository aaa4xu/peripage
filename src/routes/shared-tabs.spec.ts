import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';

interface TestPrinter {
	selections: number;
	activated: boolean;
	jobs: number[][];
	autoFinish: boolean;
	finish: () => void;
}

declare global {
	interface Window {
		testPrinter: TestPrinter;
	}
}

// Runs inside each real tab before the application loads. Only BLE is simulated;
// Svelte, user activation, channels, locks, lifecycle events and GATT client are real.
function installBluetooth() {
	class Characteristic extends EventTarget {
		value?: DataView;
		async startNotifications() {
			if (this === status) {
				this.notify([1, 4]);
				this.notify([2, 100, 0]);
			}
			return this;
		}
		notify(bytes: number[] | Uint8Array) {
			this.value = new DataView(Uint8Array.from(bytes).buffer);
			this.dispatchEvent(new Event('characteristicvaluechanged'));
		}
	}
	const response = new Characteristic();
	const status = new Characteristic();
	const encoder = new TextEncoder();
	const answers = new Map<string, Uint8Array>([
		['16,255,80,241', Uint8Array.of(0, 35)],
		['16,255,32,240', encoder.encode('IP-200')],
		['16,255,32,241', encoder.encode('V1.36_203dpi')],
		['16,255,48,16', encoder.encode('v3.38.21_AY')],
		['16,255,48,17', encoder.encode('PeriPage_TEST')],
		['16,255,32,242', encoder.encode('TEST1234567890')],
		['16,255,48,18', Uint8Array.of(1, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5, 6)]
	]);
	const test = (window.testPrinter = {
		selections: 0,
		activated: false,
		jobs: [],
		autoFinish: true,
		finish: () => response.notify([0xaa])
	} as TestPrinter);
	let body: number[] | undefined;
	const write = {
		async writeValueWithoutResponse(bytes: Uint8Array) {
			const key = Array.from(bytes).join(',');
			const answer = answers.get(key);
			if (answer) response.notify(answer);
			else if (key === '16,255,254,69') {
				test.jobs.push(body ?? []);
				body = undefined;
				if (test.autoFinish) test.finish();
			} else if (bytes[0] === 0x1d && bytes[1] === 0x76) body = [];
			else if (body && key !== '27,74,96') body.push(...bytes);
			status.notify([1, 1]);
		}
	};
	const device = Object.assign(new EventTarget(), {
		name: 'PeriPage_TEST_BLE',
		gatt: {
			connected: false,
			async connect() {
				this.connected = true;
				return this;
			},
			disconnect() {
				this.connected = false;
				device.dispatchEvent(new Event('gattserverdisconnected'));
			},
			async getPrimaryService() {
				return {
					async getCharacteristic(uuid: number) {
						return new Map<number, object>([
							[0xff01, response],
							[0xff02, write],
							[0xff03, status]
						]).get(uuid);
					}
				};
			}
		}
	});
	Object.defineProperty(navigator, 'bluetooth', {
		value: {
			async requestDevice() {
				test.selections++;
				test.activated = navigator.userActivation.isActive;
				if (!test.activated) throw new DOMException('A user gesture is required', 'SecurityError');
				return device;
			}
		}
	});
}

let server: ViteDevServer;
let browser: Browser;
let url: string;
const hash = `#template=${encodeURIComponent(JSON.stringify({ version: 1, width: 8, height: 1, layers: [] }))}`;

beforeAll(async () => {
	server = await createServer({
		mode: 'test',
		logLevel: 'error',
		server: { host: '127.0.0.1', port: 0 }
	});
	await server.listen();
	url = server.resolvedUrls!.local[0];
	browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await server?.close();
});

async function tab(context: BrowserContext): Promise<Page> {
	const page = await context.newPage();
	page.setDefaultTimeout(5000);
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto(url + hash);
	await page.getByRole('button', { name: 'Print', exact: true }).waitFor();
	await expect
		.poll(
			async () => ({
				enabled: await page.getByRole('button', { name: 'Print', exact: true }).isEnabled(),
				errors,
				text: await page.locator('body').innerText()
			}),
			{ timeout: 5000 }
		)
		.toMatchObject({ enabled: true, errors: [] });
	return page;
}

it('prints through another tab, queues jobs and survives follower closure in the full UI', async () => {
	const context = await browser.newContext();
	await context.addInitScript(installBluetooth);
	try {
		const owner = await tab(context);
		await owner.evaluate(() => {
			window.testPrinter.autoFinish = false;
		});
		await owner.getByRole('button', { name: 'Print', exact: true }).click();
		await owner.waitForFunction(() => window.testPrinter.jobs.length === 1);
		const follower = await tab(context);
		await follower.getByRole('button', { name: 'Print', exact: true }).click();
		await follower.getByRole('button', { name: 'Waiting for the printer…', exact: true }).waitFor();
		expect(
			await owner.evaluate(() => ({
				selections: window.testPrinter.selections,
				activated: window.testPrinter.activated,
				jobs: window.testPrinter.jobs.length
			}))
		).toEqual({ selections: 1, activated: true, jobs: 1 });
		expect(await follower.evaluate(() => window.testPrinter.selections)).toBe(0);
		await owner.evaluate(() => {
			window.testPrinter.autoFinish = true;
			window.testPrinter.finish();
		});
		await follower.getByRole('status').filter({ hasText: 'Job sent to the printer.' }).waitFor();
		expect(await owner.evaluate(() => window.testPrinter.jobs.map((job) => job.length))).toEqual([
			48, 48
		]);
		await follower.getByText('Connected via another tab', { exact: true }).waitFor();
		await follower.getByRole('link', { name: 'RU', exact: true }).click();
		await follower.getByText('Подключён через другую вкладку', { exact: true }).waitFor();
		expect(await follower.evaluate(() => window.testPrinter.selections)).toBe(0);
		await follower.close();
		const next = await tab(context);
		await next.getByText('Connected via another tab', { exact: true }).waitFor();
		await owner.close();
		await next.getByRole('button', { name: 'Connect printer', exact: true }).waitFor();
		expect(await next.evaluate(() => window.testPrinter.selections)).toBe(0);
		await next.getByRole('button', { name: 'Print', exact: true }).click();
		await next.waitForFunction(() => window.testPrinter.jobs.length === 1);
		expect(await next.evaluate(() => window.testPrinter.activated)).toBe(true);
	} finally {
		await context.close();
	}
}, 20_000);

it('uses one chooser when two real tabs print for the first time together', async () => {
	const context = await browser.newContext();
	await context.addInitScript(installBluetooth);
	try {
		const a = await tab(context),
			b = await tab(context);
		await Promise.all(
			[a, b].map((page) => page.getByRole('button', { name: 'Print', exact: true }).click())
		);
		await Promise.all(
			[a, b].map((page) =>
				page.getByRole('status').filter({ hasText: 'Job sent to the printer.' }).waitFor()
			)
		);
		const states = await Promise.all(
			[a, b].map((page) =>
				page.evaluate(() => ({
					selections: window.testPrinter.selections,
					jobs: window.testPrinter.jobs.length
				}))
			)
		);
		expect(states.reduce((sum, state) => sum + state.selections, 0)).toBe(1);
		expect(states.reduce((sum, state) => sum + state.jobs, 0)).toBe(2);
	} finally {
		await context.close();
	}
}, 20_000);
