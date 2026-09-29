import { describe, expect, it } from 'vitest';
import jsQR from 'jsqr';
import { a6Raster, type Raster } from '$lib/peripagejs';
import { exampleTemplate } from './example';
import { renderTemplate } from './render';
import type { LabelTemplate, TextLayer } from './template';

function black(raster: Raster, x: number, y: number): boolean {
	return !!(raster.data[y * Math.ceil(raster.width / 8) + (x >> 3)] & (0x80 >> (x & 7)));
}

function rgba(raster: Raster): Uint8ClampedArray {
	const pixels = new Uint8ClampedArray(raster.width * raster.height * 4);
	for (let y = 0; y < raster.height; y++)
		for (let x = 0; x < raster.width; x++) {
			const offset = (y * raster.width + x) * 4;
			pixels.fill(black(raster, x, y) ? 0 : 255, offset, offset + 3);
			pixels[offset + 3] = 255;
		}
	return pixels;
}

describe('label rendering in the browser', () => {
	it('produces a readable compact Homebox QR and the exact bytes used for printing', async () => {
		const raster = await renderTemplate(exampleTemplate());
		const decoded = jsQR(rgba(raster), raster.width, raster.height);
		expect(decoded?.data).toBe('HTTPS://HB.JJFF.CLOUD/A/000014');
		expect([raster.width, raster.height, raster.data.length]).toEqual([384, 115, 5520]);
		expect(a6Raster(raster).body).toEqual(raster.data);
		// The example keeps the Swift QR orientation: no finder at top right.
		const finder = (mx: number, my: number) =>
			Array.from({ length: 49 }, (_, i) => {
				const x = i % 7,
					y = Math.floor(i / 7);
				const expected =
					x === 0 || y === 0 || x === 6 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4);
				return black(raster, 248 + (mx + x) * 3, 20 + (my + y) * 3) === expected;
			}).every(Boolean);
		expect(finder(0, 0)).toBe(true);
		expect(finder(18, 0)).toBe(false);
		expect(finder(18, 18)).toBe(true);
	});

	it('matches the Swift border dimensions, top chamfers and square bottom corners', async () => {
		const template = exampleTemplate();
		template.layers = template.layers.filter((layer) => layer.type === 'image');
		const raster = await renderTemplate(template);
		expect(black(raster, 64, 8)).toBe(true);
		expect(black(raster, 48, 8)).toBe(false);
		expect(black(raster, 48, 24)).toBe(true);
		expect(black(raster, 335, 24)).toBe(true);
		expect(black(raster, 48, 106)).toBe(true);
		expect(black(raster, 335, 106)).toBe(true);
		expect(black(raster, 150, 50)).toBe(false);
	});

	it('uses the requested font size for long text, clipping it to the block', async () => {
		const text: TextLayer = {
			type: 'text',
			x: 8,
			y: 8,
			width: 40,
			height: 44,
			text: 'M',
			fontSize: 32
		};
		const template: LabelTemplate = { version: 1, width: 96, height: 64, layers: [text] };
		const short = await renderTemplate(template);
		const long = await renderTemplate({
			...template,
			layers: [{ ...text, text: 'MMMMMMMMMMMMMMMM' }]
		});
		const firstGlyph = (raster: Raster) =>
			Array.from({ length: 44 * 24 }, (_, i) =>
				black(raster, 8 + (i % 24), 8 + Math.floor(i / 24))
			);
		expect(firstGlyph(short).some(Boolean)).toBe(true);
		expect(firstGlyph(long)).toEqual(firstGlyph(short));
		expect(
			Array.from({ length: 64 * 48 }, (_, i) =>
				black(long, 48 + (i % 48), Math.floor(i / 48))
			).some(Boolean)
		).toBe(false);
	});

	it('renders Cyrillic and leaves explicitly empty text rows blank', async () => {
		const text: TextLayer = {
			type: 'text',
			x: 0,
			y: 0,
			width: 160,
			height: 36,
			text: 'Этикетка',
			fontSize: 24
		};
		const template: LabelTemplate = {
			version: 1,
			width: 160,
			height: 72,
			layers: [text, { ...text, y: 36, text: '' }]
		};
		const raster = await renderTemplate(template);
		expect(raster.data.slice(0, 20 * 36).some((byte) => byte > 0)).toBe(true);
		expect(raster.data.slice(20 * 36).every((byte) => byte === 0)).toBe(true);
	});

	it('composites image layers in order on white and keeps row padding white', async () => {
		const image = document.createElement('canvas');
		image.width = 1;
		image.height = 1;
		const context = image.getContext('2d')!;
		context.fillStyle = '#000';
		context.fillRect(0, 0, 1, 1);
		const dark = image.toDataURL('image/png');
		context.fillStyle = '#fff';
		context.fillRect(0, 0, 1, 1);
		const light = image.toDataURL('image/png');
		const raster = await renderTemplate({
			version: 1,
			width: 9,
			height: 2,
			layers: [
				{ type: 'image', x: 0, y: 0, width: 9, height: 1, src: dark },
				{ type: 'image', x: 1, y: 0, width: 7, height: 1, src: light }
			]
		});
		expect(Array.from(raster.data)).toEqual([0x80, 0x80, 0, 0]);
	});

	it('reports a QR that cannot fit instead of stretching or silently omitting it', async () => {
		await expect(
			renderTemplate({
				version: 1,
				width: 20,
				height: 20,
				layers: [{ type: 'qr', x: 0, y: 0, size: 20, text: 'HELLO' }]
			})
		).rejects.toThrow('qr');
	});
});
