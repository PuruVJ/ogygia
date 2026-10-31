/**
 * SHARED HOOKS — how plugins (and core) talk to each other: the same way core talks to them. A
 * plugin implements a hook as a method of its server half; anyone calls it through `app`:
 *
 *   app.notify.invalidate(tags)        every implementation runs (resolves when all are done)
 *   app.ask.lastBuild(version)         the first answer that is not `undefined`, in plugin order
 *
 * Nobody implementing a hook is normal: `notify` does nothing, `ask` answers `undefined`. Core owns
 * the common names below; a plugin's own hooks carry its name (`federationThaw`), added by
 * declaration merging:
 *
 *   declare module 'ogygia/plugin' { interface ServerHooks { myThing(x: number): void } }
 *
 * One global slot: every module instance dispatches over the same implementations.
 */

/** The shared hooks. Each is optional on a plugin; the signature is the contract. */
export interface ServerHooks {
	/** Drop every stored page carrying any of `tags` (a peer said they are stale). Never re-announced. */
	invalidate(tags: string[]): void | Promise<void>;
	/** Stored pages were dropped: `tags` names what (`p:<path>`, `s:<source>:<fp>`), or `'all'`. */
	invalidated(tags: string[] | 'all'): void | Promise<void>;
	/** Record `version` as the build the shared store last saw; answer the one before (or undefined). */
	lastBuild(version: string): string | undefined | Promise<string | undefined>;
}

type AnyFn = (...args: unknown[]) => unknown;
type Impl = Record<string, unknown>;

const implementations: Impl[] = ((globalThis as Record<symbol, Impl[] | undefined>)[
	Symbol.for('ogygia.server-hooks.v1')
] ??= []);

/** Core only: a set of hook implementations joins (a plugin's server half, or core's own). Keyed by
 *  identity; returns the leave. */
export function register_hooks(impl: object): () => void {
	const entry = impl as Impl;
	if (!implementations.includes(entry)) implementations.push(entry);
	return () => {
		const at = implementations.indexOf(entry);
		if (at !== -1) implementations.splice(at, 1);
	};
}

export type Notify = {
	[K in keyof ServerHooks]: (...args: Parameters<ServerHooks[K]>) => Promise<void>;
};
export type Ask = {
	[K in keyof ServerHooks]: (
		...args: Parameters<ServerHooks[K]>
	) => Promise<Awaited<ReturnType<ServerHooks[K]>> | undefined>;
};

/** Every implementation of the named hook runs; a failing one is logged, never thrown. */
export const notify: Notify = new Proxy({} as Notify, {
	get:
		(_, name: string) =>
		async (...args: unknown[]): Promise<void> => {
			for (const impl of [...implementations]) {
				const fn = impl[name];
				if (typeof fn !== 'function') continue;
				try {
					await (fn as AnyFn).apply(impl, args);
				} catch (e) {
					console.warn(`[ogygia] a \`${name}\` hook failed —`, e);
				}
			}
		}
});

/** The first implementation that answers something other than `undefined`. */
export const ask: Ask = new Proxy({} as Ask, {
	get:
		(_, name: string) =>
		async (...args: unknown[]): Promise<unknown> => {
			for (const impl of [...implementations]) {
				const fn = impl[name];
				if (typeof fn !== 'function') continue;
				try {
					const answer = await (fn as AnyFn).apply(impl, args);
					if (answer !== undefined) return answer;
				} catch (e) {
					console.warn(`[ogygia] a \`${name}\` hook failed —`, e);
				}
			}
			return undefined;
		}
});
