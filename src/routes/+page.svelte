<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import type { ResolvedPathname } from '$app/types';
	import { m } from '$lib/paraglide/messages';
	import { getLocale, locales, localizeHref } from '$lib/paraglide/runtime';
	import {
		browserBluetooth,
		initialState,
		PeriPageClient,
		type EventKind,
		type Phase
	} from '$lib/peripage/client';

	let client: PeriPageClient | undefined;
	let printer = $state.raw(initialState());
	let support = $state<'checking' | 'available' | 'unsupported' | 'insecure'>('checking');
	const active = $derived(
		['choosing', 'connecting', 'reading', 'connected'].includes(printer.phase)
	);
	const connected = $derived(printer.phase === 'connected');
	const selecting = $derived(printer.phase === 'choosing' || printer.phase === 'connecting');
	const unavailable = $derived(support === 'unsupported' || support === 'insecure');
	const phases: Record<Phase, () => string> = {
		idle: m.printer_idle,
		choosing: m.printer_choosing,
		connecting: m.printer_connecting,
		reading: m.printer_reading,
		connected: m.printer_connected,
		disconnected: m.printer_disconnected,
		error: m.printer_failed
	};
	const events: Record<EventKind, () => string> = {
		choosing: m.printer_choosing,
		connecting: m.printer_connecting,
		reading: m.printer_reading,
		connected: m.printer_connected,
		refreshed: m.printer_refreshed,
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
		if (printer.phase === 'choosing') return m.printer_choose_hint();
		if (printer.phase === 'connecting' || printer.phase === 'reading') return m.printer_wait_hint();
		return connected ? m.printer_connected_hint() : m.printer_idle_hint();
	});

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
		client = new PeriPageClient();
		const unsubscribe = client.subscribe((next) => {
			printer = next;
		});
		const disconnect = () => client?.disconnect();
		window.addEventListener('pagehide', disconnect);
		return () => {
			window.removeEventListener('pagehide', disconnect);
			unsubscribe();
			client?.dispose();
		};
	});
</script>

<svelte:head>
	<title>PeriPage — {m.printer_title()}</title>
	<meta name="description" content={m.printer_intro()} />
</svelte:head>

<main>
	<header class="topbar">
		<a
			class="wordmark"
			href={localizeHref(page.url.pathname) as ResolvedPathname}
			data-sveltekit-reload
			aria-label="PeriPage">peri<span>page</span><span class="brand-dot"></span></a
		>
		<nav aria-label={m.printer_language()}>
			{#each locales as locale (locale)}
				<a
					class:current={getLocale() === locale}
					href={localizeHref(page.url.pathname, { locale }) as ResolvedPathname}
					data-sveltekit-reload
					aria-current={getLocale() === locale ? 'page' : undefined}>{locale.toUpperCase()}</a
				>
			{/each}
		</nav>
	</header>

	<section class="intro">
		<p class="eyebrow">{m.printer_transport()}</p>
		<h1>{m.printer_title()}</h1>
		<p>{m.printer_intro()}</p>
	</section>

	<section class="connection-card" aria-labelledby="connection-heading">
		<div class="printer-icon" class:online={connected}>
			<svg
				viewBox="0 0 64 64"
				fill="none"
				stroke="currentColor"
				stroke-width="2.2"
				aria-hidden="true"
			>
				<path
					d="M19 22V9h26v13M19 44H11a4 4 0 0 1-4-4V26a4 4 0 0 1 4-4h42a4 4 0 0 1 4 4v14a4 4 0 0 1-4 4h-8"
					stroke-linejoin="round"
				/>
				<path d="M19 35h26v21H19zM25 42h14M25 48h10" stroke-linecap="round" />
				<circle cx="47" cy="29" r="1.7" fill="currentColor" stroke="none" />
			</svg>
		</div>
		<div class="connection-copy">
			<p class="section-label" id="connection-heading">{m.printer_connection()}</p>
			<h2>{printer.deviceName ?? 'PeriPage'}</h2>
			<div
				class="status"
				class:online={connected}
				class:warning={!!printer.error || printer.notice === 'lost'}
				role="status"
				aria-live="polite"
			>
				<span class="status-dot" class:pulse={active && !connected}></span>{status}
			</div>
		</div>
		<div class="actions">
			{#if active}
				<button class="primary" disabled={!connected} onclick={() => void client?.refresh()}
					>{m.printer_refresh()}</button
				>
				<button class="secondary" onclick={() => client?.disconnect()}
					>{selecting ? m.printer_cancel() : m.printer_disconnect()}</button
				>
			{:else}
				<button
					class="primary"
					disabled={support !== 'available'}
					onclick={() => void client?.connect()}
				>
					<span aria-hidden="true">＋</span>
					{printer.phase === 'idle' ? m.printer_connect() : m.printer_reconnect()}
				</button>
			{/if}
		</div>
		<div
			class="connection-note"
			class:warning={!!printer.error || printer.notice === 'lost'}
			role={printer.error || printer.notice === 'lost' ? 'alert' : undefined}
		>
			<p>{hint}</p>
			{#if printer.error}
				<details class="error-details">
					<summary>{m.printer_error_details()}</summary>
					<p>{printer.error.detail}</p>
				</details>
			{/if}
		</div>
	</section>

	<section
		class="information"
		aria-labelledby="information-heading"
		aria-busy={printer.phase === 'reading'}
	>
		<div class="section-heading">
			<div>
				<h2 id="information-heading">{m.printer_information()}</h2>
				<p>{m.printer_information_hint()}</p>
			</div>
			{#if printer.updatedAt}<span class="updated"
					>{m.printer_updated({ time: time(printer.updatedAt) })}</span
				>{/if}
		</div>
		<dl class="info-grid">
			<div class="info-cell battery">
				<dt>{m.printer_battery()}</dt>
				<dd>{printer.info.battery === null ? '—' : `${printer.info.battery}%`}</dd>
				<div class="battery-track" aria-hidden="true">
					<span style:width={`${printer.info.battery ?? 0}%`}></span>
				</div>
			</div>
			<div class="info-cell">
				<dt>{m.printer_model()}</dt>
				<dd>{printer.info.model ?? '—'}</dd>
			</div>
			<div class="info-cell">
				<dt>{m.printer_firmware()}</dt>
				<dd>{printer.info.firmware ?? '—'}</dd>
			</div>
		</dl>
		<details class="device-details">
			<summary>{m.printer_details()}</summary>
			<dl class="details-grid">
				<div>
					<dt>{m.printer_name()}</dt>
					<dd>{printer.info.name ?? m.printer_unknown()}</dd>
				</div>
				<div>
					<dt>{m.printer_hardware()}</dt>
					<dd>{printer.info.hardware ?? m.printer_unknown()}</dd>
				</div>
				<div>
					<dt>{m.printer_serial()}</dt>
					<dd>{printer.info.serial ?? m.printer_unknown()}</dd>
				</div>
				<div>
					<dt>{m.printer_mac()}</dt>
					<dd>{printer.info.mac ?? m.printer_unknown()}</dd>
				</div>
			</dl>
		</details>
	</section>

	<section class="activity" aria-labelledby="activity-heading">
		<div class="section-heading">
			<h2 id="activity-heading">{m.printer_activity()}</h2>
			<span class="event-count">{printer.events.length.toString().padStart(2, '0')}</span>
		</div>
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
		{:else}<p class="empty-history">{m.printer_activity_empty()}</p>{/if}
	</section>
</main>

<style>
	:global(body) {
		margin: 0;
		background: #f5f6f3;
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
	main {
		max-width: 1060px;
		margin: 0 auto;
		padding: 0 40px 48px;
	}
	.topbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: 94px;
		border-bottom: 1px solid #dfe4dd;
	}
	.wordmark {
		display: flex;
		align-items: center;
		color: inherit;
		font-size: 25px;
		font-weight: 760;
		letter-spacing: -1.4px;
		text-decoration: none;
	}
	.wordmark > span:first-child {
		font-weight: 430;
	}
	.brand-dot {
		width: 7px;
		height: 7px;
		margin: 11px 0 0 5px;
		background: #397253;
		border-radius: 50%;
	}
	nav {
		display: flex;
		gap: 6px;
	}
	nav a {
		color: #737e75;
		padding: 8px 10px;
		font-size: 12px;
		font-weight: 650;
		text-decoration: none;
		border-radius: 6px;
	}
	nav a.current {
		color: #284c37;
		background: #e5ebe3;
	}
	.intro {
		padding: 38px 0 29px;
	}
	.eyebrow {
		color: #66776a;
		font-size: 10px;
		font-weight: 650;
		letter-spacing: 1.8px;
	}
	h1 {
		margin: 13px 0 10px;
		font-size: clamp(26px, 3.6vw, 36px);
		letter-spacing: -1.1px;
		font-weight: 650;
		line-height: 1.16;
	}
	.intro > p:last-child {
		margin: 0;
		font-size: 14px;
		color: #6a756d;
		line-height: 1.6;
	}
	.connection-card {
		display: grid;
		grid-template-columns: 80px 1fr auto;
		gap: 22px;
		align-items: center;
		border: 1px solid #dce3d9;
		border-radius: 14px;
		padding: 27px;
		background: #fff;
	}
	.printer-icon {
		width: 80px;
		height: 80px;
		display: grid;
		place-items: center;
		background: #f0f3ed;
		color: #83907f;
		border-radius: 14px;
	}
	.printer-icon.online {
		background: #e8f1e9;
		color: #386847;
	}
	.printer-icon svg {
		width: 48px;
		height: 48px;
	}
	.section-label {
		color: #738071;
		margin: 0 0 7px;
		font-size: 12px;
	}
	.connection-copy h2 {
		margin: 0 0 9px;
		font-size: 21px;
		font-weight: 620;
		overflow-wrap: anywhere;
	}
	.status {
		display: flex;
		align-items: center;
		gap: 7px;
		color: #727a72;
		font-size: 12px;
	}
	.status.online {
		color: #347149;
	}
	.status.warning {
		color: #a04c28;
	}
	.status-dot {
		height: 6px;
		width: 6px;
		border-radius: 50%;
		background: currentColor;
		flex-shrink: 0;
	}
	.pulse {
		animation: pulse 1.4s ease-in-out infinite;
	}
	@keyframes pulse {
		50% {
			opacity: 0.35;
		}
	}
	.actions {
		display: flex;
		flex-direction: column;
		gap: 7px;
		align-items: stretch;
	}
	button {
		font: inherit;
		border: 1px solid transparent;
		border-radius: 7px;
		padding: 12px 18px;
		cursor: pointer;
		font-size: 12px;
		font-weight: 620;
		transition: background 0.15s;
	}
	.primary {
		color: white;
		background: #315d40;
	}
	.primary:hover:enabled {
		background: #254b32;
	}
	.secondary {
		color: #6b746b;
		background: white;
		border-color: #dfe5db;
		padding-block: 9px;
	}
	.secondary:hover {
		background: #f6f8f3;
	}
	button:disabled {
		opacity: 0.42;
		cursor: not-allowed;
	}
	.connection-note {
		grid-column: 1 / -1;
		margin: 0 -27px -27px;
		padding: 14px 27px;
		border-top: 1px solid #e8ece5;
		background: #fbfcf9;
		border-radius: 0 0 14px 14px;
		color: #6b776b;
		font-size: 12px;
		line-height: 1.6;
	}
	.connection-note p {
		margin: 0;
	}
	.connection-note.warning {
		color: #954f2f;
		background: #fff9f2;
	}
	.error-details {
		margin-top: 9px;
	}
	.error-details p {
		padding-top: 8px;
		overflow-wrap: anywhere;
	}
	.section-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		margin: 28px 0 16px;
	}
	.section-heading h2 {
		margin: 0;
		font-size: 15px;
		font-weight: 650;
	}
	.section-heading p {
		margin: 5px 0 0;
		color: #80887e;
		font-size: 12px;
	}
	.updated {
		color: #858d81;
		font-size: 11px;
		white-space: nowrap;
	}
	dl {
		margin: 0;
	}
	.info-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 12px;
	}
	.info-cell {
		border: 1px solid #e1e6dc;
		border-radius: 10px;
		background: #fbfcf9;
		padding: 20px;
		min-height: 118px;
	}
	dt {
		font-size: 12px;
		color: #778272;
	}
	dd {
		margin: 16px 0 0;
		font-size: 20px;
		color: #394d37;
		letter-spacing: -0.4px;
		overflow-wrap: anywhere;
	}
	.battery-track {
		width: 68px;
		height: 3px;
		background: #e0e7d9;
		border-radius: 3px;
		margin-top: 10px;
	}
	.battery-track span {
		display: block;
		height: 100%;
		background: #638f53;
		border-radius: inherit;
	}
	.device-details {
		margin: 15px 0 0;
		font-size: 12px;
		color: #6c7c62;
	}
	summary {
		cursor: pointer;
		width: fit-content;
	}
	.details-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 20px;
		padding: 22px 0 3px;
	}
	.details-grid dd {
		font-size: 14px;
		margin-top: 7px;
		letter-spacing: 0;
	}
	.activity {
		border-top: 1px solid #dfe4d9;
		margin-top: 25px;
	}
	.activity .section-heading {
		margin-top: 20px;
	}
	.event-count {
		color: #8b9484;
		font-size: 11px;
		font-variant-numeric: tabular-nums;
	}
	.empty-history {
		color: #88927f;
		font-size: 12px;
	}
	ol {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	li {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 15px;
		padding: 10px 0;
		border-top: 1px solid #e7ebe1;
		font-size: 12px;
		color: #626f58;
	}
	time {
		font-size: 11px;
		color: #8d9585;
		font-variant-numeric: tabular-nums;
	}
	@media (prefers-reduced-motion: reduce) {
		.pulse {
			animation: none;
		}
	}
	@media (max-width: 640px) {
		main {
			padding: 0 20px 32px;
		}
		.topbar {
			height: 75px;
		}
		.intro {
			padding-top: 28px;
		}
		.connection-card {
			grid-template-columns: 60px 1fr;
			padding: 20px;
			gap: 16px;
		}
		.printer-icon {
			width: 60px;
			height: 60px;
		}
		.printer-icon svg {
			width: 40px;
			height: 40px;
		}
		.actions {
			grid-column: 1 / -1;
			flex-direction: row;
		}
		.actions button {
			flex: 1;
		}
		.connection-note {
			margin: 0 -20px -20px;
			padding: 14px 20px;
		}
		.info-grid {
			grid-template-columns: 1fr;
			gap: 8px;
		}
		.info-cell {
			display: flex;
			justify-content: space-between;
			align-items: center;
			gap: 12px;
			min-height: 65px;
			padding: 18px;
		}
		.info-cell dd {
			margin: 0;
			font-size: 17px;
		}
		.battery-track {
			display: none;
		}
		.section-heading {
			align-items: flex-start;
			flex-direction: column;
			gap: 8px;
		}
		.activity .section-heading {
			flex-direction: row;
		}
	}
</style>
