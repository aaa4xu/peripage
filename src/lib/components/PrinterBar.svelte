<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import type { ResolvedPathname } from '$app/types';
	import { m } from '$lib/paraglide/messages';
	import { getLocale, locales, localizeHref } from '$lib/paraglide/runtime';
	import {
		browserBluetooth,
		PeriPageClient,
		type EventKind,
		type Phase,
		type PrinterState
	} from '$lib/peripagejs';

	let {
		hash = '',
		client,
		printer
	}: {
		hash?: string;
		client: PeriPageClient;
		printer: PrinterState;
	} = $props();
	let support = $state<'checking' | 'available' | 'unsupported' | 'insecure'>('checking');
	const active = $derived(
		['choosing', 'connecting', 'reading', 'connected', 'printing'].includes(printer.phase)
	);
	const connected = $derived(printer.phase === 'connected');
	const selecting = $derived(printer.phase === 'choosing' || printer.phase === 'connecting');
	const unavailable = $derived(support === 'unsupported' || support === 'insecure');
	const warning = $derived(!!printer.error || printer.notice === 'lost');
	const phases: Record<Phase, () => string> = {
		idle: m.printer_idle,
		choosing: m.printer_choosing,
		connecting: m.printer_connecting,
		reading: m.printer_reading,
		connected: m.printer_connected,
		printing: m.print_sending,
		disconnected: m.printer_disconnected,
		error: m.printer_failed
	};
	const events: Record<EventKind, () => string> = {
		choosing: m.printer_choosing,
		connecting: m.printer_connecting,
		reading: m.printer_reading,
		connected: m.printer_connected,
		refreshed: m.printer_refreshed,
		printing: m.print_sending,
		sent: m.print_sent,
		cancelled: m.printer_cancelled,
		user: m.printer_user_disconnect,
		lost: m.printer_lost,
		error: m.printer_failed
	};
	const errorMessages = {
		timeout: m.printer_timeout,
		response: m.printer_bad_response,
		permission: m.printer_permission,
		connection: m.printer_connection_error
	};
	const status = $derived(
		support === 'checking'
			? m.printer_checking()
			: unavailable
				? m.printer_unsupported()
				: printer.notice === 'lost'
					? m.printer_lost()
					: phases[printer.phase]()
	);
	const hint = $derived.by(() => {
		if (support === 'insecure') return m.printer_insecure_hint();
		if (support === 'unsupported') return m.printer_unsupported_hint();
		if (printer.error) return errorMessages[printer.error.code]();
		if (printer.notice === 'lost') return m.printer_lost_hint();
		if (printer.notice === 'user') return m.printer_disconnected_hint();
		if (printer.notice === 'cancelled') return m.printer_cancelled_hint();
		if (printer.notice === 'sent') return m.print_sent();
		if (printer.phase === 'printing') return m.print_sending();
		if (printer.phase === 'choosing') return m.printer_choose_hint();
		if (printer.phase === 'connecting' || printer.phase === 'reading') return m.printer_wait_hint();
		return connected ? m.printer_connected_hint() : m.printer_idle_hint();
	});
	const info = $derived([
		[m.printer_battery(), printer.info.battery === null ? null : `${printer.info.battery}%`],
		[m.printer_model(), printer.info.model],
		[m.printer_firmware(), printer.info.firmware],
		[m.printer_name(), printer.info.name],
		[m.printer_hardware(), printer.info.hardware],
		[m.printer_serial(), printer.info.serial],
		[m.printer_mac(), printer.info.mac]
	]);
	const quickInfo = $derived(info.slice(0, 3).filter(([, value]) => value !== null));

	function time(value: number): string {
		return new Intl.DateTimeFormat(getLocale(), {
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		}).format(value);
	}

	onMount(() => {
		support = !window.isSecureContext
			? 'insecure'
			: browserBluetooth()
				? 'available'
				: 'unsupported';
	});
</script>

<header class="printer-bar">
	<a
		class="wordmark"
		href={`${localizeHref(page.url.pathname)}${hash}` as ResolvedPathname}
		data-sveltekit-reload
		aria-label="PeriPage">peri<span>page</span><span class="brand-dot"></span></a
	>
	{#if active}
		<button
			class="connection"
			popovertarget="printer-details"
			aria-label={`${m.printer_details()}: ${status}`}
			title={hint}
		>
			<span class="status-dot" class:online={connected} class:warning class:pulse={!connected}
			></span>
			<span class="connection-text">
				{#if printer.deviceName}<strong>{printer.deviceName}</strong>{/if}
				<span class="status" role="status">{status}</span>
			</span>
			<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
		</button>
	{:else}
		<button
			class="primary connect-button"
			disabled={support !== 'available'}
			onclick={() => void client.connect()}
			title={unavailable ? hint : m.printer_connect()}
		>
			<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg>
			{m.printer_connect()}
		</button>
	{/if}
	{#if quickInfo.length}
		<dl
			class="quick-info"
			aria-label={m.printer_information()}
			aria-busy={printer.phase === 'reading'}
		>
			{#each quickInfo as [label, value] (label)}
				<div>
					<dt>{label}</dt>
					<dd>{value}</dd>
				</div>
			{/each}
		</dl>
	{/if}
	<div class="actions">
		{#if active}
			<button
				class="secondary"
				onclick={() => client?.disconnect()}
				aria-label={selecting ? m.printer_cancel() : m.printer_disconnect()}
				title={selecting ? m.printer_cancel() : m.printer_disconnect()}
			>
				<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8m0-8-8 8" /></svg>
				<span>{selecting ? m.printer_cancel() : m.printer_disconnect()}</span>
			</button>
		{/if}
	</div>
	<nav aria-label={m.printer_language()}>
		{#each locales as locale (locale)}
			<a
				class:current={getLocale() === locale}
				href={`${localizeHref(page.url.pathname, { locale })}${hash}` as ResolvedPathname}
				data-sveltekit-reload
				aria-current={getLocale() === locale ? 'page' : undefined}>{locale.toUpperCase()}</a
			>
		{/each}
	</nav>
</header>

<section id="printer-details" popover aria-labelledby="printer-details-heading">
	<div class="panel-heading">
		<h2 id="printer-details-heading">{m.printer_information()}</h2>
		<div class="actions">
			<button
				class="icon-button"
				disabled={!connected}
				onclick={() => void client?.refresh()}
				aria-label={m.printer_refresh()}
				title={m.printer_refresh()}
			>
				<svg viewBox="0 0 20 20" aria-hidden="true"
					><path d="M16 8a6.2 6.2 0 1 0-.6 5M16 3v5h-5" /></svg
				>
			</button>
			<button
				class="icon-button"
				popovertarget="printer-details"
				popovertargetaction="hide"
				aria-label={m.printer_close()}
				title={m.printer_close()}
			>
				<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8m0-8-8 8" /></svg>
			</button>
		</div>
	</div>
	<p class="hint" class:warning role={warning ? 'alert' : undefined}>{hint}</p>
	{#if printer.error}
		<details class="error-details">
			<summary>{m.printer_error_details()}</summary>
			<p>{printer.error.detail}</p>
		</details>
	{/if}
	<dl class="details-list" aria-busy={printer.phase === 'reading'}>
		{#each info as [label, value] (label)}
			<div>
				<dt>{label}</dt>
				<dd>{value ?? m.printer_unknown()}</dd>
			</div>
		{/each}
	</dl>
	{#if printer.updatedAt}<p class="updated">
			{m.printer_updated({ time: time(printer.updatedAt) })}
		</p>{/if}
	<details class="activity">
		<summary>{m.printer_activity()} <span>{printer.events.length}</span></summary>
		{#if printer.events.length}
			<ol>
				{#each printer.events.toReversed() as event (event.id)}
					<li>
						<span>{events[event.kind]()}</span><time datetime={new Date(event.at).toISOString()}
							>{time(event.at)}</time
						>
					</li>
				{/each}
			</ol>
		{:else}<p>{m.printer_activity_empty()}</p>{/if}
	</details>
</section>

<style>
	.printer-bar {
		display: flex;
		align-items: center;
		gap: 24px;
		min-height: 68px;
		padding: 12px 28px;
		border-bottom: 1px solid #dce3d9;
		background: #fff;
	}
	.wordmark {
		display: flex;
		align-items: center;
		flex-shrink: 0;
		color: inherit;
		font-size: 23px;
		font-weight: 760;
		letter-spacing: -1.3px;
		text-decoration: none;
	}
	.wordmark > span:first-child {
		font-weight: 430;
	}
	.brand-dot {
		width: 6px;
		height: 6px;
		margin: 9px 0 0 4px;
		background: #397253;
		border-radius: 50%;
	}
	button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 7px;
		min-height: 36px;
		padding: 8px 12px;
		border: 1px solid #dfe5db;
		border-radius: 7px;
		background: #fff;
		color: inherit;
		font: inherit;
		font-size: 12px;
		font-weight: 550;
		cursor: pointer;
		white-space: nowrap;
	}
	button:hover:enabled {
		background: #f0f4ed;
	}
	button:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	svg {
		width: 18px;
		height: 18px;
		flex-shrink: 0;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.5;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.connection {
		justify-content: flex-start;
		min-width: 0;
		max-width: 300px;
		padding-inline: 0;
		border: 0;
		gap: 10px;
		background: transparent;
	}
	.connection-text {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}
	.connection-text strong,
	.status {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.connection-text strong {
		font-size: 12px;
		font-weight: 600;
	}
	.status {
		color: #697666;
		font-weight: 400;
	}
	.status-dot {
		height: 7px;
		width: 7px;
		border-radius: 50%;
		background: #9aa393;
		flex-shrink: 0;
	}
	.status-dot.online {
		background: #397253;
	}
	.status-dot.warning {
		background: #a04c28;
	}
	.pulse {
		animation: pulse 1.4s ease-in-out infinite;
	}
	@keyframes pulse {
		50% {
			opacity: 0.35;
		}
	}
	.quick-info {
		display: flex;
		gap: 20px;
		margin: 0;
		padding-left: 24px;
		border-left: 1px solid #e4e8e0;
		font-size: 11px;
		white-space: nowrap;
	}
	.quick-info div {
		display: flex;
		align-items: center;
		gap: 7px;
	}
	dt {
		color: #73806d;
	}
	dd {
		margin: 0;
	}
	.actions {
		display: flex;
		gap: 6px;
		margin-left: auto;
	}
	.primary {
		color: white;
		border-color: #315d40;
		background: #315d40;
	}
	.primary:hover:enabled {
		background: #254b32;
	}
	.connect-button {
		flex-shrink: 0;
	}
	.icon-button {
		width: 36px;
		padding: 8px;
	}
	nav {
		display: flex;
		gap: 2px;
	}
	nav a {
		color: #737e75;
		padding: 8px;
		font-size: 11px;
		font-weight: 650;
		text-decoration: none;
		border-radius: 5px;
	}
	nav a.current {
		color: #284c37;
		background: #edf1e9;
	}
	#printer-details {
		position: fixed;
		inset: 76px 16px auto auto;
		width: min(420px, calc(100vw - 32px));
		max-height: calc(100dvh - 92px);
		margin: 0;
		padding: 20px;
		border: 1px solid #dce3d9;
		border-radius: 12px;
		background: #fff;
		color: #202b25;
		box-shadow: 0 12px 48px #202b251c;
		font-size: 12px;
		overflow: auto;
	}
	.panel-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	h2 {
		margin: 0;
		font-size: 15px;
		font-weight: 600;
	}
	.hint {
		line-height: 1.65;
		color: #66755e;
	}
	.hint.warning {
		color: #954f2f;
	}
	.details-list {
		margin: 18px 0 0;
	}
	.details-list div {
		display: flex;
		justify-content: space-between;
		gap: 20px;
		padding: 10px 0;
		border-top: 1px solid #edf0e9;
	}
	.details-list dd {
		text-align: right;
		overflow-wrap: anywhere;
		min-width: 0;
	}
	.updated {
		font-size: 11px;
		color: #73806d;
	}
	summary {
		cursor: pointer;
	}
	.error-details p {
		overflow-wrap: anywhere;
		line-height: 1.6;
	}
	.activity {
		border-top: 1px solid #dfe4d9;
		margin-top: 18px;
		padding-top: 16px;
		color: #65735c;
	}
	.activity summary span {
		margin-left: 8px;
		font-variant-numeric: tabular-nums;
	}
	ol {
		list-style: none;
		margin: 12px 0 0;
		padding: 0;
	}
	li {
		display: flex;
		justify-content: space-between;
		gap: 15px;
		padding: 9px 0;
		border-top: 1px solid #edf0e9;
	}
	time {
		color: #73806d;
		font-size: 11px;
		font-variant-numeric: tabular-nums;
	}
	@media (max-width: 1200px) {
		.quick-info {
			gap: 12px;
			padding-left: 16px;
		}
		.quick-info dt {
			display: none;
		}
		.printer-bar {
			gap: 16px;
		}
	}
	@media (max-width: 980px) {
		.quick-info {
			display: none;
		}
		.connection-text {
			display: block;
			text-align: left;
		}
		.connection-text strong,
		.status {
			display: block;
		}
	}
	@media (max-width: 600px) {
		.printer-bar {
			gap: 12px;
			padding: 12px;
		}
		.wordmark {
			display: none;
		}
		.connection {
			flex: 1;
		}
		.actions button span {
			display: none;
		}
		.actions button {
			width: 36px;
			padding: 8px;
		}
		nav a {
			padding-inline: 6px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.pulse {
			animation: none;
		}
	}
</style>
