<script lang="ts">
	// The design system's button: variant classes computed through a classnames helper that
	// splits and re-joins per call, an Icon child, a tracking call on render.
	import Icon from './Icon.svelte';
	import { track } from '../track';
	let { href, icon, variant = 'secondary', size = 'md', children }: { href?: string; icon?: string; variant?: string; size?: string; children?: import('svelte').Snippet } = $props();
	const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ').split(/\s+/).filter((c, i, a) => a.indexOf(c) === i).join(' ');
	const classes = cx('ds-btn', `ds-btn--${variant}`, `ds-btn--${size}`, icon && 'ds-btn--icon');
	const trackId = track('ds.button', { variant, size, icon: icon ?? null, href: href ?? null });
</script>

{#if href}
	<a {href} class={classes} data-track={trackId}>{#if icon}<Icon name={icon} />{/if}{@render children?.()}</a>
{:else}
	<button class={classes} data-track={trackId}>{#if icon}<Icon name={icon} />{/if}{@render children?.()}</button>
{/if}
