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
        chart: { hydrate: 'visible', margin: '200px' },
        modal: { hydrate: 'idle' },
        frozen: {
          hydrate: 'none',
          remount: { revalidate: 'idle', maxAge: '10m' }
        }
      },
      rateLimit: { max: 60, windowMs: 60_000 },
      regionTtl: 3600 // seconds; default 1h
      // sessionCookie: 'sessionid' // bind personalized defer/SWR holes
      // importKeys: { hydrate: 'ogygiaHydrate' } // only if another tool claims \`hydrate\`
    }),
    sveltekit()
  ]
});`;

export const layoutAndHooks = `// src/hooks.server.ts
import { sequence } from '@sveltejs/kit/hooks';
import { ogygiaHandle } from 'ogygia/hooks';

export const handle = sequence(ogygiaHandle(), myOtherHandle);

// On each route (or layout) you convert to islands:
// src/routes/marketing/+page.ts
export const csr = false;`;

/** Gradual migration — root router + per-route csr=false. */
export const adoptionMigrate = `// src/routes/+layout.svelte — safe on mixed apps
<script>
  import { OgygiaRouter } from 'ogygia';
</script>

<OgygiaRouter />
{@render children()}

// src/routes/blog/+page.ts — convert one route at a time
export const csr = false;

// src/routes/blog/+page.svelte
<script>
  import Comments from '$lib/Comments.svelte' with { hydrate: 'visible' };
</script>

<article>…SSR content…</article>
<Comments />

// src/routes/dashboard/+page.ts — leave alone (Kit default)
// no \`csr = false\` → full Kit client, router stays idle`;

export const authoringImports = `<script>
  import Counter  from '$lib/Counter.svelte'  with { hydrate: 'load' };     // island
  import Chart    from '$lib/Chart.svelte'    with { hydrate: 'visible' }; // island, later
  import Drawer   from '$lib/Drawer.svelte'   with { hydrate: '(max-width: 600px)' };
  import Report   from '$lib/Report.svelte'   with { hydrate: 'none' };    // lake (inside an island)
  import Greeting from '$lib/Greeting.svelte' with { defer: 'load' };      // server island
  import Panel    from '$lib/Panel.svelte'    with { preset: 'chart' };
</script>

<Counter start={10} />`;

export const ogygiaRouter = `<script>
  import { OgygiaRouter } from 'ogygia';
</script>

<!-- View Transitions on (default) -->
<OgygiaRouter />

<!-- plain swap -->
<OgygiaRouter viewTransitions={false} />`;

export const ogygiaBoundary = `<script>
  import { OgygiaBoundary } from 'ogygia';
  import Counter from '$lib/Counter.svelte' with { hydrate: 'load' };
  import Report from '$lib/Report.svelte' with { hydrate: 'none' };
</script>

<!-- Transparent passthrough — marks region usages in source; zero runtime effect -->
<OgygiaBoundary>
  <Counter />
  <Report />
</OgygiaBoundary>`;

export const persistNav = `<!-- in a layout shared by SPA routes -->
<nav data-ogygia-persist="main-nav">
  <a href="/">Home</a>
  <!-- islands here keep their client state across nav -->
</nav>`;

export const hydrateLoad = `<script>
  import Panel from '$lib/Panel.svelte' with {
    hydrate: 'load'
  };
</script>

<Panel />`;

export const hydrateIdle = `<script>
  import Widget from '$lib/Widget.svelte' with {
    hydrate: 'idle'
  };
</script>

<Widget />`;

export const hydrateVisible = `<script>
  import Chart from '$lib/Chart.svelte' with {
    hydrate: 'visible'
  };
</script>

<Chart />`;

export const hydrateMedia = `<script>
  import Drawer from '$lib/Drawer.svelte' with {
    hydrate: '(max-width: 600px)'
  };
</script>

<Drawer />`;

export const hydrateLoadCounter = `<script>
  import Counter from '$lib/Counter.svelte' with {
    hydrate: 'load'
  };
</script>

<Counter />`;

export const hydrateLoadPoke = `<script>
  import Counter from '$lib/Counter.svelte' with {
    hydrate: 'load'
  };
</script>

<Counter start={7} />`;

export const hydrateVisiblePoke = `<script>
  import Widget from '$lib/Widget.svelte' with {
    hydrate: 'visible'
  };
</script>

<Widget />`;

export const deferLoadGreeting = `<script>
  import Greeting from '$lib/Greeting.svelte' with {
    defer: 'load'
  };
</script>

<Greeting salutation="Aloha">
  {#snippet ogygiaFallback()}
    <p>loading…</p>
  {/snippet}
</Greeting>`;

export const deferIdleGreeting = `<script>
  import Greeting from '$lib/Greeting.svelte' with {
    defer: 'idle'
  };
</script>

<Greeting salutation="Idle">
  {#snippet ogygiaFallback()}
    <p>waiting for idle…</p>
  {/snippet}
</Greeting>`;

export const deferVisibleGreeting = `<script>
  import Greeting from '$lib/Greeting.svelte' with {
    defer: 'visible'
  };
</script>

<Greeting salutation="Visible">
  {#snippet ogygiaFallback()}
    <p>scroll to fetch…</p>
  {/snippet}
</Greeting>`;

export const deferMediaGreeting = `<script>
  import Greeting from '$lib/Greeting.svelte' with {
    defer: '(max-width: 600px)'
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
    demo: { hydrate: 'visible', margin: '200px' }
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
    frozen: { hydrate: 'none' }, // remount: 'cache'
    blank: { hydrate: 'none', remount: 'empty' },
    // cache until TTL, then blank
    brief: {
      hydrate: 'none',
      remount: { revalidate: false, maxAge: '5m' }
    },
    // SWR: paint stale, refetch on idle; past 10m skip stale and fetch
    live: {
      hydrate: 'none',
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
  import Host from '$lib/Host.svelte' with { hydrate: 'load' };
</script>
<Host />

<!-- Host.svelte — inside the island -->
<script>
  import type { Component } from 'svelte';
  let Lazy = $state();

  async function load() {
    // plain component — NOT an island (no with { hydrate })
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
  import Widget from '$lib/Widget.svelte' with { hydrate: 'load' };
  let show = $state(false);
</script>

<button type="button" onclick={() => (show = true)}>Mount island</button>
{#if show}
  <Widget />
{/if}`;
