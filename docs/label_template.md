# JSON label template

The page accepts a single JSON document in the URL fragment:

```ts
const hash = '#template=' + encodeURIComponent(JSON.stringify(template));
```

The project provides `encodeTemplateHash()` and `decodeTemplateHash()` in
`src/lib/label/template.ts` for this. The fragment is not sent to the HTTP server.
The old `#bytemap=…` format has been removed: those links display an error and
disable printing.

## Structure

```json
{
	"version": 1,
	"width": 384,
	"height": 115,
	"layers": [
		{
			"type": "text",
			"x": 16,
			"y": 12,
			"width": 200,
			"height": 40,
			"text": "Resistors",
			"fontSize": "auto",
			"fontWeight": 700
		},
		{
			"type": "text",
			"x": 16,
			"y": 56,
			"width": 200,
			"height": 30,
			"text": "10 kΩ · 0.25 W",
			"fontSize": 15
		},
		{
			"type": "qr",
			"x": 236,
			"y": 8,
			"size": 99,
			"text": "HTTPS://HB.JJFF.CLOUD/A/000014",
			"errorCorrection": "L",
			"rotation": 270
		}
	]
}
```

The complete example **with a PNG frame**, three lines, and a QR code is in
[`src/lib/label/example.json`](../src/lib/label/example.json). The “Show example”
button opens it. Copy the JSON to change the text and QR content.

All dimensions and coordinates are **printer dots**, not CSS pixels in the
preview. The origin is the top-left corner; `x` increases to the right, `y`
downward. At 203 dpi, one dot is approximately 0.125 mm. The canvas starts white.
Layers are drawn in array order, from first to last.

The root fields `version`, `width`, `height`, and `layers` are required. Dimensions
and coordinates are integers. Each block must fit entirely within the canvas.
Unknown versions, layer types, and fields are rejected so a typo cannot silently
change the printout. An empty layer array produces a white canvas.

## Layers

| Type    | Required fields                                 | Optional fields               |
| ------- | ----------------------------------------------- | ----------------------------- |
| `image` | `x`, `y`, `width`, `height`, `src`              | —                             |
| `text`  | `x`, `y`, `width`, `height`, `text`, `fontSize` | `fontWeight`, `align`         |
| `qr`    | `x`, `y`, `size`, `text`                        | `errorCorrection`, `rotation` |

### Image

`src` is a PNG embedded as `data:image/png;base64,…` (standard Base64 with `+`, `/`,
and trailing `=` padding). The layer is scaled to the specified rectangle without
smoothing. PNG transparency is preserved; opaque pixels cover previous layers.
External URLs and SVG are not supported: the template contains the entire image
and requires neither a download from another site nor CORS configuration.

### Text

One layer is one line, including an empty line. Line breaks are not supported:
add a separate layer for each line.

- `fontSize` is required: either a number from 1 to 256 (fractional values are allowed)
  or `"auto"`.
- A numeric size is applied as given; content outside the block is clipped.
- `"auto"` selects the largest whole-dot font size from 1 to 256 that fits both the
  block's width and height. It measures the loaded font, including glyph overhangs,
  accents, and the font's line height. Short lines can grow; long lines shrink.
  If the line cannot fit even at size 1, rendering reports a dimensions error.
  Empty lines remain blank. Text does not wrap in either mode.
- `fontWeight`: `400`, `500`, or `700`; defaults to `400`.
- `align`: `left`, `center`, or `right`; defaults to `left`.
- The line is vertically centered in its block.
- Text is black. The application bundles **Noto Sans Variable**, including Cyrillic.
  Rendering waits for the font to load before enabling printing.

HTML, CSS, and variable substitutions in `text` are not evaluated. The program
creating the link must substitute the required Homebox or other source values in
advance.

### QR

`text` is passed to the encoder unchanged. `size` defines a square including a
four-module quiet zone on each side. The encoder selects the smallest suitable
version and an integer number of dots per module, then centers the code in the
square. There is no fractional scaling or smoothing. If even one pixel per module
will not fit, the template reports an error.

`errorCorrection` is `L`, `M`, `Q`, or `H`; defaults to `M`.
`rotation` is a clockwise rotation of `0`, `90`, `180`, or `270` degrees; defaults
to `0`. The QR layer draws black modules; its remaining pixels are transparent.

## Matching the Swift label

The example is based on `GridfinityLabel.swift`, `GridfinityLabelTextRenderer.swift`,
and `HomeboxItemLink.swift` from the neighboring `peripage` project:

- A 384×115 canvas, a 288×99 frame starting at `(48, 8)`, 16-dot top bevels,
  square bottom corners, and a one-dot outline. The frame was converted to PNG
  without smoothing.
- Three independent text lines on the left, with sizes **24, 15, 15** set in the JSON.
- A 99×99 QR code at `(236, 8)`, error correction `L`, rotation `270`: the corner
  without a finder pattern is at the top right. The short URL
  `HTTPS://HB.JJFF.CLOUD/A/000014` produces a 25×25 matrix with 3×3-dot modules.

The browser uses Noto Sans, while Swift used the system AppKit font, so the glyphs
are not bit-for-bit identical. The example keeps fixed sizes; set any text layer's
`fontSize` to `"auto"` to fit replacement text within the same block.
The Homebox API, credentials, and field selection logic are outside this format's
scope.

## Preview and printing

The canvas composition is converted to a monochrome raster with a brightness
threshold of `0.82`, matching Swift. Rows run from top to bottom; the most significant
bit in a byte is the leftmost pixel, and `1` means black. Unused bits on the right
remain white. **The preview displays the same bytes passed to the printer client.**

Printing is disabled while the font or PNG is loading. An error clears the previous
raster. If the link changes during loading, a late result cannot replace the new
template. The print button keeps its existing behavior: connect first if necessary,
then send the prepared raster.

Limits: 4096 dots per side, 1,048,576 dots per canvas and source PNG, 64 layers,
262,144 UTF-16 code units in the JSON, 1024 per text line, and 2048 for QR content.
Practical URL length limits may be lower. A6 printing remains limited to widths of
up to 384 dots.

## Creating a link

```ts
import { encodeTemplateHash, parseTemplate } from './src/lib/label/template';
import example from './src/lib/label/example.json';

const template = parseTemplate(example);
const title = template.layers.find((layer) => layer.type === 'text');
if (title?.type === 'text') {
	title.text = 'M3 nuts';
	title.fontSize = 'auto';
}

const url = new URL('https://example.com/peripagejs/ru/');
url.hash = encodeTemplateHash(template);
```

The font is distributed through [Fontsource](https://fontsource.org/fonts/noto-sans),
and QR codes are generated locally by [qrcode](https://github.com/soldair/node-qrcode).
