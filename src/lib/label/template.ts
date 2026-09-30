export interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface ImageLayer extends Box {
	type: 'image';
	/** Embedded PNG. No network requests are made for template images. */
	src: string;
}

export interface TextLayer extends Box {
	type: 'text';
	text: string;
	/** A fixed size in dots, or the largest whole-dot size that fits the block. */
	fontSize: number | 'auto';
	fontWeight?: 400 | 500 | 700;
	align?: 'left' | 'center' | 'right';
	/** Clockwise rotation inside the final, axis-aligned block. */
	rotation?: 0 | 90 | 180 | 270;
}

export interface QrLayer {
	type: 'qr';
	x: number;
	y: number;
	/** Square including the quiet zone; module size is always an integer. */
	size: number;
	text: string;
	errorCorrection?: 'L' | 'M' | 'Q' | 'H';
	/** Blank modules on each side. Defaults to four; zero uses surrounding whitespace. */
	quietZone?: number;
	/** Horizontal alignment inside the square. Defaults to center. */
	align?: 'left' | 'center' | 'right';
	/** Clockwise rotation, in degrees. */
	rotation?: 0 | 90 | 180 | 270;
}

export type LabelLayer = ImageLayer | TextLayer | QrLayer;

export interface LabelTemplate {
	version: 1;
	width: number;
	height: number;
	layers: LabelLayer[];
}

export const MAX_DIMENSION = 4096;
export const MAX_PIXELS = 1_048_576;
export const MAX_JSON_LENGTH = 262_144;
export const MAX_FONT_SIZE = 256;
const MAX_HASH_LENGTH = MAX_JSON_LENGTH * 9 + 10;

export type TemplateErrorCode = 'format' | 'dimensions' | 'too-large' | 'image' | 'qr' | 'render';

export class TemplateError extends Error {
	constructor(readonly code: TemplateErrorCode) {
		super(`Invalid label template: ${code}`);
		this.name = 'TemplateError';
	}
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new TemplateError('format');
	if (Object.keys(value).some((key) => !keys.includes(key))) throw new TemplateError('format');
	return value as Record<string, unknown>;
}

function integer(value: unknown, minimum = 1): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
		throw new TemplateError('dimensions');
	if (value > MAX_DIMENSION) throw new TemplateError('too-large');
	return value;
}

function dimensions(width: unknown, height: unknown): { width: number; height: number } {
	const size = { width: integer(width), height: integer(height) };
	if (size.width * size.height > MAX_PIXELS) throw new TemplateError('too-large');
	return size;
}

function box(value: Record<string, unknown>, canvas: { width: number; height: number }): Box {
	const bounds = {
		x: integer(value.x, 0),
		y: integer(value.y, 0),
		...dimensions(value.width, value.height)
	};
	if (bounds.x + bounds.width > canvas.width || bounds.y + bounds.height > canvas.height)
		throw new TemplateError('dimensions');
	return bounds;
}

function string(value: unknown, maximum: number): string {
	if (typeof value !== 'string') throw new TemplateError('format');
	if (value.length > maximum) throw new TemplateError('too-large');
	return value;
}

function fontSize(value: unknown): TextLayer['fontSize'] {
	if (value === 'auto') return value;
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > MAX_FONT_SIZE)
		throw new TemplateError('format');
	return value;
}

function choice<T extends string | number>(value: unknown, choices: readonly T[]): T | undefined {
	if (value === undefined) return undefined;
	if (!choices.includes(value as T)) throw new TemplateError('format');
	return value as T;
}

/** Check dimensions before asking the browser to decompress the embedded PNG. */
export function pngDimensions(src: string): { width: number; height: number } {
	if (
		!/^data:image\/png;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
			src
		)
	)
		throw new TemplateError('image');
	let bytes: Uint8Array;
	try {
		bytes = Uint8Array.from(atob(src.slice(src.indexOf(',') + 1)), (char) => char.charCodeAt(0));
	} catch {
		throw new TemplateError('image');
	}
	const header = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82];
	if (bytes.length < 33 || header.some((byte, i) => bytes[i] !== byte))
		throw new TemplateError('image');
	const view = new DataView(bytes.buffer);
	return dimensions(view.getUint32(16), view.getUint32(20));
}

/** Validate unknown JSON and produce a new, typed template. Coordinates are printer dots. */
export function parseTemplate(value: unknown): LabelTemplate {
	const root = object(value, ['version', 'width', 'height', 'layers']);
	if (root.version !== 1) throw new TemplateError('format');
	const canvas = dimensions(root.width, root.height);
	if (!Array.isArray(root.layers)) throw new TemplateError('format');
	if (root.layers.length > 64) throw new TemplateError('too-large');
	let contentLength = 0;
	const layers = root.layers.map((value): LabelLayer => {
		if (!value || typeof value !== 'object') throw new TemplateError('format');
		switch (value.type) {
			case 'image': {
				const layer = object(value, ['type', 'x', 'y', 'width', 'height', 'src']);
				const src = string(layer.src, MAX_JSON_LENGTH);
				contentLength += src.length;
				pngDimensions(src);
				return { type: 'image', ...box(layer, canvas), src };
			}
			case 'text': {
				const layer = object(value, [
					'type',
					'x',
					'y',
					'width',
					'height',
					'text',
					'fontSize',
					'fontWeight',
					'align',
					'rotation'
				]);
				const text = string(layer.text, 1024);
				contentLength += text.length;
				if (/[\r\n]/.test(text)) throw new TemplateError('format');
				const size = fontSize(layer.fontSize);
				return {
					type: 'text',
					...box(layer, canvas),
					text,
					fontSize: size,
					fontWeight: choice(layer.fontWeight, [400, 500, 700] as const),
					align: choice(layer.align, ['left', 'center', 'right'] as const),
					rotation: choice(layer.rotation, [0, 90, 180, 270] as const)
				};
			}
			case 'qr': {
				const layer = object(value, [
					'type',
					'x',
					'y',
					'size',
					'text',
					'errorCorrection',
					'quietZone',
					'align',
					'rotation'
				]);
				const size = integer(layer.size);
				const { x, y } = box({ ...layer, width: size, height: size }, canvas);
				const text = string(layer.text, 2048);
				contentLength += text.length;
				if (!text.length) throw new TemplateError('format');
				return {
					type: 'qr',
					x,
					y,
					size,
					text,
					errorCorrection: choice(layer.errorCorrection, ['L', 'M', 'Q', 'H'] as const),
					quietZone: layer.quietZone === undefined ? undefined : integer(layer.quietZone, 0),
					align: choice(layer.align, ['left', 'center', 'right'] as const),
					rotation: choice(layer.rotation, [0, 90, 180, 270] as const)
				};
			}
			default:
				throw new TemplateError('format');
		}
	});
	if (contentLength > MAX_JSON_LENGTH) throw new TemplateError('too-large');
	return { version: 1, ...canvas, layers };
}

export function encodeTemplateHash(value: LabelTemplate): string {
	const json = JSON.stringify(parseTemplate(value));
	if (json.length > MAX_JSON_LENGTH) throw new TemplateError('too-large');
	return `#template=${encodeURIComponent(json)}`;
}

/** Empty/unrelated anchors have no template. The former bytemap format is not supported. */
export function decodeTemplateHash(hash: string): LabelTemplate | null {
	if (hash.length > MAX_HASH_LENGTH) throw new TemplateError('too-large');
	const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
	if (new URLSearchParams(fragment).has('bytemap')) throw new TemplateError('format');
	if (!fragment.startsWith('template=')) return null;
	let json: string;
	let value: unknown;
	try {
		json = decodeURIComponent(fragment.slice('template='.length));
		if (json.length > MAX_JSON_LENGTH) throw new TemplateError('too-large');
		value = JSON.parse(json);
	} catch (error) {
		throw error instanceof TemplateError ? error : new TemplateError('format');
	}
	return parseTemplate(value);
}
