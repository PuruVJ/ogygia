/** Raw snippets for docs / playground — highlighted via `highlight.server.ts` in SSR shells. */

export const viteConfig = `import { sveltekit } from '@sveltejs/kit/vite';
import { ogygia } from 'ogygia/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    ogygia({
      visible: { margin: '200px' },
      presets: {
        chart: { hydrate: 'visible', margin: '200px' },
        modal: { hydrate: 'idle' }
      }
    }),
    sveltekit()
  ]
});`;

export const svelteConfig = `export default {
  compilerOptions: { experimental: { async: true } },
  kit: {
    adapter: adapter(),
    experimental: { remoteFunctions: true }
  }
};`;

export const layoutAndHooks = `// src/routes/+layout.ts
export const csr = false;

// src/hooks.server.ts
import { sequence } from '@sveltejs/kit/hooks';
import { ogygiaHandle } from 'ogygia/hooks';

export const handle = sequence(ogygiaHandle(), myOtherHandle);`;

export const authoringImports = `<script>
  import Counter  from '$lib/Counter.svelte'  with { hydrate: 'load' };
  import Chart    from '$lib/Chart.svelte'    with { hydrate: 'visible' };
  import Drawer   from '$lib/Drawer.svelte'   with { hydrate: '(max-width: 600px)' };
  import Greeting from '$lib/Greeting.svelte' with { defer: 'load' };
  import Report   from '$lib/Report.svelte'   with { hydrate: 'none' };
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
  {#snippet fallback()}
    <p>loading…</p>
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
