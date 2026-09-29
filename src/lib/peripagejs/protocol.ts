import type { Raster } from './raster.js';

// Wire format and flow control: docs/ble_protocol_v1.36.md, sections 2, 3 and 6.
export const SERVICE = 0xff00;
export const RESPONSE = 0xff01;
export const WRITE = 0xff02;
export const STATUS = 0xff03;

export const INITIALIZE = Uint8Array.of(0x10, 0xff, 0xfe, 0x01, ...Array(12).fill(0));
export const END_PRINT = Uint8Array.of(0x10, 0xff, 0xfe, 0x45);
export const FEED_AFTER_PRINT = Uint8Array.of(0x1b, 0x4a, 96);

export class PrinterCredits {
	available = 0;
	packetBytes = 20;
	paused = false;
	#bootstrapped = false;
	#grantSeen = false;
	#packetSizeSeen = false;

	get canWrite(): boolean {
		return !this.paused && this.available > 0;
	}

	bootstrapInitialization(): void {
		// The one initialization write provisionally uses one startup credit.
		this.#bootstrapped = true;
	}

	applyV136Profile(): void {
		// Only for the identified IP-200 / V1.36_203dpi. Live FF03 captures
		// consistently advertise four startup credits and 100-byte packets.
		if (!this.#packetSizeSeen) this.packetBytes = 100;
		if (this.#bootstrapped) {
			// Initialization already used one of the four missing startup credits.
			// Returned credits and subsequent writes are already accounted for.
			this.available += 4 - 1;
			this.#bootstrapped = false;
		}
	}

	accept(bytes: Uint8Array): void {
		if (bytes.length === 2 && bytes[0] === 1) {
			// 01 00 is a conservative pause policy inherited from the V1.22 analysis.
			this.paused = bytes[1] === 0;
			if (this.#bootstrapped && !this.#grantSeen && bytes[1] > 1) {
				// A delayed startup grant: only initialization has been written,
				// so this cannot be a refill for multiple writes. Do not count it twice.
				this.available += bytes[1] - 1;
				this.#bootstrapped = false;
			} else {
				this.available += bytes[1];
			}
			if (bytes[1] > 0) this.#grantSeen = true;
		} else if (bytes.length === 3 && bytes[0] === 2) {
			const size = bytes[1] | (bytes[2] << 8);
			if (size > 0) {
				this.packetBytes = size;
				this.#packetSizeSeen = true;
			}
		}
	}
}

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

export function supportsRasterPrinting(info: PrinterInfo): boolean {
	return info.model === 'IP-200' && info.firmware === 'V1.36_203dpi';
}

/** Pad narrow images to the tested 384-dot profile, preserving row and bit order. */
export function a6Raster(raster: Raster): { header: Uint8Array; body: Uint8Array } {
	const { width, height, data } = raster;
	const stride = Math.ceil(width / 8);
	if (
		!Number.isInteger(width) ||
		width < 1 ||
		width > 384 ||
		!Number.isInteger(height) ||
		height < 1 ||
		height > 4096 ||
		data.length !== stride * height
	)
		throw new Error('Invalid raster dimensions or length for the 384-dot A6');
	const body = new Uint8Array(48 * height);
	for (let y = 0; y < height; y++) {
		body.set(data.subarray(y * stride, (y + 1) * stride), y * 48);
		if (width % 8) body[y * 48 + stride - 1] &= 0xff << (8 - (width % 8));
	}
	return {
		header: Uint8Array.of(0x1d, 0x76, 0x30, 0, 48, 0, height & 255, height >> 8),
		body
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
