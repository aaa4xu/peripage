/** Packed printer raster: rows top to bottom, MSB first, 1 = black, 0 = white. */
export interface Raster {
	width: number;
	height: number;
	/** Each row occupies ceil(width / 8) bytes, with white padding on the right. */
	data: Uint8Array;
}
