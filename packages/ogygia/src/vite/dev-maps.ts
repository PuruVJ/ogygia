/**
 * THE DEV SERVER'S SOURCE MAPS, FOR THE PROFILER: Vite's module runner evaluates each server module's
 * transformed code inside an `AsyncFunction` (`"use strict";\n` first), with `//# sourceURL=<id>`, so a
 * CPU profile names the module by its id and its lines are the transformed code's, shifted by the
 * function's own header. The map from that code back to the source is in the SSR module graph. This
 * puts a lookup on a global the profiler (loaded by the same process) reads: module id → the map,
 * shifted to the lines V8 reports.
 */
import fs from 'node:fs';
import type { ViteDevServer } from 'vite';
import {
	page_data_keys_answer,
	summarize_export,
	type PageKeys
} from '../compiler/link/page-keys.js';

export const DEV_MAPS = Symbol.for('ogygia.profiler.dev-maps');
export const DEV_PAGE_KEYS = Symbol.for('ogygia.profiler.dev-page-keys');

/** what an island's code reads of `page.data`, as the build would say: its keys, or `'all'` with
 *  the lines that make it so; `null` when nothing in it reads the page */
export interface DevPageKeys {
	keys: string[] | 'all' | null;
	why: { file: string; line: number | null; why: string }[];
}

type SsrNode = { file?: string | null; id?: string | null; importedModules?: Set<SsrNode> };
type SsrGraph = { getModulesByFile(file: string): Set<SsrNode> | undefined };

/**
 * THE BUILD'S SEED ANSWER, ON THE DEV SERVER: the build pins which `page.data` keys each island's
 * code reads (seed shaping); the dev server does not — every island reads "everything" there, so
 * the profiler could not tell a late island's data or point at the line that ships it all. This
 * puts the same analysis behind a global the profiler (same process) asks: the island id's
 * component and the app modules it imports (the SSR graph, eight deep), each read by the build's
 * own `page_data_keys_answer`, a helper handed the page followed one level like the build does.
 * Only what the report says changes: the dev seed itself still ships whole.
 */
export function install_dev_page_keys(
	server: ViteDevServer,
	component_of: (iid: string) => string | null | undefined,
	root: string
): void {
	const ssr = () =>
		(server as unknown as { environments?: Record<string, { moduleGraph?: SsrGraph }> }).environments
			?.ssr?.moduleGraph;
	const app_file = (f: string | null | undefined): f is string =>
		!!f && f.startsWith(root) && !f.includes('/node_modules/');
	const kind = (f: string) => (f.endsWith('.svelte') ? 'svelte' : 'script') as 'svelte' | 'script';
	const read = (f: string) => {
		try {
			return fs.readFileSync(f, 'utf8');
		} catch {
			return undefined;
		}
	};
	(globalThis as Record<symbol, unknown>)[DEV_PAGE_KEYS] = async (
		iid: string
	): Promise<DevPageKeys | undefined> => {
		const component = component_of(iid)?.split('?')[0];
		const graph = ssr();
		if (!component || !graph) return undefined;
		// the component and the app modules below it
		const files: string[] = [];
		const seen = new Set<string>();
		let level: string[] = [component];
		for (let depth = 0; depth < 8 && level.length; depth++) {
			const next: string[] = [];
			for (const f of level) {
				if (seen.has(f)) continue;
				seen.add(f);
				files.push(f);
				for (const node of graph.getModulesByFile(f) ?? [])
					for (const dep of node.importedModules ?? []) {
						const df = dep.file?.split('?')[0];
						if (app_file(df) && !seen.has(df)) next.push(df);
					}
			}
			level = next;
		}
		const read_keys = new Set<string>();
		let all = false;
		let any = false;
		const why: DevPageKeys['why'] = [];
		const add = (k: PageKeys | null) => {
			if (k === null) return;
			any = true;
			if (k === 'all') all = true;
			else for (const x of k) read_keys.add(x);
		};
		for (const f of files) {
			const code = read(f);
			if (!code) continue;
			const a = page_data_keys_answer(code, f, kind(f));
			if (a.keys === 'all' && a.reason) why.push({ file: f, line: a.reason.line, why: a.reason.why });
			add(a.keys);
			// `helper(page)`: what the imported helper reads of it (one level, as the build follows)
			for (const p of a.pending) {
				const resolved = await server.pluginContainer
					.resolveId(p.specifier, f, { ssr: true })
					.catch(() => null);
				const target = resolved?.id?.split('?')[0];
				const tcode = target && app_file(target) ? read(target) : undefined;
				const s = tcode ? summarize_export(tcode, target!, kind(target!), p.imported, p.arg) : 'all';
				if (s === 'all' || !(s instanceof Set)) {
					why.push({ file: f, line: p.line, why: `the page is handed to ${p.imported}(), which the analysis cannot follow` });
					add('all');
				} else add(s);
			}
		}
		return { keys: !any ? null : all ? 'all' : [...read_keys], why };
	};
}

/** lines V8 counts before a module's first line: the `AsyncFunction` header, and `"use strict";` */
function runner_offset(): number {
	const AsyncFunction = (async function () {}).constructor as new (...a: string[]) => () => unknown;
	const src = new AsyncFunction('a', 'b', '/*code*/').toString();
	return src.slice(0, src.indexOf('/*code*/')).split('\n').length - 1 + 1;
}

type MapLike = { version?: number; mappings?: string; [k: string]: unknown };
type Graph = { getModuleById(id: string): { transformResult?: { map?: MapLike | null } | null } | undefined };

export function install_dev_maps(server: ViteDevServer): void {
	const offset = runner_offset();
	const graph = () => {
		const envs = (server as unknown as { environments?: Record<string, { moduleGraph?: Graph }> })
			.environments;
		return envs?.ssr?.moduleGraph;
	};
	(globalThis as Record<symbol, unknown>)[DEV_MAPS] = (id: string): string | undefined => {
		const map = graph()?.getModuleById(id)?.transformResult?.map;
		if (!map || typeof map.mappings !== 'string') return undefined;
		// shifted by the lines in front of the module's own first line
		return JSON.stringify({ ...map, mappings: ';'.repeat(offset) + map.mappings });
	};
}
