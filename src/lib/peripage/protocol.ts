// Verified against the A6 protocol in ../peripage/PROTOCOL.md, sections 2 and 5.
export const SERVICE = 0xff00;
export const RESPONSE = 0xff01;
export const WRITE = 0xff02;
export const STATUS = 0xff03;

export const INITIALIZE = Uint8Array.of(0x10, 0xff, 0xfe, 0x01, ...Array(12).fill(0));

export interface PrinterInfo {
	battery: number | null;
	model: string | null;
	firmware: string | null;
	hardware: string | null;
	name: string | null;
	serial: string | null;
	mac: string | null;
}

export function emptyInfo(): PrinterInfo {
	return {
		battery: null,
		model: null,
		firmware: null,
		hardware: null,
		name: null,
		serial: null,
		mac: null
	};
}

function parseText(bytes: Uint8Array): string {
	const text = new TextDecoder().decode(bytes).replace(/\0+$/, '').trim();
	if (!text || !/^[\x20-\x7e]+$/.test(text)) throw new Error('Invalid text response');
	return text;
}

function parseBattery(bytes: Uint8Array): number {
	if (bytes.length !== 2 || bytes[0] !== 0 || bytes[1] > 100) {
		throw new Error('Invalid battery response');
	}
	return bytes[1];
}

function parseMac(bytes: Uint8Array): string {
	const text = new TextDecoder().decode(bytes).replace(/\0+$/, '').trim();
	if (/^(?:[\da-f]{2}[:-]){5}[\da-f]{2}$/i.test(text))
		return text.replaceAll('-', ':').toUpperCase();
	if (bytes.length !== 6 && bytes.length !== 12) throw new Error('Invalid MAC response');
	return Array.from(bytes.subarray(0, 6), (byte) => byte.toString(16).padStart(2, '0'))
		.join(':')
		.toUpperCase();
}

function query<K extends keyof PrinterInfo>(
	field: K,
	command: number[],
	parse: (bytes: Uint8Array) => PrinterInfo[K]
) {
	return {
		field,
		command: Uint8Array.from(command),
		apply: (info: PrinterInfo, bytes: Uint8Array): PrinterInfo => ({
			...info,
			[field]: parse(bytes)
		})
	};
}

// FF01 replies have no request identifiers: only one query may be in flight.
export const INFO_QUERIES = [
	query('battery', [0x10, 0xff, 0x50, 0xf1], parseBattery),
	query('model', [0x10, 0xff, 0x20, 0xf0], parseText),
	query('firmware', [0x10, 0xff, 0x20, 0xf1], parseText),
	query('hardware', [0x10, 0xff, 0x30, 0x10], parseText),
	query('name', [0x10, 0xff, 0x30, 0x11], parseText),
	query('serial', [0x10, 0xff, 0x20, 0xf2], parseText),
	query('mac', [0x10, 0xff, 0x30, 0x12], parseMac)
] as const;
