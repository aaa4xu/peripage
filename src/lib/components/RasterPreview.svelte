<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import type { Raster } from '$lib/peripagejs';

	let { raster }: { raster: Raster } = $props();

	function draw(canvas: HTMLCanvasElement) {
		const { width, height, data } = raster;
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext('2d');
		if (!context) return;
		const image = context.createImageData(width, height);
		const stride = Math.ceil(width / 8);
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const value = data[y * stride + (x >> 3)] & (0x80 >> (x & 7)) ? 0 : 255;
				const offset = (y * width + x) * 4;
				image.data[offset] = value;
				image.data[offset + 1] = value;
				image.data[offset + 2] = value;
				image.data[offset + 3] = 255;
			}
		}
		context.putImageData(image, 0, 0);
	}
</script>

<div
	class="raster"
	role="img"
	aria-label={m.preview_image({ width: raster.width, height: raster.height })}
>
	<canvas width={raster.width} height={raster.height} aria-hidden="true" {@attach draw}></canvas>
</div>

<style>
	.raster {
		width: 100%;
		height: 100%;
		min-width: 0;
		min-height: 0;
	}
	canvas {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: contain;
		image-rendering: pixelated;
	}
</style>
