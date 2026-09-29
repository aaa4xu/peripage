import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import RasterPreview from './RasterPreview.svelte';

function pixels(canvas: HTMLCanvasElement): number[] {
	const rgba = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
	return Array.from(rgba).filter((_, offset) => offset % 4 === 0);
}

describe('packed raster preview', () => {
	it('renders MSB first, black ones, row padding and original orientation', async () => {
		const view = render(RasterPreview, {
			raster: { width: 9, height: 2, data: Uint8Array.of(0x80, 0xff, 0x01, 0x00) }
		});
		const canvas = view.container.querySelector('canvas')!;
		await expect
			.poll(() => pixels(canvas))
			.toEqual([
				0, 255, 255, 255, 255, 255, 255, 255, 0, 255, 255, 255, 255, 255, 255, 255, 0, 255
			]);
		expect(canvas.width).toBe(9);
		expect(canvas.height).toBe(2);
	});

	it('redraws when a new image replaces the previous one', async () => {
		const view = render(RasterPreview, {
			raster: { width: 8, height: 1, data: Uint8Array.of(0xff) }
		});
		const canvas = view.container.querySelector('canvas')!;
		await expect.poll(() => pixels(canvas)).toEqual(Array(8).fill(0));
		await view.rerender({ raster: { width: 1, height: 2, data: Uint8Array.of(0, 0x80) } });
		await expect.poll(() => pixels(canvas)).toEqual([255, 0]);
		expect(canvas.width).toBe(1);
		expect(canvas.height).toBe(2);
	});
});
