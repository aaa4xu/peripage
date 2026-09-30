import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { replaceState } from '$app/navigation';
import Page from './+page.svelte';
import { browserBluetooth, SharedPeriPageClient, type Raster } from '$lib/peripagejs';
import { renderTemplate } from '$lib/label/render';
import {
	decodeTemplateHash,
	encodeTemplateHash,
	parseTemplate,
	TemplateError
} from '$lib/label/template';
import { exampleTemplate } from '$lib/label/example';
import resistors from '$lib/label/resistors.json';

vi.mock('$app/navigation', () => ({
	afterNavigate: () => {},
	replaceState: vi.fn((url: string | URL) => history.replaceState(history.state, '', url))
}));
vi.mock('$app/state', () => ({ page: { url: new URL('https://localhost/'), state: {} } }));
vi.mock('$lib/label/render', () => ({ renderTemplate: vi.fn() }));
vi.mock('$lib/peripagejs', { spy: true });

const ready: Raster = { width: 8, height: 1, data: Uint8Array.of(0x81) };
const hash = (width = 8) => encodeTemplateHash({ version: 1, width, height: 1, layers: [] });

function changeHash(value: string) {
	history.replaceState(null, '', value || location.pathname);
	window.dispatchEvent(new HashChangeEvent('hashchange'));
}

function deferred() {
	let resolve!: (value: Raster) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<Raster>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

beforeEach(() => {
	vi.mocked(renderTemplate).mockReset();
	vi.mocked(browserBluetooth).mockReturnValue({ requestDevice: vi.fn() });
	vi.mocked(SharedPeriPageClient.prototype.print).mockResolvedValue(undefined);
	history.replaceState(null, '', hash());
});

afterEach(() => {
	vi.clearAllMocks();
	history.replaceState(null, '', location.pathname);
});

describe('template preview and print lifecycle', () => {
	it('enables printing only after rendering and sends the displayed raster', async () => {
		const pending = deferred();
		vi.mocked(renderTemplate).mockReturnValue(pending.promise);
		const view = render(Page);
		const print = view.getByRole('button', { name: 'Print', exact: true });
		await expect.element(print).toBeDisabled();
		pending.resolve(ready);
		await expect.element(print).toBeEnabled();
		await print.click();
		expect(SharedPeriPageClient.prototype.print).toHaveBeenCalledWith(ready);
		const canvas = view.container.querySelector('canvas')!;
		expect([canvas.width, canvas.height]).toEqual([8, 1]);
		expect(canvas.getContext('2d')!.getImageData(0, 0, 1, 1).data[0]).toBe(0);
	});

	it('ignores an older render that finishes after the hash has changed', async () => {
		const first = deferred(),
			second = deferred();
		vi.mocked(renderTemplate)
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const view = render(Page);
		await expect.poll(() => vi.mocked(renderTemplate).mock.calls.length).toBe(1);
		changeHash(hash(9));
		await expect.poll(() => vi.mocked(renderTemplate).mock.calls.length).toBe(2);
		const latest = { width: 9, height: 1, data: Uint8Array.of(0x40, 0x80) };
		second.resolve(latest);
		await expect.element(view.getByRole('button', { name: 'Print', exact: true })).toBeEnabled();
		first.resolve(ready);
		await first.promise;
		await tick();
		await view.getByRole('button', { name: 'Print', exact: true }).click();
		expect(SharedPeriPageClient.prototype.print).toHaveBeenCalledWith(latest);
		expect(view.container.querySelector('canvas')!.width).toBe(9);
	});

	it('clears the old raster on invalid or legacy links and on image decoding failure', async () => {
		vi.mocked(renderTemplate)
			.mockResolvedValueOnce(ready)
			.mockRejectedValueOnce(new TemplateError('image'));
		const view = render(Page);
		const print = view.getByRole('button', { name: 'Print', exact: true });
		await expect.element(print).toBeEnabled();
		changeHash('#bytemap=v1&w=8&h=1&data=_w');
		await expect.element(print).toBeDisabled();
		expect(view.container.querySelector('canvas')).toBeNull();
		await expect.element(view.getByRole('alert')).toHaveTextContent('unsupported format');
		changeHash(hash(10));
		await expect.element(view.getByRole('alert')).toHaveTextContent('embedded PNG');
		await expect.element(print).toBeDisabled();
		expect(view.container.querySelector('canvas')).toBeNull();
	});
});

describe('text layer editor', () => {
	it('updates rotated text and the shared link, then prints only the new raster', async () => {
		const template = parseTemplate(resistors);
		changeHash(encodeTemplateHash(template));
		const pending = deferred();
		vi.mocked(renderTemplate).mockResolvedValueOnce(ready).mockReturnValueOnce(pending.promise);
		const view = render(Page);
		const print = view.getByRole('button', { name: 'Print', exact: true });
		await expect.element(print).toBeEnabled();
		await view.getByRole('button', { name: 'Edit text' }).click();
		const input = view.getByRole('textbox', { name: 'Text 3', exact: true });
		await expect.element(input).toHaveValue('680kΩ');
		await input.fill('47Ω');
		await expect.element(print).toBeDisabled();
		expect(view.container.querySelector('canvas')).toBeNull();
		const expected = {
			...template,
			layers: template.layers.map((layer, index) =>
				index === 3 ? { ...layer, text: '47Ω' } : layer
			)
		};
		expect(decodeTemplateHash(location.hash)).toEqual(expected);
		expect(renderTemplate).toHaveBeenLastCalledWith(expected);
		expect(replaceState).toHaveBeenCalledTimes(1);
		const language = view.container.querySelector<HTMLAnchorElement>('nav a[href^="/ru/"]')!;
		expect(new URL(language.href).hash).toBe(location.hash);
		const latest = { ...ready, data: Uint8Array.of(0x42) };
		pending.resolve(latest);
		await expect.element(print).toBeEnabled();
		await print.click();
		expect(SharedPeriPageClient.prototype.print).toHaveBeenCalledWith(latest);
	});

	it('allows empty text without changing images or QR payloads and follows incoming links', async () => {
		const template = exampleTemplate();
		changeHash(encodeTemplateHash(template));
		vi.mocked(renderTemplate).mockResolvedValue(ready);
		const view = render(Page);
		await view.getByRole('button', { name: 'Edit text' }).click();
		const input = view.getByRole('textbox', { name: 'Text 1', exact: true });
		await input.fill('');
		const expected = {
			...template,
			layers: template.layers.map((layer, index) => (index === 1 ? { ...layer, text: '' } : layer))
		};
		expect(decodeTemplateHash(location.hash)).toEqual(expected);
		await expect.element(input).toHaveValue('');
		changeHash(encodeTemplateHash(parseTemplate(resistors)));
		await expect.element(input).toHaveValue('Resistor 0.25w');
		changeHash('#template=invalid');
		await expect.element(view.getByRole('button', { name: 'Edit text' })).not.toBeInTheDocument();
		expect(view.container.querySelector('input')).toBeNull();
		changeHash(hash());
		await expect.element(view.getByRole('button', { name: 'Edit text' })).not.toBeInTheDocument();
	});

	it('keeps the newest edit when earlier renders finish later', async () => {
		changeHash(encodeTemplateHash(parseTemplate(resistors)));
		const first = deferred(),
			second = deferred();
		vi.mocked(renderTemplate)
			.mockResolvedValueOnce(ready)
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const view = render(Page);
		const print = view.getByRole('button', { name: 'Print', exact: true });
		await expect.element(print).toBeEnabled();
		await view.getByRole('button', { name: 'Edit text' }).click();
		const input = view.getByRole('textbox', { name: 'Text 2', exact: true });
		await input.fill('10Ω');
		await input.fill('22Ω');
		const latest = { ...ready, data: Uint8Array.of(0x24) };
		second.resolve(latest);
		await expect.element(print).toBeEnabled();
		first.resolve(ready);
		await first.promise;
		await tick();
		await expect.element(input).toHaveValue('22Ω');
		await print.click();
		expect(SharedPeriPageClient.prototype.print).toHaveBeenCalledWith(latest);
	});
});
