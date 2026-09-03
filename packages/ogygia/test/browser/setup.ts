// Browser-project globalSetup (runs in NODE, once): server-render the fixture islands exactly as a
// page would carry them — the component's SSR HTML inside an `<ogygia-region>` shell plus the
// devalue props sidecar — and hand the strings to the browser tests through `provide()`. The tests
// drop that HTML into the document and boot the real runtime, so what hydrates is the real island
// contract (attributes, sidecar, adoption), not a mounted component.
//
// Provided values ride into the browser inside an inline `<script>` of Vitest's orchestrator page.
// A literal `</script>` in the HTML (the props sidecar!) would close that script early and leave
// `window.__vitest_browser_runner__` unset — the "Failed to connect to the browser session" trap.
// So every HTML string is provided base64-encoded; `inject_html()` in the test decodes it.
import type { TestProject } from 'vitest/node';
import { render } from 'svelte/server';
import { stringify } from 'devalue';
import Counter from './fixtures/Counter.svelte';

/** The island shell a page carries: the runtime reads `wake` + `entry`, then the props sidecar. */
function island(entry: string, body: string, props: Record<string, unknown>, wake = 'load') {
	return (
		`<ogygia-region wake="${wake}" entry="${entry}">${body}</ogygia-region>` +
		`<script type="application/ogygia-props" data-ogygia-props>${stringify(props)}</script>`
	);
}

const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64');

// The runtime hydrates a top-level island through NestedProvider (`{#if Component}<Component/>{/if}`),
// so a real region's SSR content is `<!--[0-->` (the if-branch) + `<!--[-->` (the dynamic component)
// + html + `<!--]--><!--]-->` — empirically `<!--[0--><!--[-->…` (see test/region-attrs.test.ts). The
// outermost envelope the runtime inserts itself at hydrate. `render()` gives us the component wrapped
// in ONE anchor pair, which stands in for the dynamic-component pair; add the if-branch pair around it.
const nested = (body: string) => `<!--[0-->${body}<!--]-->`;

declare module 'vitest' {
	export interface ProvidedContext {
		/** A `wake: 'load'` Counter island, SSR'd with `start: 3` — base64 of the HTML. */
		counter_ssr_b64: string;
	}
}

export default function setup(project: TestProject) {
	const props = { start: 3 };
	const { body } = render(Counter, { props });
	// Root-relative: the browser project's Vite server serves the package root, and the svelte plugin
	// compiles the `.svelte` on import — a real `import(entry)` through `island_module_url`.
	project.provide(
		'counter_ssr_b64',
		b64(island('/test/browser/fixtures/Counter.svelte', nested(body), props))
	);
}
