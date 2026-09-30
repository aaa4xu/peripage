<script lang="ts">
	import { onMount } from 'svelte';
	import { afterNavigate, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { base } from '$app/paths';
	import type { ResolvedPathname } from '$app/types';
	import { m } from '$lib/paraglide/messages';
	import PrinterBar from '$lib/components/PrinterBar.svelte';
	import {
		browserBluetooth,
		SharedPeriPageClient,
		supportsRasterPrinting,
		type Raster
	} from '$lib/peripagejs';
	import RasterPreview from '$lib/components/RasterPreview.svelte';
	import {
		TemplateError,
		decodeTemplateHash,
		encodeTemplateHash,
		type LabelTemplate,
		type TemplateErrorCode
	} from '$lib/label/template';
	import { exampleTemplate } from '$lib/label/example';
	import { renderTemplate } from '$lib/label/render';

	const client = new SharedPeriPageClient(base || '/');
	let printer = $state.raw(client.state);
	let hash = $state('');
	let template = $state.raw<LabelTemplate | null>(null);
	let editing = $state(false);
	const textLayers = $derived(
		template?.layers.flatMap((layer, index) => (layer.type === 'text' ? [{ layer, index }] : [])) ??
			[]
	);
	const qrLayers = $derived(
		template?.layers.flatMap((layer, index) => (layer.type === 'qr' ? [{ layer, index }] : [])) ??
			[]
	);
	const hasEditableLayers = $derived(textLayers.length > 0 || qrLayers.length > 0);
	let printError = $state(false);
	let bluetoothAvailable = $state(false);
	let preview = $state.raw<{
		raster: Raster | null;
		error: TemplateErrorCode | null;
		loading: boolean;
	}>({
		raster: null,
		error: null,
		loading: false
	});
	let generation = 0;
	let renderedHash: string | undefined;
	const errorMessages = {
		format: m.preview_error_format,
		dimensions: m.preview_error_dimensions,
		image: m.preview_error_image,
		qr: m.preview_error_qr,
		render: m.preview_error_render,
		'too-large': m.preview_error_size
	};
	const sending = $derived(printer.job === 'printing');
	const queued = $derived(printer.job === 'queued');
	const printHint = $derived.by(() => {
		if (sending) return m.print_sending();
		if (queued) return m.print_queued();
		if (preview.loading) return m.preview_rendering();
		if (printer.phase === 'connected' && !supportsRasterPrinting(printer.info))
			return m.print_profile_hint();
		if (preview.raster && preview.raster.width > 384) return m.print_width_hint();
		if (printError || printer.job === 'error') return m.print_unconfirmed();
		if (printer.error) return m.print_error();
		if (!printer.connection) return '';
		if (!preview.raster) return m.print_image_hint();
		return printer.job === 'sent' ? m.print_sent() : '';
	});
	const canPrint = $derived(
		bluetoothAvailable &&
			printer.ready &&
			!sending &&
			!queued &&
			!['choosing', 'connecting'].includes(printer.phase) &&
			(!printer.connection || supportsRasterPrinting(printer.info)) &&
			!!preview.raster &&
			preview.raster.width <= 384 &&
			!preview.loading
	);

	async function readHash() {
		if (renderedHash === window.location.hash) return;
		hash = window.location.hash;
		renderedHash = hash;
		const current = ++generation;
		printError = false;
		template = null;
		preview = { raster: null, error: null, loading: false };
		try {
			template = decodeTemplateHash(hash);
			if (!template) return;
			preview = { raster: null, error: null, loading: true };
			const raster = await renderTemplate(template);
			if (current === generation) preview = { raster, error: null, loading: false };
		} catch (error) {
			if (current === generation)
				preview = {
					raster: null,
					error: error instanceof TemplateError ? error.code : 'render',
					loading: false
				};
		}
	}

	function editLayerText(index: number, text: string) {
		if (!template) return;
		template = {
			...template,
			layers: template.layers.map((layer, i) =>
				i === index && (layer.type === 'text' || layer.type === 'qr') ? { ...layer, text } : layer
			)
		};
		try {
			// The current pathname already includes the locale and deployment base.
			replaceState(
				`${page.url.pathname}${page.url.search}${encodeTemplateHash(template)}` as ResolvedPathname,
				page.state
			);
			void readHash();
		} catch (error) {
			generation++;
			renderedHash = undefined;
			printError = false;
			preview = {
				raster: null,
				error: error instanceof TemplateError ? error.code : 'render',
				loading: false
			};
		}
	}

	function showExample() {
		window.location.hash = encodeTemplateHash(exampleTemplate());
	}

	async function print() {
		if (!canPrint || !preview.raster) return;
		printError = false;
		try {
			await client.print(preview.raster);
		} catch {
			printError = true;
		}
	}

	// The fragment is only available in the browser. Cover Kit navigation and
	// native hash changes, including back/forward, without reconnecting BLE.
	afterNavigate(() => void readHash());
	onMount(() => {
		void readHash();
		bluetoothAvailable = window.isSecureContext && !!browserBluetooth();
		const unsubscribe = client.subscribe((next) => {
			printer = next;
		});
		client.start();
		return () => {
			generation++;
			unsubscribe();
			client.dispose();
		};
	});
</script>

<svelte:window
	onhashchange={readHash}
	onpagehide={() => client.stop()}
	onpageshow={() => client.start()}
/>

<svelte:head>
	<title>{m.page_title()}</title>
	<meta name="description" content={m.preview_description()} />
</svelte:head>

<div class="app-shell">
	<PrinterBar {hash} {client} {printer} />
	<main aria-label={m.preview_title()}>
		<div class="workspace" class:editing={editing && hasEditableLayers}>
			{#if editing && hasEditableLayers}
				<aside id="label-text-editor" class="text-editor" aria-labelledby="text-editor-heading">
					<h2 id="text-editor-heading">{m.editor_title()}</h2>
					<p>{m.editor_hint()}</p>
					{#each textLayers as { layer, index }, i (index)}
						<label>
							<span>{m.editor_line({ number: i + 1 })}</span>
							<input
								type="text"
								value={layer.text}
								maxlength="1024"
								spellcheck="false"
								oninput={(event) => editLayerText(index, event.currentTarget.value)}
							/>
						</label>
					{/each}
					{#each qrLayers as { layer, index }, i (index)}
						<label>
							<span>{m.editor_qr_url({ number: i + 1 })}</span>
							<input
								type="text"
								inputmode="url"
								value={layer.text}
								maxlength="2048"
								autocapitalize="off"
								autocomplete="off"
								spellcheck="false"
								required
								oninput={(event) => editLayerText(index, event.currentTarget.value)}
							/>
						</label>
					{/each}
				</aside>
			{/if}
			<div class="preview-stage">
				{#if preview.raster}
					<RasterPreview raster={preview.raster} />
				{:else}
					<div class="empty-state">
						<svg class="image-icon" viewBox="0 0 48 48" aria-hidden="true">
							<rect x="7" y="7" width="34" height="34" rx="4" />
							<circle cx="17" cy="17" r="3" />
							<path d="m8 34 10-10 7 7 7-10 9 11" />
						</svg>
						{#if preview.loading}
							<p role="status">{m.preview_rendering()}</p>
						{:else if preview.error}
							<div role="alert">
								<h1>{m.preview_error_title()}</h1>
								<p>{errorMessages[preview.error]()}</p>
							</div>
						{:else}
							<h1>{m.preview_empty()}</h1>
							<p>{m.preview_empty_hint()}</p>
						{/if}
						{#if !preview.loading}<button class="example-button" onclick={showExample}
								>{m.preview_example()}</button
							>{/if}
					</div>
				{/if}
			</div>
		</div>
		<div class="print-controls">
			{#if preview.raster}<span class="dimensions"
					>{preview.raster.width} × {preview.raster.height} px</span
				>{/if}
			{#if hasEditableLayers}
				<button
					class="edit-button"
					aria-expanded={editing}
					aria-controls="label-text-editor"
					onclick={() => (editing = !editing)}>{m.editor_action()}</button
				>
			{/if}
			<span class="print-hint" class:error={printError || !!printer.error} role="status"
				>{printHint}</span
			>
			<button
				class="print-button"
				disabled={!canPrint}
				onclick={() => void print()}
				aria-label={sending ? m.print_sending() : queued ? m.print_queued() : m.print_action()}
				title={printHint || m.print_action()}
			>
				<svg viewBox="0 0 24 24" aria-hidden="true"
					><path d="M6 8V3h12v5M6 17H3V8h18v9h-3M6 14h12v7H6zM17 11h1" /></svg
				>
			</button>
		</div>
	</main>
</div>

<style>
	:global(body) {
		margin: 0;
		background: #eef1eb;
		color: #202b25;
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
	}
	:global(*) {
		box-sizing: border-box;
	}
	:global(button),
	:global(a),
	:global(summary) {
		-webkit-tap-highlight-color: transparent;
	}
	:global(:focus-visible) {
		outline: 3px solid #519b79;
		outline-offset: 4px;
	}
	.app-shell {
		height: 100dvh;
		display: flex;
		flex-direction: column;
	}
	main {
		position: relative;
		flex: 1;
		min-height: 0;
		background-image: radial-gradient(#bfc9b8 0.7px, transparent 0.7px);
		background-size: 16px 16px;
	}
	.workspace {
		position: absolute;
		inset: 24px 24px 92px;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 24px;
	}
	.workspace.editing {
		grid-template-columns: minmax(240px, 300px) minmax(0, 1fr);
	}
	.preview-stage {
		display: grid;
		place-items: center;
		min-width: 0;
		min-height: 0;
		overflow: auto;
	}
	.text-editor {
		min-width: 0;
		min-height: 0;
		padding: 20px;
		border: 1px solid #dce3d9;
		border-radius: 12px;
		background: #fff;
		overflow: auto;
	}
	.text-editor h2 {
		margin: 0;
		font-size: 15px;
		font-weight: 600;
	}
	.text-editor p {
		margin: 8px 0 20px;
		font-size: 12px;
	}
	.text-editor label {
		display: grid;
		gap: 6px;
		margin-top: 16px;
		font-size: 12px;
		color: #65735e;
	}
	.text-editor input {
		width: 100%;
		min-width: 0;
		padding: 10px;
		border: 1px solid #cbd6c4;
		border-radius: 6px;
		background: #f8faf5;
		color: #202b25;
		font: inherit;
		font-size: 16px;
	}
	.empty-state {
		max-width: 380px;
		padding: 24px;
		text-align: center;
	}
	.image-icon {
		width: 48px;
		height: 48px;
		margin-bottom: 16px;
		fill: none;
		stroke: #7c8b74;
		stroke-width: 1.4;
		stroke-linejoin: round;
	}
	h1 {
		margin: 0;
		font-size: 17px;
		font-weight: 550;
	}
	p {
		color: #6e7b66;
		font-size: 13px;
		line-height: 1.7;
		margin: 10px 0 22px;
	}
	button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 10px;
		padding: 12px 20px;
		border: 1px solid #cbd6c4;
		border-radius: 8px;
		font: inherit;
		font-size: 13px;
		font-weight: 550;
		cursor: pointer;
	}
	.example-button,
	.edit-button {
		color: #315d40;
		background: #f8faf5;
	}
	.example-button:hover,
	.edit-button:hover {
		background: #fff;
		border-color: #8ca47e;
	}
	.print-controls {
		position: absolute;
		right: 24px;
		bottom: 20px;
		left: 24px;
		display: flex;
		align-items: center;
		gap: 16px;
	}
	.dimensions {
		color: #65735e;
		font-size: 12px;
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}
	.print-hint {
		margin-left: auto;
		color: #65735e;
		font-size: 12px;
		text-align: right;
		max-width: 420px;
	}
	.print-hint.error {
		color: #954f2f;
	}
	.print-button {
		flex-shrink: 0;
		width: 48px;
		padding: 12px;
		min-height: 44px;
		color: white;
		background: #315d40;
		border-color: #315d40;
		box-shadow: 0 2px 8px #203d231a;
	}
	.print-button:hover:enabled {
		background: #254b32;
	}
	.print-button:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.print-button svg {
		width: 20px;
		height: 20px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.5;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	@media (max-width: 600px) {
		.workspace {
			inset: 16px 16px 96px;
			gap: 16px;
		}
		.workspace.editing {
			grid-template-columns: minmax(0, 1fr);
			grid-template-rows: minmax(120px, 1fr) minmax(0, 1fr);
		}
		.workspace.editing .preview-stage {
			grid-row: 1;
		}
		.text-editor {
			grid-row: 2;
			padding: 16px;
		}
		.print-controls {
			right: 16px;
			bottom: 16px;
			left: 16px;
			gap: 12px;
		}
		.dimensions {
			display: none;
		}
		.print-hint {
			font-size: 11px;
			max-width: 220px;
		}
	}
</style>
