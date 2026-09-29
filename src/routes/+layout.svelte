<script lang="ts">
	import type { ResolvedPathname } from '$app/types';
	import { page } from '$app/state';
	import { locales, localizeHref } from '$lib/paraglide/runtime';
	import favicon from '$lib/assets/favicon.svg';
	import faviconDark from '$lib/assets/favicon-dark.svg';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" type="image/svg+xml" href={favicon} media="(prefers-color-scheme: light)" />
	<link rel="icon" type="image/svg+xml" href={faviconDark} media="(prefers-color-scheme: dark)" />
</svelte:head>
{@render children()}

<div style="display:none">
	{#each locales as locale (locale)}
		<!-- Paraglide's URL patterns already include the deployment base path. -->
		<a href={localizeHref(page.url.pathname, { locale }) as ResolvedPathname} data-sveltekit-reload
			>{locale}</a
		>
	{/each}
</div>
