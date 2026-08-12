/** Raw snippets for docs / playground — highlighted at build by `snippets.remote.ts`. */

export const viteConfig = `import { sveltekit } from '@sveltejs/kit/vite';
import { ogygia } from 'ogygia/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    ogygia(), // before sveltekit()
    sveltekit()
  ]
});`;

/** Full `ogygia()` options — docs Plugin config section. */
export const pluginConfig = `import { sveltekit } from '@sveltejs/kit/vite';
import { ogygia } from 'ogygia/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    ogygia({
      visible: { margin: '200px' },
      presets: {
        chart: { wake: 'visible', margin: '200px' },
        modal: { wake: 'idle' },
        live: {
          render: 'live',
          wake: 'idle',
          maxAge: '10m'
        }
      },
      rateLimit: { max: 60, windowMs: 60_000 },
      regionTtl: 3600 // seconds; default 1h
      // sessionCookie: 'sessionid' // bind personalized defer/SWR holes
      // importKeys: { wake: 'ogygiaHydrate' } // only if another tool claims \`hydrate\`
    }),
    sveltekit()
  ]
});`;

export const layoutAndHooks = `// src/hooks.server.ts
import { sequence } from '@sveltejs/kit/hooks';
import * as ogygia from 'ogygia/server';

export const handle = sequence(ogygia.handle(), myOtherHandle);

// On each route (or layout) you convert to islands:
// src/routes/marketing/+page.ts
export const csr = false;`;

/** Gradual migration — router is global (plugin), convert routes one at a time. */
export const adoptionMigrate = `// vite.config.ts — the SPA router is on by default, app-wide
import { ogygia } from 'ogygia/vite';
export default { plugins: [ogygia(), sveltekit()] };

// src/routes/blog/+page.ts — convert one route at a time
export const csr = false;

// src/routes/blog/+page.svelte
<script>
  import Comments from '$lib/Comments.svelte' with { wake: 'visible' };
</script>

<article>…SSR content…</article>
<Comments />

// src/routes/dashboard/+page.ts — leave alone (Kit default)
// no \`csr = false\` → full Kit client, router stays idle`;

export const authoringImports = `<script>
  import Counter  from '$lib/Counter.svelte'  with { wake: 'load' };     // island
  import Chart    from '$lib/Chart.svelte'    with { wake: 'visible' }; // island, later
  import Drawer   from '$lib/Drawer.svelte'   with { wake: '(max-width: 600px)' };
  import Report   from '$lib/Report.svelte'   with { wake: 'none' };    // lake (inside an island)
  import Greeting from '$lib/Greeting.svelte' with { render: 'deferred' };      // server island
  import Panel    from '$lib/Panel.svelte'    with { preset: 'chart' };
</script>

<Counter start={10} />`;

export const fragmentSearch = `<script>
  // the server picks the component; the client just paints it
  import { Region } from 'ogygia';
  import { search } from './search.remote';

  let q = $state('svelte');
  let result = $state(null);
</script>

<button onclick={async () => (result = await search(q))}>
  Search
</button>

{#if result}
  <Region of={result} />
{/if}`;

export const livePartial = `// tick.remote.ts — the server pushes rendered HTML each second.
// \`yield\` awaits the partial, so its HTML rides the ticket (no fetch).
export const liveTick = query.live(async function* () {
  let n = 1;
  while (true) {
    yield region(Tick, { n: n++, at: new Date().toISOString() });
    await new Promise((r) => setTimeout(r, 1000));
  }
});

// the island just paints the latest tick — static partials morph in place
<Region of={liveTick().current} />`;

export const sharedObject = `// cart.svelte.ts — a live class that can cross island boundaries
import * as ogygia from 'ogygia';

export class Cart {
  items = $state([]);
  get count() { return this.items.length; }
  add(item) { this.items.push(item); }

  // the whole opt-in: how this instance travels as a prop
  static [ogygia.wire] = {
    encode: (c) => $state.snapshot(c.items),
    decode: (items) => Object.assign(new Cart(), { items }),
  };
}

// page.svelte — one instance, handed to two separate islands
const cart = new Cart();
<CartCount {cart} />   <!-- reads cart.count -->
<AddButton {cart} />   <!-- calls cart.add() -->
// click Add → the count island repaints. One live object, two islands.`;

export const lakeFrozen = `<script>
  // a frozen subtree inside an island: SSR HTML, ships no client JS
  import Snapshot from '$lib/Snapshot.svelte' with {
    wake: 'none'
  };
</script>

<Snapshot value={42} />`;

export const ogygiaRouter = `// vite.config.ts — the router is global; configure it in ONE place
import { ogygia } from 'ogygia/vite';

export default {
  plugins: [
    ogygia(),                                       // router on, view transitions on (default)
    // ogygia({ router: { viewTransitions: false } })  // SPA nav, no view transitions
    // ogygia({ router: false })                        // opt out of the SPA router entirely
    sveltekit(),
  ],
};

<!-- src/routes/checkout/+page.svelte — opt ONE page out of view transitions -->
<svelte:head>
  <meta name="ogygia-router" content="plain" />
</svelte:head>`;

export const ogygiaBoundary = `<script>
  import { Boundary } from 'ogygia';
  import Counter from '$lib/Counter.svelte' with { wake: 'load' };
  import Report from '$lib/Report.svelte' with { wake: 'none' };
</script>

<!-- Transparent passthrough — marks region usages in source; zero runtime effect -->
<Boundary>
  <Counter />
  <Report />
</Boundary>`;

export const persistNav = `<!-- in a layout shared by SPA routes -->
<nav data-ogygia-keep="main-nav">
  <a href="/">Home</a>
  <!-- islands here keep their client state across nav -->
</nav>`;

export const hydrateLoad = `<script>
  import Panel from '$lib/Panel.svelte' with {
    wake: 'load'
  };
</script>

<Panel />`;

export const hydrateIdle = `<script>
  import Widget from '$lib/Widget.svelte' with {
    wake: 'idle'
  };
</script>

<Widget />`;

export const hydrateVisible = `<script>
  import Chart from '$lib/Chart.svelte' with {
    wake: 'visible'
  };
</script>

<Chart />`;

export const hydrateMedia = `<script>
  import Drawer from '$lib/Drawer.svelte' with {
    wake: '(max-width: 600px)'
  };
</script>

<Drawer />`;

export const hydrateLoadCounter = `<script>
  import Counter from '$lib/Counter.svelte' with {
    wake: 'load'
  };
</script>

<Counter />`;

export const hydrateLoadPoke = `<script>
  import Counter from '$lib/Counter.svelte' with {
    wake: 'load'
  };
</script>

<Counter start={7} />`;

export const hydrateVisiblePoke = `<script>
  import Widget from '$lib/Widget.svelte' with {
    wake: 'visible'
  };
</script>

<Widget />`;

export const deferLoadGreeting = `<script>
  import Greeting from '$lib/Greeting.svelte' with {
    render: 'deferred'
  };
</script>

<Greeting salutation="Aloha">
  {#snippet ogygiaFallback()}
    <p>loading…</p>
  {/snippet}
</Greeting>`;

export const deferIdleGreeting = `<script>
  import Greeting from '$lib/Greeting.svelte' with {
    render: 'deferred',
    wake: 'idle'
  };
</script>

<Greeting salutation="Idle">
  {#snippet ogygiaFallback()}
    <p>waiting for idle…</p>
  {/snippet}
</Greeting>`;

export const deferVisibleGreeting = `<script>
  import Greeting from '$lib/Greeting.svelte' with {
    render: 'deferred',
    wake: 'visible'
  };
</script>

<Greeting salutation="Visible">
  {#snippet ogygiaFallback()}
    <p>scroll to fetch…</p>
  {/snippet}
</Greeting>`;

export const deferMediaGreeting = `<script>
  import Greeting from '$lib/Greeting.svelte' with {
    render: 'deferred',
    wake: '(max-width: 600px)'
  };
</script>

<Greeting salutation="Matched">
  {#snippet ogygiaFallback()}
    <p>waiting for media…</p>
  {/snippet}
</Greeting>`;

export const presetDemo = `// vite.config.ts
ogygia({
  presets: {
    demo: { wake: 'visible', margin: '200px' }
  }
});

// component
<script>
  import Panel from '$lib/Panel.svelte' with {
    preset: 'demo'
  };
</script>`;

/** render: live presets — docs Live section. */
export const remountConfig = `// vite.config.ts
ogygia({
  presets: {
    // a frozen static lake — baked once, never refetched
    frozen: { wake: 'none' },
    // render: live — baked, then revalidates (stale-while-revalidate)
    live: {
      render: 'live',
      wake: 'idle',        // revalidate schedule
      maxAge: '10m',       // past this, skip stale and fetch fresh
      onExpire: 'fetch'
    }
  }
});

// inside an island
<script>
  import Report from '$lib/Report.svelte' with { preset: 'live' };
  let show = $state(true);
</script>

{#if show}
  <Report title="Q4" />
{/if}`;

/** Client-only lazy mount — plain dynamic import inside a host island. */
export const lazyClientMount = `<!-- +page.svelte — host is the island -->
<script>
  import Host from '$lib/Host.svelte' with { wake: 'load' };
</script>
<Host />

<!-- Host.svelte — inside the island -->
<script>
  import type { Component } from 'svelte';
  let Lazy = $state();

  async function load() {
    // plain component — NOT an island (no with { wake })
    Lazy = (await import('./Widget.svelte')).default;
  }
</script>

<button type="button" onclick={load}>Load</button>
{#if Lazy}
  {@const Comp = Lazy}
  <Comp />
{/if}`;

/** Delayed island boundary — static region import + {#if}, not import()+with. */
export const delayedIslandIf = `<script>
  import Widget from '$lib/Widget.svelte' with { wake: 'load' };
  let show = $state(false);
</script>

<button type="button" onclick={() => (show = true)}>Mount island</button>
{#if show}
  <Widget />
{/if}`;

/** Portable island bindings — dictionary + barrel + capitalized binding tag (ogygia 0.4). */
export const portableBindings = `<script>
  import Pulse from '$lib/Pulse.svelte' with { wake: 'load' };
  import Ticker from '$lib/Ticker.svelte' with { wake: 'load' };
  import Notch from '$lib/Notch.svelte' with { wake: 'load' };
  // Controls island: serializable props only — never pass constructors across.
  import Controls from '$lib/Controls.svelte' with { wake: 'load' };

  const registry = { pulse: Pulse, ticker: Ticker, notch: Notch };
  const barrel = [
    { key: 'pulse', label: 'Pulse', Comp: Pulse },
    { key: 'ticker', label: 'Ticker', Comp: Ticker },
    { key: 'notch', label: 'Notch', Comp: Notch }
  ];

  // active comes from load via ?widget= (default first key)
  let { active } = $props();
  const Active = $derived(registry[active]);
  const items = barrel.map(({ key, label }) => ({ key, label }));
</script>

<Controls {active} {items} />
<Active />`;

/** Content collections — RF-native. Homepage content-layer beat. */
export const contentCollection = `// collections.ts — one browser-safe definition
import { content, markdown } from 'ogygia/content';

export const docs = content({
  loader: markdown(import.meta.glob('./docs/**/*.svx', { eager: true })),
  schema
});

// docs.remote.ts — expose it over the wire, bodies stripped
export const docNav = withRemotes(docs).list({
  map: (e) => ({ slug: e.id, title: e.data.title })
});`;

export const contentMarkdown = `<!-- posts/hello.svx — markdown, with real islands in the prose -->
<script>
  import Chart from '$lib/Chart.svelte' with { wake: 'visible' };
</script>

# {frontmatter.title}

Shiki-highlighted fences, heading ids, and a TOC in \`meta.headings\` —
and a live island, right in the copy:

<Chart {data} />`;

export const contentJson = `// typed data, not just prose — JSON through the same API
import { content, json } from 'ogygia/content';
import * as v from 'valibot';

export const authors = content({
  loader: json(import.meta.glob('./authors/*.json', { eager: true })),
  schema: v.object({ name: v.string(), bio: v.string() })
});

const ada = await authors.get('ada'); // fully typed { name, bio }`;

export const contentCustom = `// any source — a CMS, a REST API, or a push feed
export const press = content({
  schema,
  loader: {
    async get(id) { const p = await api(\`/posts/\${id}\`); return p && { id, data: p }; },
    async list()  { return (await api('/posts')).map((p) => ({ id: p.slug, data: p })); }
  }
});

// pushes? add live() — a change signal; the list re-emits on every change.
export const feed = withRemotes(press).live.list({ map: (e) => e.data });`;
