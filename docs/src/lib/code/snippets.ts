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

export const authoringImports = `import Counter  from '$lib/Counter.svelte'  with { hydrate: 'load' };
import Chart    from '$lib/Chart.svelte'    with { hydrate: 'visible' };
import Drawer   from '$lib/Drawer.svelte'   with { hydrate: '(max-width: 600px)' };
import Greeting from '$lib/Greeting.svelte' with { defer: 'load' };
import Report   from '$lib/Report.svelte'   with { hydrate: 'none' };
import Panel    from '$lib/Panel.svelte'    with { preset: 'chart' };

<Counter start={10} />`;

export const ogygiaRouter = `import { OgygiaRouter } from 'ogygia';

// View Transitions on (default)
<OgygiaRouter />

// plain swap
<OgygiaRouter viewTransitions={false} />`;

export const persistNav = `<!-- in a layout shared by SPA routes -->
<nav data-ogygia-persist="main-nav">
  <a href="/">Home</a>
  <!-- islands here keep their client state across nav -->
</nav>`;

export const hydrateLoad = `import Panel from '$lib/Panel.svelte' with {
  hydrate: 'load'
};

<Panel />`;

export const hydrateIdle = `import Widget from '$lib/Widget.svelte' with {
  hydrate: 'idle'
};

<Widget />`;

export const hydrateVisible = `import Chart from '$lib/Chart.svelte' with {
  hydrate: 'visible'
};

<Chart />`;

export const hydrateMedia = `import Drawer from '$lib/Drawer.svelte' with {
  hydrate: '(max-width: 600px)'
};

<Drawer />`;

export const hydrateLoadCounter = `import Counter from '$lib/Counter.svelte' with {
  hydrate: 'load'
};

<Counter />`;

export const hydrateLoadPoke = `import Counter from '$lib/Counter.svelte' with {
  hydrate: 'load'
};

<Counter start={7} />`;

export const hydrateVisiblePoke = `import Widget from '$lib/Widget.svelte' with {
  hydrate: 'visible'
};

<Widget />`;

export const deferLoadGreeting = `import Greeting from '$lib/Greeting.svelte' with {
  defer: 'load'
};

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
import Panel from '$lib/Panel.svelte' with {
  preset: 'demo'
};`;
