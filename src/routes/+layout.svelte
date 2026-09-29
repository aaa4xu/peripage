<script lang="ts">
	import type { ResolvedPathname } from '$app/types';
	import { page } from '$app/state';
	import { locales, localizeHref } from '$lib/paraglide/runtime';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>
{@render children()}

<div style="display:none">
	{#each locales as locale (locale)}
		<!-- Paraglide's URL patterns already include the deployment base path. -->
		<a href={localizeHref(page.url.pathname, { locale }) as ResolvedPathname} data-sveltekit-reload
			>{locale}</a
		>
	{/each}
</div>
