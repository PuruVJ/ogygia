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
        frozen: {
          wake: 'none',
          remount: { revalidate: 'idle', maxAge: '10m' }
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

/** Gradual migration — root router + per-route csr=false. */
export const adoptionMigrate = `// src/routes/+layout.svelte — safe on mixed apps
<script>
  import * as ogygia from 'ogygia';
</script>

<ogygia.Router />
{@render children()}

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
  import Greeting from '$lib/Greeting.svelte' with { fill: 'load' };      // server island
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

export const ogygiaRouter = `<script>
  import * as ogygia from 'ogygia';
</script>

<!-- View Transitions on (default) -->
<ogygia.Router />

<!-- plain swap -->
<ogygia.Router viewTransitions={false} />`;

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
<nav data-ogygia-persist="main-nav">
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
    fill: 'load'
  };
</script>

<Greeting salutation="Aloha">
  {#snippet ogygiaFallback()}
    <p>loading…</p>
  {/snippet}
</Greeting>`;

export const deferIdleGreeting = `<script>
  import Greeting from '$lib/Greeting.svelte' with {
    fill: 'idle'
  };
</script>

<Greeting salutation="Idle">
  {#snippet ogygiaFallback()}
    <p>waiting for idle…</p>
  {/snippet}
</Greeting>`;

export const deferVisibleGreeting = `<script>
  import Greeting from '$lib/Greeting.svelte' with {
    fill: 'visible'
  };
</script>

<Greeting salutation="Visible">
  {#snippet ogygiaFallback()}
    <p>scroll to fetch…</p>
  {/snippet}
</Greeting>`;

export const deferMediaGreeting = `<script>
  import Greeting from '$lib/Greeting.svelte' with {
    fill: '(max-width: 600px)'
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

/** Lake remount presets — docs Remount section. */
export const remountConfig = `// vite.config.ts
ogygia({
  presets: {
    frozen: { wake: 'none' }, // remount: 'cache'
    blank: { wake: 'none', remount: 'empty' },
    // cache until TTL, then blank
    brief: {
      wake: 'none',
      remount: { revalidate: false, maxAge: '5m' }
    },
    // SWR: paint stale, refetch on idle; past 10m skip stale and fetch
    live: {
      wake: 'none',
      remount: { revalidate: 'idle', maxAge: '10m', onExpire: 'fetch' }
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
