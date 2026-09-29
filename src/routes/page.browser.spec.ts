import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import Page from './+page.svelte';
import { browserBluetooth, PeriPageClient, type Raster } from '$lib/peripagejs';
import { renderTemplate } from '$lib/label/render';
import { encodeTemplateHash, TemplateError } from '$lib/label/template';

vi.mock('$app/navigation', () => ({ afterNavigate: () => {} }));
vi.mock('$app/state', () => ({ page: { url: new URL('https://localhost/') } }));
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
	vi.mocked(PeriPageClient.prototype.print).mockResolvedValue(undefined);
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
		expect(PeriPageClient.prototype.print).toHaveBeenCalledWith(ready);
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
		expect(PeriPageClient.prototype.print).toHaveBeenCalledWith(latest);
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
