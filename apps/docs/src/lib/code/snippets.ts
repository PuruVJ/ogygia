/**
 * The homepage's code snippets, minted at BUILD by `import.meta.og.code()` — the same fence
 * pipeline (themes, transformers, wrapper) a markdown fence gets, inlined as static regions.
 * Dogfood: this replaced a bespoke Shiki remote (snippets.server/remote + highlight.server).
 * Render with `<Region of={…} />`; ships as HTML, no client JS of its own.
 */
export const heroCode = import.meta.og.code(`<script>
  import Counter from '$lib/Counter.svelte' with {
    wake: 'load'
  };
</script>

<Counter />`, 'svelte');

// HeroDemo is an ISLAND: an inline region carries a live component and can't devalue-cross
// a captured-prop boundary — hand the island the BAKED HTML string instead (strings cross).
export const heroCodeHtml = String(heroCode.props.html);

export const loadCode = import.meta.og.code(`<script>
  import Panel from '$lib/Panel.svelte' with {
    wake: 'load'
  };
</script>

<Panel />`, 'svelte');

export const visibleCode = import.meta.og.code(`<script>
  import Chart from '$lib/Chart.svelte' with {
    wake: 'visible'
  };
</script>

<Chart />`, 'svelte');

export const lakeCode = import.meta.og.code(`<script>
  // a frozen subtree inside an island: SSR HTML, ships no client JS
  import Snapshot from '$lib/Snapshot.svelte' with {
    wake: 'none'
  };
</script>

<Snapshot value={42} />`, 'svelte');

export const serverCode = import.meta.og.code(`<script>
  import Greeting from '$lib/Greeting.svelte' with {
    render: 'deferred'
  };
</script>

<Greeting salutation="Aloha">
  {#snippet ogygiaFallback()}
    <p>loading…</p>
  {/snippet}
</Greeting>`, 'svelte');

export const fragmentCode = import.meta.og.code(`<script>
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
{/if}`, 'svelte');

export const livePartialCode = import.meta.og.code(`// tick.remote.ts — the server pushes rendered HTML each second.
// \`yield\` awaits the partial, so its HTML rides the ticket (no fetch).
export const liveTick = query.live(async function* () {
  let n = 1;
  while (true) {
    yield region(Tick, { n: n++, at: new Date().toISOString() });
    await new Promise((r) => setTimeout(r, 1000));
  }
});

// the island just paints the latest tick — static partials morph in place
<Region of={liveTick().current} />`, 'svelte');

export const sharedObjectCode = import.meta.og.code(`// cart.svelte.ts — a live class that can cross island boundaries
export class Cart {
  items = $state([]);
  get count() { return this.items.length; }
  add(item) { this.items.push(item); }

  // the whole opt-in: how this instance travels as a prop
  static wire = import.meta.og.wire({
    encode: (c) => $state.snapshot(c.items),
    decode: (items) => Object.assign(new Cart(), { items }),
  });
}

// page.svelte — one instance, handed to two separate islands
const cart = new Cart();
<CartCount {cart} />   <!-- reads cart.count -->
<AddButton {cart} />   <!-- calls cart.add() -->
// click Add → the count island repaints. One live object, two islands.`, 'ts');

export const contentCollectionCode = import.meta.og.code(`// collections.server.ts — one server-only definition
import { content } from 'ogygia/content';

export const docs = content({
  loader: import.meta.og.loader.markdown('./docs/**/*.svx'),
  schema
});

// docs.remote.ts — expose it over the wire, bodies stripped
export const docNav = withRemotes(docs).list({
  map: (e) => ({ slug: e.id, title: e.data.title })
});`, 'ts');

export const contentMarkdownCode = import.meta.og.code(`<!-- posts/hello.svx — markdown, with real islands in the prose -->
<script>
  import Chart from '$lib/Chart.svelte' with { wake: 'visible' };
</script>

# {frontmatter.title}

Shiki-highlighted fences, heading ids, and a TOC in \`meta.headings\` —
and a live island, right in the copy:

<Chart {data} />`, 'svelte');

export const contentJsonCode = import.meta.og.code(`// typed data, not just prose — JSON through the same API
import { content } from 'ogygia/content';
import * as v from 'valibot';

export const authors = content({
  loader: import.meta.og.loader.json('./authors/*.json'),
  schema: v.object({ name: v.string(), bio: v.string() })
});

const ada = await authors.get('ada'); // fully typed { name, bio }`, 'ts');

export const contentCustomCode = import.meta.og.code(`// any source — a CMS, a REST API, or a push feed
export const press = content({
  schema,
  loader: {
    // get() carries the body; refs() is metadata only (never a body on the wire).
    async get(id)  { const p = await api(\`/posts/\${id}\`); return p && { id, data: p }; },
    async refs()   { return (await api('/posts')).map((p) => ({ id: p.slug, data: p })); }
  }
});

// pushes? add live() — a change signal; the feed re-emits on every change.
export const feed = withRemotes(press).live.list({ map: (e) => e.data });`, 'ts');

export const sitekitCode = import.meta.og.code(`// site.server.ts — the WHOLE site config
import { content, fields, sitekit, links } from 'ogygia/content';

export const docs = content({
  loader: import.meta.og.loader.folder('../content/docs'),
  schema: fields.page
});

export const site = sitekit({
  outline: docs,          // filenames become the nav tree
  prevNext: 'graph',      // "keep reading" follows real links
  checks: [links()]       // a broken link fails the build
});`, 'ts');
