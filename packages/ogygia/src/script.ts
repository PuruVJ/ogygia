/**
 * Serialize a self-contained function into a blocking inline `<script>` string.
 *
 * csr=false apps routinely need a tiny script that runs BEFORE hydration and first paint — set the
 * theme so there's no dark-mode flash, kick off a deferred font, read an early flag. A normal client
 * import can't do it (islands hydrate later), so you hand-roll a `<script>` string — and a literal
 * `</script>` inside a Svelte component prematurely closes the component's own script, which is why
 * people resort to `String.fromCharCode(60)` tricks. This removes all of that: pass a function, get
 * back a `<script>…</script>` string, and `{@html}` it wherever you want the tag to land — usually
 * `<svelte:head>`, but it's just a string, so it's up to you.
 *
 * The function is inlined via `Function.prototype.toString`, so it must be **self-contained** — only
 * browser globals, no imports and no closed-over variables (they won't exist at runtime). For values
 * you would otherwise close over (a hashed asset URL, a config flag), pass them as trailing `args`;
 * they are JSON-serialized and handed to the function as parameters.
 *
 * @example No-flash theme (no args)
 * ```svelte
 * <svelte:head>
 *   {@html script(() => {
 *     try {
 *       var t = localStorage.getItem('theme');
 *       if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
 *     } catch (e) {}
 *   })}
 * </svelte:head>
 * ```
 *
 * @example Deferred font loader (a URL passed as an arg)
 * ```svelte
 * <svelte:head>
 *   {@html script((href) => {
 *     addEventListener('load', () => {
 *       var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href;
 *       document.head.appendChild(l);
 *     }, { once: true });
 *   }, fontUrl)}
 * </svelte:head>
 * ```
 *
 * @param fn A self-contained function run synchronously, before paint.
 * @param args Serializable values (string/number/boolean/null/plain JSON) passed to `fn` in order.
 * @returns A `<script>…</script>` string to `{@html}` wherever you want the tag.
 */
export function script<A extends unknown[]>(fn: (...args: A) => void, ...args: A): string {
	const call = args.map((a) => JSON.stringify(a)).join(',');
	// Escape any `</script` in the body so it cannot break out of the tag it lives in.
	const body = `(${fn.toString()})(${call});`.replace(/<\/(script)/gi, '<\\/$1');
	return `<script>${body}</script>`;
}
