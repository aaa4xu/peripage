import { describe, expect, it, vi } from 'vitest';
import jsQR from 'jsqr';
import { a6Raster, type Raster } from '$lib/peripagejs';
import { exampleTemplate } from './example';
import { renderTemplate } from './render';
import fullWidthHomebox from './homebox-full-width.json';
import { parseTemplate } from './template';
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

	it.each(['HTTPS://HB.JJFF.CLOUD/A/000014', 'https://example.com/Parts/000015?size=M'])(
		'balances measured paper margins with a 16-dot right inset and keeps the QR readable: %s',
		async (url) => {
			const template = parseTemplate({
				...fullWidthHomebox,
				layers: fullWidthHomebox.layers.map((layer) =>
					layer.type === 'qr' ? { ...layer, text: url } : layer
				)
			});
			const raster = await renderTemplate(template);
			expect(
				template.layers.filter((layer) => layer.type === 'text').map((layer) => layer.x)
			).toEqual([0, 0, 0]);
			expect([raster.width, raster.height, raster.data.length]).toEqual([384, 132, 6336]);
			expect(Array.from({ length: 100 }, (_, i) => black(raster, 367, 16 + i)).some(Boolean)).toBe(
				true
			);
			if (url === 'HTTPS://HB.JJFF.CLOUD/A/000014') {
				// The bottom-right finder ends 16 dots before the edge, at four dots per module.
				expect(
					Array.from({ length: 28 }, (_, i) => black(raster, 367, 88 + i)).every(Boolean)
				).toBe(true);
				expect(
					Array.from({ length: 28 }, (_, i) => black(raster, 340 + i, 115)).every(Boolean)
				).toBe(true);
			}
			expect(black(raster, 367, 116)).toBe(false);
			expect(black(raster, 267, 16)).toBe(false);
			expect(
				Array.from({ length: 16 * 130 }, (_, i) =>
					black(raster, 368 + (i % 16), 1 + Math.floor(i / 16))
				).some(Boolean)
			).toBe(false);
			// Model the unprintable white strip on either side of the actual paper.
			const margin = 16;
			const width = raster.width + margin * 2;
			const pixels = new Uint8ClampedArray(width * raster.height * 4).fill(255);
			const source = rgba(raster);
			for (let y = 0; y < raster.height; y++)
				pixels.set(
					source.subarray(y * raster.width * 4, (y + 1) * raster.width * 4),
					(y * width + margin) * 4
				);
			expect(jsQR(pixels, width, raster.height)?.data).toBe(url);
			expect(a6Raster(raster).body).toEqual(raster.data);
		}
	);

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

	it.each([
		{ text: 'MMMMMMMMMMMM', width: 120, height: 52, fontWeight: 400, align: 'left' },
		{ text: 'M', width: 160, height: 20, fontWeight: 700, align: 'center' },
		{ text: 'Ёжики и чай', width: 140, height: 36, fontWeight: 500, align: 'right' },
		{ text: 'Áyj\u0301\u0301\u0301', width: 104, height: 32, fontWeight: 400, align: 'center' },
		{ text: 'M', width: 384, height: 400, fontWeight: 400, align: 'left' }
	] as const)('fits auto-sized text into its block: %j', async (properties) => {
		const text: TextLayer = { type: 'text', x: 8, y: 8, fontSize: 'auto', ...properties };
		const draws: { font: string; metrics: TextMetrics; x: number; y: number }[] = [];
		const fillText = CanvasRenderingContext2D.prototype.fillText;
		const spy = vi
			.spyOn(CanvasRenderingContext2D.prototype, 'fillText')
			.mockImplementation(function (this: CanvasRenderingContext2D, value, x, y, maxWidth) {
				draws.push({ font: this.font, metrics: this.measureText(value), x, y });
				fillText.call(this, value, x, y, maxWidth);
			});
		try {
			const raster = await renderTemplate({
				version: 1,
				width: text.width + 16,
				height: text.height + 16,
				layers: [text]
			});
			expect(raster.data.some((byte) => byte !== 0)).toBe(true);
			expect(draws).toHaveLength(1);
			const { font, metrics, x, y } = draws[0];
			const size = Number(/(\d+)px/.exec(font)![1]);
			expect(font).toContain('Noto Sans Variable');
			expect(size).toBeGreaterThan(8);
			expect(size).toBeLessThanOrEqual(256);
			// Check the actual, unclipped glyph bounds, not just the clipped raster.
			expect(x - metrics.actualBoundingBoxLeft).toBeGreaterThanOrEqual(text.x);
			expect(x + metrics.actualBoundingBoxRight).toBeLessThanOrEqual(text.x + text.width);
			expect(y - metrics.actualBoundingBoxAscent).toBeGreaterThanOrEqual(text.y);
			expect(y + metrics.actualBoundingBoxDescent).toBeLessThanOrEqual(text.y + text.height);
			if (properties.height === 400) {
				expect(size).toBe(256);
			} else {
				const probe = document.createElement('canvas').getContext('2d')!;
				probe.font = font.replace(`${size}px`, `${size + 1}px`);
				const larger = probe.measureText(text.text);
				// The next whole-dot size must exceed at least one block dimension.
				expect(
					larger.width > text.width ||
						larger.actualBoundingBoxLeft + larger.actualBoundingBoxRight > text.width ||
						larger.fontBoundingBoxAscent + larger.fontBoundingBoxDescent > text.height ||
						larger.fontBoundingBoxAscent + larger.actualBoundingBoxDescent > text.height ||
						larger.actualBoundingBoxAscent + larger.fontBoundingBoxDescent > text.height ||
						larger.actualBoundingBoxAscent + larger.actualBoundingBoxDescent > text.height
				).toBe(true);
			}
		} finally {
			spy.mockRestore();
		}
	});

	it('reports auto text that cannot fit even at the minimum font size', async () => {
		await expect(
			renderTemplate({
				version: 1,
				width: 16,
				height: 16,
				layers: [
					{ type: 'text', x: 0, y: 0, width: 1, height: 1, text: 'TOO LONG', fontSize: 'auto' }
				]
			})
		).rejects.toThrow('dimensions');
	});

	it.each([90, 180, 270] as const)(
		'rotates fitted text %i degrees clockwise without losing or adding ink',
		async (rotation) => {
			const text: TextLayer = {
				type: 'text',
				x: 8,
				y: 8,
				width: 112,
				height: 44,
				text: '10 Ω',
				fontSize: 'auto',
				fontWeight: 700,
				align: 'center'
			};
			const source = await renderTemplate({
				version: 1,
				width: 128,
				height: 60,
				layers: [text]
			});
			const sideways = rotation !== 180;
			const width = sideways ? text.height : text.width;
			const height = sideways ? text.width : text.height;
			const rotated = await renderTemplate({
				version: 1,
				width: width + 16,
				height: height + 16,
				layers: [{ ...text, width, height, rotation }]
			});
			const expected = Array.from({ length: width * height }, (_, i) => {
				const x = i % width,
					y = Math.floor(i / width);
				const sx = rotation === 90 ? y : rotation === 180 ? text.width - 1 - x : text.width - 1 - y;
				const sy =
					rotation === 90 ? text.height - 1 - x : rotation === 180 ? text.height - 1 - y : x;
				return black(source, text.x + sx, text.y + sy);
			});
			expect(expected.some(Boolean)).toBe(true);
			expect(
				Array.from({ length: width * height }, (_, i) =>
					black(rotated, 8 + (i % width), 8 + Math.floor(i / width))
				)
			).toEqual(expected);
			expect(
				Array.from({ length: rotated.width * rotated.height }, (_, i) => {
					const x = i % rotated.width,
						y = Math.floor(i / rotated.width);
					return (x < 8 || x >= 8 + width || y < 8 || y >= 8 + height) && black(rotated, x, y);
				}).some(Boolean)
			).toBe(false);
		}
	);

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
			layers: [text, { ...text, y: 36, text: '', fontSize: 'auto' }]
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
