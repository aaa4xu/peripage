# PeriPage.js

SvelteKit 2 / Svelte 5 / TypeScript, Bun, Paraglide (`en`, `ru`), ESLint, Prettier, and Vitest.
SvelteKit settings live in `vite.config.ts`.

## Library and application

- `src/lib/peripagejs/` — BLE client, protocol, device state, and the `Raster` type.
  This code uses only relative imports and does not depend on the application,
  SvelteKit, translations, or label rendering.
- `src/lib/components/` — application UI components.
- `src/lib/label/` — JSON templates, QR codes, fonts, and print raster preparation.

The application imports the client and types through `$lib/peripagejs` (`index.ts`).
Everything remains in a single project with a shared `package.json`, build, and tests.

## Development

```sh
nix develop
bun install --frozen-lockfile
bun run dev
```

One command starts the application at both addresses:

- HTTP: `http://localhost:5173/`.
- HTTPS: `https://localhost:5174/`.

To access it from a phone on the local network, run `bun dev --host 0.0.0.0`.
Then use `http://<computer-IP>:5173/` or `https://<computer-IP>:5174/`.
A single Vite instance serves both ports with shared HMR.
If a port is occupied, startup fails instead of switching to another port.

`@vitejs/plugin-basic-ssl` automatically creates a self-signed certificate and
stores it in `node_modules/.vite/basic-ssl/` (excluded from Git). The browser will
show an untrusted certificate warning the first time you open the HTTPS URL.
Builds, preview, and tests retain their existing settings.

The default dev shell includes Bun and the GitHub CLI (`gh`). Firmware research tools are available in
a separate environment:

```sh
nix develop .#firmware
```

It includes `curl`, `file`, `innoextract`, `jadx`, `openssl`, `unzip`, and Python with
Androguard, Capstone, and Unicorn. Commands for reproducing the analysis are in the
[V1.22 BLE protocol documentation](docs/ble_protocol_v1.22.md#11-reproduction-and-evidence-map).

The physical `IP-200 / V1.36_203dpi` device has separate
[V1.36 documentation](docs/ble_protocol_v1.36.md). Local research scripts in
`scripts/firmware/` and artifacts in `storage/firmware/` are excluded from Git.

## Label preview from a JSON template

The page accepts `#template=<JSON encoded with encodeURIComponent>`. A template
contains the canvas dimensions and `image`, `text`, and `qr` layers with coordinates
in printer dots. Image layers contain embedded PNGs, text uses an explicit
`fontSize` without automatic fitting, and QR codes are generated from the supplied
string. The old raw raster format, `#bytemap=…`, has been removed.

The “Show example” button opens a 384×115 Homebox label: a frame with beveled top
corners, three lines on the left, and a QR code on the right. The complete example
is in [`src/lib/label/example.json`](src/lib/label/example.json); field descriptions
and link generation are covered in the [format documentation](docs/label_template.md).

```ts
import { encodeTemplateHash, parseTemplate } from './src/lib/label/template';
import example from './src/lib/label/example.json';

const url = new URL('https://example.com/peripagejs/ru/');
url.hash = encodeTemplateHash(parseTemplate(example));
```

The browser renders the template using the bundled Noto Sans font, then converts
it to a monochrome raster. Preview and printing use the same bytes. Printing is
available once the font and images have loaded. Changing the hash updates the
preview; an invalid template clears the previous image, and a late load result
cannot replace a newer image. The link is preserved when switching languages.
Hash data is not sent to the HTTP server.

The preview does not require a printer connection. It fills the available area
below the top bar, preserves the aspect ratio, and displays individual raster dots.
The printer icon button is in the bottom-right corner.

## Printing

Clicking the print icon opens the Bluetooth printer picker if no connection
exists. After connecting and reading device information, the application
automatically sends the image that was open when the button was clicked. Canceling
the picker or failing to connect also cancels printing. With an existing
connection, transmission starts immediately. Repeated clicks, information refreshes,
and other jobs are blocked during transmission.

Printing is currently enabled for the tested `IP-200 / V1.36_203dpi` profile, with
images up to 384 pixels wide. Narrower images are padded with white on the right to
384 dots, without changing row or bit order. The raster is followed by a 96-row
paper feed (nominally about 12 mm), then the end-of-job command.
There is no separate feed button.

The client tracks FF03 credits and sends packets of up to 100 bytes for the
confirmed `IP-200 / V1.36_203dpi` profile, respecting a smaller limit if the printer
advertises one. It sends initialization, header, raster, feed, and end-of-job
commands sequentially. A timeout or disconnection closes the session without
automatically reprinting. An `AA` response produces the message “Job sent to the
printer”, because it does not confirm paper movement. Transmission and connection
races are covered by tests with simulated BLE. Sending a 384×192 image from the
browser to the physical printer took 3.48 seconds from job start to `AA`; this
measurement does not confirm print quality.

## Connecting to a printer

Open the application through `localhost` or HTTPS in a browser with Web Bluetooth
(Chrome / Edge), turn on the PeriPage, and click “Connect printer”. In the system
picker, select the device named `PeriPage…`. After connecting, the application reads
the battery level, model, firmware and hardware versions, name, serial number, and
Bluetooth address. Connection state, battery, model, and firmware appear in a
horizontal bar at the top. The refresh button reads the information again;
“Disconnect” closes the connection. Clicking the status opens all details, hints,
and connection history. On narrow screens, additional fields remain available in
this panel.

When the connection is lost, the application clears device information; the reason
remains in the information panel and history. Use the button to reconnect. Leaving
the page also closes the connection. Picker cancellation, access denial, and
timeouts are handled separately.

The client in `src/lib/peripagejs/` uses the A6 BLE protocol: service `FF00`,
responses on `FF01`, writes to `FF02`, and a subscription to `FF03`. Queries run
sequentially: responses have no request identifier, so a timeout closes the
connection.

The browser may fail to deliver the initial FF03 notifications when subscribing.
If no credits have been granted yet, the client sends a short initialization
command (16 bytes) once, then waits for returned credits for all subsequent writes.
A received `01 00` still pauses transmission. This connection path and information
refresh have been tested on the physical `IP-200 / V1.36_203dpi`.
After identifying this profile, the client restores any missing startup parameters:
100 bytes per write and an initial window of four writes, minus the initialization
already sent. Received FF03 values take precedence, and refreshing information
does not add startup credits again. These values are not assumed for unknown
firmware.
Printer settings are not changed. Paper, cover, and overheating states are not
displayed because their encoding has not yet been confirmed.

Manual check: connect the printer, refresh information, disconnect with the button,
reconnect, and turn the printer off. The last step should restore the connection
button and clear device information. “Connection lost” should appear in the history.
Automated tests exercise these transitions with simulated Bluetooth, including late
responses and cancellation of an incomplete connection.

## Static build

```sh
bun run build
bun run preview
```

The generated site is in `build/`: HTML, JavaScript, CSS, and static assets.
Hosting does not require Bun, Node.js, or a SvelteKit server.

`@sveltejs/adapter-static` and `src/routes/+layout.ts` enable prerendering for all
pages. The build fails if any dynamic routes remain.
`trailingSlash = 'always'` generates pages as `route/index.html` so direct navigation
and page reloads work on static hosting.

The URL determines the language: English is at `/`, Russian at `/ru/`.
Hidden links in the root layout let the prerenderer discover every language version
of each page. `src/hooks.server.ts` handles localization during prerendering;
the server hook is not needed after deployment.

## GitHub Pages

For the [`aaa4xu/peripage`](https://github.com/aaa4xu/peripage) repository site at
[`https://aaa4xu.github.io/peripage/`](https://aaa4xu.github.io/peripage/):

```sh
BASE_PATH=/peripage bun run build
BASE_PATH=/peripage bun run preview
```

When previewing locally, open `/peripage/`. If the repository has a different
name, replace `/peripage` with that name, including the leading `/` and excluding
a trailing `/`. For `https://<owner>.github.io/` or a custom domain, build without
`BASE_PATH`.

Publish the contents of `build/`, including `_app/` and `.nojekyll`.

The [Deploy to GitHub Pages](.github/workflows/pages.yml) workflow runs on every
push to `main` and can be started manually from the Actions tab. It installs
Bun 1.4.2 and Node.js 24, runs `bun install --frozen-lockfile`, and builds the site.
The build also generates the Paraglide modules required for type checking in a
clean checkout. It then runs `bun run check`, `bun run lint`, and `bun run test`
before publishing `build/`. Chromium and its system dependencies for browser tests
are installed automatically. Deployment only proceeds after successful checks and
a successful build.

Before the first run, open **Settings → Pages → Build and deployment → Source**
in the GitHub repository and select **GitHub Actions**. Then push changes to `main`
or select **Actions → Deploy to GitHub Pages → Run workflow → main**.
Manual runs for other branches are skipped. The published site URL appears in the
`github-pages` environment and the deployment step output.

The workflow gets `BASE_PATH` from `actions/configure-pages`: `/repository-name`
for a repository site, or an empty string for a root site or configured custom
domain. Run the workflow again after changing the domain. No additional secrets or
`gh-pages` branch are required: it uses the standard `GITHUB_TOKEN`, with publishing
permissions granted only to the `deploy` job. Concurrent deployment runs are queued
without interrupting the current deployment.

Create internal links with `resolve` from `$app/paths`, and links to files in
`static/` with `asset`. Use Paraglide's `localizeHref` for language links: its
patterns already include `BASE_PATH`, so do not add the prefix again. Dynamic routes
(`[slug]`) need `entries` or links with concrete values that the
prerenderer can discover.

References: [SvelteKit static builds](https://svelte.dev/docs/kit/adapter-static),
[Paraglide and SvelteKit](https://paraglidejs.com/sveltekit).

## Checks

```sh
bun run check
bun run lint
bun run test
```

Vitest component tests require Chromium: `bun x playwright install chromium`.
