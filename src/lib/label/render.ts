import '@fontsource-variable/noto-sans';
import QRCode from 'qrcode';
import type { Raster } from '$lib/peripagejs';
import {
	MAX_FONT_SIZE,
	parseTemplate,
	TemplateError,
	type LabelTemplate,
	type QrLayer,
	type TextLayer
} from './template';

const FONT = '"Noto Sans Variable"';
const font = (
	layer: TextLayer,
	size = layer.fontSize === 'auto' ? MAX_FONT_SIZE : layer.fontSize
) => `${layer.fontWeight ?? 400} ${size}px ${FONT}`;

async function bounded<T>(operation: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new TemplateError('render')), 10_000);
			})
		]);
	} finally {
		clearTimeout(timer!);
	}
}

function drawText(context: CanvasRenderingContext2D, layer: TextLayer): void {
	if (!layer.text) return;
	const automatic = layer.fontSize === 'auto';
	const measure = (size: number) => {
		context.font = font(layer, size);
		const metrics = context.measureText(layer.text);
		let ascent = metrics.fontBoundingBoxAscent ?? metrics.actualBoundingBoxAscent;
		let descent = metrics.fontBoundingBoxDescent ?? metrics.actualBoundingBoxDescent;
		let width = Math.max(
			metrics.width,
			metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight
		);
		if (automatic) {
			// Include ink overhangs and combining marks as well as the font's line box.
			ascent = Math.max(ascent, metrics.actualBoundingBoxAscent);
			descent = Math.max(descent, metrics.actualBoundingBoxDescent);
			width =
				Math.max(metrics.width, metrics.actualBoundingBoxRight) +
				Math.max(0, metrics.actualBoundingBoxLeft);
		}
		return { metrics, ascent, height: ascent + descent, width };
	};
	let size = layer.fontSize;
	if (size === 'auto') {
		let low = 1;
		let high = MAX_FONT_SIZE;
		while (low <= high) {
			const candidate = Math.floor((low + high) / 2);
			const { width, height } = measure(candidate);
			if (width <= layer.width && height <= layer.height) low = candidate + 1;
			else high = candidate - 1;
		}
		if (high < 1) throw new TemplateError('dimensions');
		size = high;
	}
	const { metrics, ascent, height, width } = measure(size);
	const gap = layer.width - width;
	const alignOffset = layer.align === 'right' ? gap : layer.align === 'center' ? gap / 2 : 0;
	context.save();
	context.beginPath();
	context.rect(layer.x, layer.y, layer.width, layer.height);
	context.clip();
	context.fillStyle = '#000';
	context.fillText(
		layer.text,
		layer.x + Math.floor(alignOffset) + Math.max(0, metrics.actualBoundingBoxLeft),
		layer.y + Math.floor((layer.height - height) / 2) + ascent
	);
	context.restore();
}

function drawQr(context: CanvasRenderingContext2D, layer: QrLayer): void {
	try {
		const { modules } = QRCode.create(layer.text, {
			errorCorrectionLevel: layer.errorCorrection ?? 'M'
		});
		const count = modules.size;
		const scale = Math.floor(layer.size / (count + 8));
		if (scale < 1) throw new TemplateError('qr');
		const inset = Math.floor((layer.size - (count + 8) * scale) / 2) + 4 * scale;
		context.fillStyle = '#000';
		for (let y = 0; y < count; y++) {
			for (let x = 0; x < count; x++) {
				if (!modules.get(y, x)) continue;
				let dx = x;
				let dy = y;
				switch (layer.rotation ?? 0) {
					case 90:
						dx = count - 1 - y;
						dy = x;
						break;
					case 180:
						dx = count - 1 - x;
						dy = count - 1 - y;
						break;
					case 270:
						dx = y;
						dy = count - 1 - x;
						break;
				}
				context.fillRect(layer.x + inset + dx * scale, layer.y + inset + dy * scale, scale, scale);
			}
		}
	} catch {
		throw new TemplateError('qr');
	}
}

/** Browser-only rendering. The returned bytes are shared by the preview and printer. */
export async function renderTemplate(input: LabelTemplate): Promise<Raster> {
	const template = parseTemplate(input);
	const canvas = document.createElement('canvas');
	canvas.width = template.width;
	canvas.height = template.height;
	const context = canvas.getContext('2d');
	if (!context) throw new TemplateError('render');
	context.fillStyle = '#fff';
	context.fillRect(0, 0, canvas.width, canvas.height);
	context.imageSmoothingEnabled = false;
	try {
		await bounded(
			Promise.all(
				template.layers
					.filter((layer) => layer.type === 'text' && layer.text)
					.map((layer) => document.fonts.load(font(layer as TextLayer), (layer as TextLayer).text))
			)
		);
		for (const layer of template.layers) {
			if (layer.type === 'image') {
				const image = new Image();
				image.src = layer.src;
				try {
					await bounded(image.decode());
				} catch {
					throw new TemplateError('image');
				}
				context.drawImage(image, layer.x, layer.y, layer.width, layer.height);
			} else if (layer.type === 'text') {
				drawText(context, layer);
			} else {
				drawQr(context, layer);
			}
		}
		const { width, height } = template;
		const rgba = context.getImageData(0, 0, width, height).data;
		const stride = Math.ceil(width / 8);
		const data = new Uint8Array(stride * height);
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const offset = (y * width + x) * 4;
				// Same luminance threshold as the Swift label text renderer.
				if (
					0.2126 * rgba[offset] + 0.7152 * rgba[offset + 1] + 0.0722 * rgba[offset + 2] <
					0.82 * 255
				)
					data[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
			}
		}
		return { width, height, data };
	} catch (error) {
		throw error instanceof TemplateError ? error : new TemplateError('render');
	}
}
