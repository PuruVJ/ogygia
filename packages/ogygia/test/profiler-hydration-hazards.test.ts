import { describe, expect, it } from 'vitest';
import { hydration_hazards } from '../src/profiler/hydration-hazards.js';
import { hazard_fix, hazard_words } from '../src/profiler/report.js';

describe('the report says them', () => {
	it('each line by file and line, with what it does; the fix per kind', () => {
		const lines = [
			{ file: 'src/lib/Clock.svelte', line: 3, code: "const where = typeof window === 'undefined' ? 'server' : 'browser';", kind: 'browser' as const, reads: 'typeof window' },
			{ file: 'src/lib/Nav.svelte', line: 9, code: 'const tree = await nav();', kind: 'await' as const }
		];
		expect(hazard_words(lines)).toBe(
			"In its own code, the likeliest: Clock.svelte:3 (`const where = typeof window === 'undefined' ? 'server' : 'browser';`) reads typeof window while rendering, a value the server does not have; Nav.svelte:9 (`const tree = await nav();`) awaits at the top of its script: the browser runs it again, and another answer draws another tree."
		);
		expect(hazard_fix(lines)).toContain('Give both sides the same answer');
		expect(hazard_fix(lines)).toContain('Read the browser-only value after the wake');
	});
});

describe('hydration_hazards: the lines that draw differently in the browser', () => {
	it('a top-level await, a browser value in a derived and in the markup', () => {
		const src = [
			'<script lang="ts">',
			"\timport { page } from '$app/state';",
			'\tlet { site, nav } = $props();',
			'\tconst fetched = nav ? [] : await site.nav();',
			"\tconst top_href = $derived(typeof window !== 'undefined' ? window.location.pathname : '/');",
			'</script>',
			'',
			'<p>Built {Date.now()}</p>',
			'<a href={top_href}>top</a>'
		].join('\n');
		expect(hydration_hazards(src)).toEqual([
			{ line: 4, code: 'const fetched = nav ? [] : await site.nav();', kind: 'await' },
			{ line: 5, code: "const top_href = $derived(typeof window !== 'undefined' ? window.location.pathname : '/');", kind: 'browser', reads: 'typeof window' },
			{ line: 8, code: '<p>Built {Date.now()}</p>', kind: 'browser', reads: 'Date.now(' }
		]);
	});

	it('what runs after the wake is never one: callbacks, effects, handlers, the module script', () => {
		const src = [
			'<script module>',
			'\tconst started = Date.now();',
			'</script>',
			'<script>',
			"\timport { onMount } from 'svelte';",
			'\tlet w = $state(0);',
			'\tonMount(() => {',
			'\t\tw = window.innerWidth;',
			'\t});',
			'\t$effect(() => {',
			'\t\tdocument.title = `x`;',
			'\t});',
			'\tfunction go() {',
			'\t\twindow.scrollTo(0, 0);',
			'\t}',
			'\tconst load = async () => {',
			'\t\tawait fetch(`/x`);',
			'\t};',
			'</script>',
			'<button onclick={() => window.scrollTo(0, 0)}>top {w}</button>',
			'<p>{mywindow.size}</p>'
		].join('\n');
		expect(hydration_hazards(src)).toEqual([]);
	});
});
