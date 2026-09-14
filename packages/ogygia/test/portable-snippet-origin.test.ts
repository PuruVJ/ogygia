// REGRESSION: a portable snippet (a `{#snippet}` that crosses into an island) is re-processed as its
// own entry under a `virtual:ogygia/island/<iid>.svelte` id — that's how a `with { wake }` import
// inside the snippet body becomes a nested island. A virtual id has no directory, so a RELATIVE
// specifier carried into that entry used to resolve against `virtual:ogygia/island/` and bake a
// cwd-relative phantom into the region module:
//   UNRESOLVED_IMPORT: Could not resolve '<root>/virtual:ogygia/Inner.svelte' in virtual:ogygia/region/<iid>.js
// The driver's `resolve_id` already rebases an entry's PLAIN imports against the entry's real origin
// (`hostPath`); the transform now resolves a re-minted MARKED import against that same origin
// (`HostCtx.originOf`), and every record minted during a re-process stamps that origin as its own
// `hostPath` — so a snippet nested inside a snippet inherits the real file, never the outer virtual.
// It only ever bit relative specifiers: `$lib/…` and package specifiers are host-independent, which
// is why every earlier snippet fixture (all `$lib`) sailed through.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { transformHost } from '../src/compiler/region/transform.js';

// ── regexes
/** Any `<something>/virtual:ogygia/<Name>.svelte` — the phantom path the bug used to bake. */
const PHANTOM_VIRTUAL_COMPONENT_RE = /\/virtual:ogygia\/[^/]+\.svelte/;
/** The loud guard: a named `[ogygia]` error citing the virtual host AND the relative specifier. */
const MISSING_ORIGIN_ERROR_RE =
	/\[ogygia\] virtual:ogygia\/island\/[^:]+: cannot resolve the relative import '\.\.\/Inner\.svelte' from a generated module/;
const INNER_G = /Inner/g;

const base_ctx = {
	root: '/app',
	libDir: '/app/src/lib',
	readFile: () => null,
	pathModule: path,
	dev: false,
	virtualPathFor: (_h: string, iid: string) => `virtual:ogygia/island/${iid}.js`,
	wrapperPathFor: (_h: string, iid: string) => `virtual:ogygia/wrapper/${iid}.svelte`,
	devUrlFor: (p: string) => p,
	visibleMargin: '200px',
	presets: {},
	importKeys: {},
	idSalt: '',
	clientBindingStub: 'virtual:ogygia/client-binding-stub',
	routeCsr: undefined
};

type Island = {
	id: string;
	source?: string;
	virtualPath?: string;
	componentPath?: string | null;
	hostPath?: string | null;
	portable?: boolean;
	wrapperSource?: string;
	bindingSsrSource?: string;
};
type Result = { islands?: Island[] } | null;

/** The hole lives in a SUBDIR on purpose — `../` must climb out of THIS file's directory. */
const HOST_ID = '/app/src/lib/holes/Hole.svelte';
const REAL_INNER = '/app/src/lib/Inner.svelte';
const REAL_SIBLING = '/app/src/lib/holes/Sibling.svelte';

/** Mirror the driver: an entry's origin is the file its slice was cut from — read off the records
 *  the previous pass minted (`hostPath`), followed transitively with a visited set (no depth cap). */
function origin_map(islands: Island[]): Map<string, string> {
	const m = new Map<string, string>();
	for (const i of islands) if (i.virtualPath && i.hostPath) m.set(i.virtualPath, i.hostPath);
	return m;
}
function with_origins(origins: Map<string, string>) {
	return {
		...base_ctx,
		originOf: (id: string) => {
			let cur = id;
			const seen = new Set<string>([cur]);
			for (;;) {
				const next = origins.get(cur);
				if (!next || seen.has(next)) break;
				seen.add(next);
				cur = next;
			}
			return cur;
		}
	};
}
function portable_entries(r: Result): Island[] {
	return (r?.islands ?? []).filter((i) => i.portable === true && !!i.source && !!i.virtualPath);
}
/** Re-process a portable entry the way the driver's transform hook does: under its virtual id. */
function reprocess(entry: Island, origins: Map<string, string>): Result {
	return transformHost(entry.source!, entry.virtualPath!, {
		...with_origins(origins),
		ssr: true
	}) as Result;
}
function all_sources(r: Result): string {
	return (r?.islands ?? [])
		.flatMap((i) => [i.source, i.wrapperSource, i.bindingSsrSource])
		.filter(Boolean)
		.join('\n');
}
function component_paths(r: Result): Array<string | null | undefined> {
	return (r?.islands ?? []).map((i) => i.componentPath);
}

// ── the reported shape: a plain (unmarked) shell receives a 0-arg snippet holding a `../` island ──
const PLAIN_SITE_PARENT = `<script>
	import Inner from '../Inner.svelte' with { wake: 'load' };
	import Shell from './Shell.svelte';
</script>
<Shell>
	{#snippet panel()}<div><Inner label="in-snippet" /></div>{/snippet}
</Shell>
`;

describe('portable snippet — a relative marked import inside the snippet resolves against the REAL origin', () => {
	it("plain site, 0-arg snippet, '../' (the reported build failure)", () => {
		const first = transformHost(PLAIN_SITE_PARENT, HOST_ID, { ...base_ctx, ssr: true }) as Result;
		const [entry] = portable_entries(first);
		expect(entry, 'the snippet must portable-ize into its own entry').toBeTruthy();
		// The slice carries the ORIGINAL import verbatim (so the entry's own pass can re-mark it) …
		expect(entry.source).toContain(`'../Inner.svelte'`);
		// … and re-processing it under the virtual id must land on the real file.
		const second = reprocess(entry, origin_map(first?.islands ?? []));
		expect(
			component_paths(second),
			`expected an island whose componentPath is ${REAL_INNER}`
		).toContain(REAL_INNER);
		expect(all_sources(second)).not.toContain('virtual:ogygia/Inner.svelte');
		expect(all_sources(second)).not.toMatch(PHANTOM_VIRTUAL_COMPONENT_RE);
	});

	it("'./' sibling of the host (same directory)", () => {
		const host = PLAIN_SITE_PARENT.replace(`'../Inner.svelte'`, `'./Sibling.svelte'`).replace(
			INNER_G,
			'Sibling'
		);
		const first = transformHost(host, HOST_ID, { ...base_ctx, ssr: true }) as Result;
		const [entry] = portable_entries(first);
		expect(entry).toBeTruthy();
		const second = reprocess(entry, origin_map(first?.islands ?? []));
		expect(component_paths(second)).toContain(REAL_SIBLING);
		expect(all_sources(second)).not.toMatch(PHANTOM_VIRTUAL_COMPONENT_RE);
	});

	it('hydrate-ISLAND site, PARAMETERIZED snippet (any arity crosses there)', () => {
		const host = `<script>
	import Inner from '../Inner.svelte' with { wake: 'load' };
	import List from './List.svelte' with { wake: 'visible' };
</script>
<List>
	{#snippet item(n)}<Inner label={'row ' + n} />{/snippet}
</List>
`;
		const first = transformHost(host, HOST_ID, { ...base_ctx, ssr: true }) as Result;
		const [entry] = portable_entries(first);
		expect(entry, 'a parameterized snippet at an island site must portable-ize').toBeTruthy();
		const second = reprocess(entry, origin_map(first?.islands ?? []));
		expect(component_paths(second)).toContain(REAL_INNER);
		expect(all_sources(second)).not.toMatch(PHANTOM_VIRTUAL_COMPONENT_RE);
	});

	it('a snippet NESTED inside a portable snippet inherits the real origin (two re-process hops)', () => {
		const host = `<script>
	import Inner from '../Inner.svelte' with { wake: 'load' };
	import Shell from './Shell.svelte';
	import Card from './Card.svelte';
</script>
<Shell>
	{#snippet panel()}
		<Card>
			{#snippet body()}<Inner label="deep" />{/snippet}
		</Card>
	{/snippet}
</Shell>
`;
		const first = transformHost(host, HOST_ID, { ...base_ctx, ssr: true }) as Result;
		const [outer] = portable_entries(first);
		expect(outer).toBeTruthy();
		// Hop 1: re-process the OUTER entry — it mints the INNER portable entry. That inner record must
		// carry the REAL origin as hostPath, not the outer's virtual id.
		const origins = origin_map(first?.islands ?? []);
		const hop1 = reprocess(outer, origins);
		const [inner] = portable_entries(hop1);
		expect(inner, 'the nested snippet must portable-ize during the outer re-process').toBeTruthy();
		expect(inner.hostPath).toBe(HOST_ID);
		// Hop 2: re-process the INNER entry (origins now include hop-1 records) — the island resolves.
		for (const [k, v] of origin_map(hop1?.islands ?? [])) origins.set(k, v);
		const hop2 = reprocess(inner, origins);
		expect(component_paths(hop2)).toContain(REAL_INNER);
		expect(all_sources(hop2)).not.toMatch(PHANTOM_VIRTUAL_COMPONENT_RE);
	});
});

describe('portable snippet — what already worked keeps working, and identity is stable', () => {
	it('`$lib/…` and package specifiers inside the snippet are untouched (host-independent)', () => {
		const host = `<script>
	import Inner from '$lib/Inner.svelte' with { wake: 'load' };
	import Pkg from 'some-pkg/Widget.svelte' with { wake: 'idle' };
	import Shell from './Shell.svelte';
</script>
<Shell>
	{#snippet panel()}<Inner /><Pkg />{/snippet}
</Shell>
`;
		const first = transformHost(host, HOST_ID, { ...base_ctx, ssr: true }) as Result;
		const [entry] = portable_entries(first);
		expect(entry).toBeTruthy();
		const second = reprocess(entry, origin_map(first?.islands ?? []));
		const paths = component_paths(second);
		expect(paths).toContain(REAL_INNER); // $lib → libDir join
		expect(paths).toContain('some-pkg/Widget.svelte'); // package spec → verbatim
	});

	it('the SAME island placed directly and inside the snippet dedupes to ONE id (relative form)', () => {
		const host = `<script>
	import Inner from '../Inner.svelte' with { wake: 'load' };
	import Shell from './Shell.svelte';
</script>
<Inner label="direct" />
<Shell>
	{#snippet panel()}<Inner label="in-snippet" />{/snippet}
</Shell>
`;
		const first = transformHost(host, HOST_ID, { ...base_ctx, ssr: true }) as Result;
		const direct = (first?.islands ?? []).find(
			(i) => i.componentPath === REAL_INNER && i.portable !== true
		);
		expect(direct, 'the direct placement mints the island on the host').toBeTruthy();
		const [entry] = portable_entries(first);
		const second = reprocess(entry, origin_map(first?.islands ?? []));
		const nested = (second?.islands ?? []).find((i) => i.componentPath === REAL_INNER);
		expect(nested).toBeTruthy();
		// Same component + same mark ⇒ same identity ⇒ same iid: one wrapper, one client chunk.
		expect(nested!.id).toBe(direct!.id);
	});

	it('the portable entry identity does not depend on the machine (no absolute path in the hash input)', () => {
		// Two roots, same authored source: the entry ids must match — the slice hashes the AUTHORED
		// import text, and the origin only steers RESOLUTION. (Protects the deterministic chunk names
		// SSR bakes into `<ogygia-region entry>` from drifting between a laptop and CI.)
		const a = transformHost(PLAIN_SITE_PARENT, '/app/src/lib/holes/Hole.svelte', {
			...base_ctx,
			root: '/app',
			libDir: '/app/src/lib',
			ssr: true
		}) as Result;
		const b = transformHost(PLAIN_SITE_PARENT, '/ci/src/lib/holes/Hole.svelte', {
			...base_ctx,
			root: '/ci',
			libDir: '/ci/src/lib',
			ssr: true
		}) as Result;
		expect(portable_entries(a)[0]?.id).toBeTruthy();
		expect(portable_entries(a)[0]?.id).toBe(portable_entries(b)[0]?.id);
	});
});

describe('portable snippet — the missing-origin case is LOUD, not a silent phantom path', () => {
	it('re-processing under a virtual id with no origin threaded throws a named [ogygia] error', () => {
		const first = transformHost(PLAIN_SITE_PARENT, HOST_ID, { ...base_ctx, ssr: true }) as Result;
		const [entry] = portable_entries(first);
		expect(entry).toBeTruthy();
		// No `originOf` at all — the legacy ctx shape. Must not produce `<cwd>/virtual:ogygia/...`.
		expect(() =>
			transformHost(entry.source!, entry.virtualPath!, { ...base_ctx, ssr: true })
		).toThrow(MISSING_ORIGIN_ERROR_RE);
	});
});
