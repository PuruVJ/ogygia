<script lang="ts">
	/**
	 * The element-override slot. The markdown compiler rewrites overridable tags (`[x](y)` →
	 * `<Og__Slot tag="a" href="y">x`) into this ONE component; here — at render, in app-land — we
	 * look the tag up in the site's component map and render that component, else the plain element.
	 *
	 * The map holds real component VALUES and lives in `sitekit(outline, { components })`, reaching us
	 * via the shell context. No import paths in config; the compiler only ever knew the tag NAMES.
	 * Built-in default: `a → Link` (id-form + redirect-aware links for plain markdown, zero config).
	 */
	import type { Component, Snippet } from 'svelte';
	import { get_shell_context } from '../context.js';
	import Link from './Link.svelte';

	let { tag, children, ...rest }: { tag: string; children?: Snippet } & Record<string, unknown> = $props();

	const DEFAULTS: Record<string, Component<Record<string, unknown>>> = { a: Link as Component<Record<string, unknown>> };
	const map = get_shell_context()?.components ?? {};
	const Comp = $derived(map[tag] ?? DEFAULTS[tag]);
</script>

{#if Comp}
	<Comp {...rest}>{@render children?.()}</Comp>
{:else}
	<svelte:element this={tag} {...rest}>{@render children?.()}</svelte:element>
{/if}
