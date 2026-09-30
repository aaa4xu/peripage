import { describe, expect, it } from 'vitest';
import { exampleTemplate } from './example';
import {
	decodeTemplateHash,
	encodeTemplateHash,
	MAX_JSON_LENGTH,
	parseTemplate,
	TemplateError
} from './template';

const label = { version: 1, width: 384, height: 115, layers: [] };
const text = {
	type: 'text',
	x: 8,
	y: 8,
	width: 120,
	height: 32,
	text: 'M3 + гайки & шайбы #1',
	fontSize: 24
};

describe('JSON label templates', () => {
	it('reads a plain JSON fragment and preserves Cyrillic and URL punctuation', () => {
		const input = { ...label, layers: [text] };
		const decoded = decodeTemplateHash(`#template=${encodeURIComponent(JSON.stringify(input))}`)!;
		expect(decoded.layers[0]).toMatchObject(text);
		expect(decodeTemplateHash(encodeTemplateHash(decoded))).toEqual(decoded);
		expect(decodeTemplateHash(`#template=${JSON.stringify(input)}`)).toEqual(decoded);
	});

	it('round-trips the complete Swift-style example with image, text and QR layers', () => {
		const example = exampleTemplate();
		expect(decodeTemplateHash(encodeTemplateHash(example))).toEqual(example);
		expect(example.layers.map((layer) => layer.type)).toEqual([
			'image',
			'text',
			'text',
			'text',
			'qr'
		]);
	});

	it.each(['auto', 1, 24.5, 256])('preserves fontSize %j through a template link', (fontSize) => {
		const template = parseTemplate({ ...label, layers: [{ ...text, fontSize }] });
		expect(template.layers[0]).toMatchObject({ fontSize });
		expect(decodeTemplateHash(encodeTemplateHash(template))).toEqual(template);
	});

	it.each([0, 90, 180, 270])('preserves text rotation %i through a template link', (rotation) => {
		const template = parseTemplate({ ...label, layers: [{ ...text, rotation }] });
		expect(template.layers[0]).toMatchObject({ rotation });
		expect(decodeTemplateHash(encodeTemplateHash(template))).toEqual(template);
	});

	it('keeps blank text lines and supports an empty canvas', () => {
		expect(parseTemplate({ ...label, layers: [{ ...text, text: '' }] }).layers[0]).toMatchObject({
			text: ''
		});
		expect(parseTemplate(label).layers).toEqual([]);
		expect(decodeTemplateHash('#printer-details')).toBeNull();
		expect(decodeTemplateHash('')).toBeNull();
	});

	it.each([
		null,
		[],
		{ ...label, version: 2 },
		{ ...label, layers: null },
		{ ...label, width: 0 },
		{ ...label, height: 2.5 },
		{ ...label, width: 4097 },
		{ ...label, width: 4096, height: 4096 },
		{ ...label, layers: [{ ...text, x: -1 }] },
		{ ...label, layers: [{ ...text, x: 300 }] },
		{ ...label, layers: [{ ...text, fontSize: '24' }] },
		{ ...label, layers: [{ ...text, fontSize: 'AUTO' }] },
		{ ...label, layers: [{ ...text, fontSize: undefined }] },
		{ ...label, layers: [{ ...text, fontSize: 0 }] },
		{ ...label, layers: [{ ...text, fontSize: 257 }] },
		{ ...label, layers: [{ ...text, minFontSize: 8 }] },
		{ ...label, layers: [{ ...text, fontWeight: 900 }] },
		{ ...label, layers: [{ ...text, align: 'justify' }] },
		{ ...label, layers: [{ ...text, rotation: 45 }] },
		{ ...label, layers: [{ ...text, rotation: '90' }] },
		{ ...label, layers: [{ ...text, text: 'two\nlines' }] },
		{ ...label, layers: [{ type: 'qr', x: 0, y: 0, size: 99, text: '', rotation: 45 }] },
		{ ...label, layers: [{ type: 'html', html: '<b>label</b>' }] },
		{ ...label, layers: Array(65).fill(text) }
	])('rejects invalid dimensions, fields and layer definitions: %j', (input) => {
		expect(() => parseTemplate(input)).toThrow(TemplateError);
	});

	it.each([
		'https://example.com/frame.png',
		'javascript:alert(1)',
		'data:image/svg+xml,<svg/>',
		'data:image/png;base64,YQ=='
	])('rejects external resources and invalid PNG data: %s', (src) => {
		expect(() =>
			parseTemplate({ ...label, layers: [{ type: 'image', x: 0, y: 0, width: 1, height: 1, src }] })
		).toThrow('image');
	});

	it.each([
		'#bytemap=v1&w=8&h=1&data=_w',
		'#template=%XX',
		'#template=%7B',
		'#template=null',
		'#template={}&template={}'
	])('rejects legacy raster links and broken JSON: %s', (hash) => {
		expect(() => decodeTemplateHash(hash)).toThrow(TemplateError);
	});

	it('bounds the JSON and decoded PNG dimensions before rendering', () => {
		expect(() => decodeTemplateHash(`#template=${' '.repeat(MAX_JSON_LENGTH + 1)}`)).toThrow(
			'too-large'
		);
		const image = exampleTemplate().layers[0];
		if (image.type !== 'image') throw new Error('Expected PNG fixture');
		const binary = Uint8Array.from(atob(image.src.split(',')[1]), (char) => char.charCodeAt(0));
		new DataView(binary.buffer).setUint32(16, 1_000_000);
		const src = `data:image/png;base64,${btoa(String.fromCharCode(...binary))}`;
		expect(() => parseTemplate({ ...label, layers: [{ ...image, src }] })).toThrow('too-large');
	});
});
