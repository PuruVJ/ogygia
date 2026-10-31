/**
 * Shell context — how bricks inside `<Shell>` find the site without prop threading. `<Shell {site}>`
 * sets it once; a brick reads it, unless given explicit props (standalone use outside the shell).
 * Deliberately tiny: the context carries only `{ site, base }` — bricks derive everything else from
 * the site's plain-data views.
 */
import type { Component } from 'svelte';
import { getContext, setContext } from 'svelte';
import type { Site } from './site.js';

const KEY = Symbol.for('ogygia.content.shell');

/** Element-override map: markdown tag name → the component that renders it (via `SiteSlot`). */
export type ComponentMap = Record<string, Component<Record<string, unknown>>>;

export type ShellContext = {
	/** Optional: absent on the leak-free path (corpus server-only, nav fed as data). Bricks that need
	 *  it (a `SiteSlot` component override) fall back to `components` / plain behavior. */
	site?: Site;
	base: string;
	components?: ComponentMap;
	/** The shell's brand/site name — bricks use it to suffix the document `<title>`. */
	title?: string;
};

export function set_shell_context(ctx: ShellContext): void {
	setContext(KEY, ctx);
}

export function get_shell_context(): ShellContext | undefined {
	return getContext<ShellContext | undefined>(KEY);
}
