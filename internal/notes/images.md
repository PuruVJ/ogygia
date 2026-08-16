# Images — spec (design only, not built)

The thesis: **an image is a region whose output is pixels.** Pixels settle on the same clock as
HTML — at build (`static`), per request (`deferred`), or continuously (`live`) — and a
component-rendered image is the same machinery with a raster step appended.

This file specs the component→pixels path (OG cards and friends) end to end, plus the descriptor
and provider contracts the photograph path shares.

---

## 1. Packaging: images stand alone

**`ogygia/image`** (browser-safe: `<Img>`, `ImageDescriptor`) and **`ogygia/image/server`**
(`raster()`). Zero dependency on content/site — a bare Kit app with no collections gets the
whole image story. `site()`'s `og` emission and the markdown pipeline are *consumers* of this
layer, never its home.

## 2. Engines: satori by default, playwright by choice

The rasterizer is a **plugin-level dial** — a name or a value (the house contract pattern):

```ts
ogygia({
  image: { engine: 'satori' }        // default: satori-html → satori → resvg. No browser.
  // image: { engine: 'playwright' } // full-fidelity: real Chromium, real CSS (grid, filters,
  //                                 //   web fonts, text shaping). Heavier; see tradeoffs.
  // image: { engine: myEngine }     // a RasterEngine value — Cloudinary, wasm, whatever.
})
```

```ts
type RasterEngine = {
  /** Rasterize one SSR'd component output. `html` is the render; `size`/`fonts` from the call. */
  render(input: { html: string; size: [number, number]; fonts?: FontData[] }): Promise<Uint8Array>;
};
```

- **satori** (default): flexbox + inline styles ("the card dialect"), `<svg>` root bypasses
  satori for resvg-direct full-SVG fidelity. No browser, WASM-capable, serverless-safe.
  ~30–80 ms/card + ~5–30 ms rasterize (verify in spike). Optional peers, lazy-loaded.
- **playwright**: one persistent browser per build/server, a small page pool, screenshot of the
  SSR'd HTML with the app's real CSS. Anything Chromium renders, the card can be. Tradeoffs
  stated plainly in docs: heavyweight dependency; per-request use needs a long-lived server
  (bad fit for edge/serverless — satori is the deferred-on-serverless recommendation); build
  use is unremarkable (browser starts once, hundreds of cards, then exits).
- Engine choice changes **fidelity only** — every calling surface below is engine-agnostic.

## 3. One server primitive, three clocks

Everything reduces to **`raster()`** — a plain server function, callable anywhere server code
runs:

```ts
import { raster } from 'ogygia/image/server';

const png = await raster(SocialCard, { title }, { size: [1200, 630] });   // Uint8Array
```

The three clocks are three ways to call it:

- **Build** — the macro `import.meta.og.image(Component, props, opts)`: bake-machinery, static
  literal props enforced (runtime value → build error naming the other two clocks), output a
  hashed asset + descriptor. Sugar over raster() at compile time.
- **SSR / your own route** — call `raster()` directly. This is the answer to "what if the image
  content needs request-time data": it's just server code, cached by *your* route's headers.

  ```ts
  // src/routes/og/[id].png/+server.ts — og:image with DB data, no ogygia ceremony
  export const GET = async ({ params, setHeaders }) => {
    const post = await db.post(params.id);
    setHeaders({ 'cache-control': 'public, max-age=3600' });
    return new Response(await raster(SocialCard, { title: post.title }), {
      headers: { 'content-type': 'image/png' }
    });
  };
  ```

- **Deferred** — the marked import (`render: 'deferred', as: 'image', maxAge`): sugar that
  mints the signed capability URL and calls raster() on the endpoint. For per-visitor images
  inside PPR shells, where you want the signing/caching machinery instead of writing a route.

## 4. The macro's two sources

`import.meta.og.image()` settles **any image to a descriptor at build**. The first argument
picks the source:

```ts
// a FILE → probe + encode variants (the photograph path)
const hero = import.meta.og.image('./hero.jpg', { widths: [640, 1280, 2048] });

// a COMPONENT + props → ssr_render + rasterize (the card path)
const card = import.meta.og.image(SocialCard, { title: 'Single-flight navigation' }, {
  size: [1200, 630]
});
```

Both return the same **descriptor** (see §6). The component form rides the `bake` machinery:
the component graph is rolldown-bundled and executed at build, so **props must be static
serializable literals** — a runtime value is a build error pointing at `render: 'deferred'`.
(Same contract, same error voice, as `og.bake`.)

Marked-import sugar for files stays: `import hero from './hero.jpg' with { widths: [...] }`.

## 5. The OG emission — cards for every page (a consumer)

One declaration on the site, so the brains know:

```ts
export const docs = site({
  outline: guides,
  og: { card: SocialCard, fonts: [interRegular, interBold] }   // fonts: see §5
});
```

Mounting is one route, shaped exactly like every other emission:

```ts
// src/routes/og/[...slug].png/+server.ts
export const prerender = true;
export const { GET, entries } = docs.emit.og();
```

- **Per entry**, the card component receives `{ title, summary, section, slug, data }` — the
  same `fields.page` surface pages read. `entries()` is the outline's leaves, so coverage is
  total by construction.
- **Because `og` is declared on `site()`**, the head follows for free: `<Doc>` (or the shell)
  emits `<meta property="og:image" content="{origin}/og/{slug}.png">` + `og:image:width/height`
  — origin from `site.data.origin`, path from the mounted emission. One declaration, two views
  (bytes + meta), zero drift. No declaration → no meta → no surprise 404s.
- Cached content-addressed in the BuildCache (`raster` namespace). Key:
  `hash(card bundle digest, entry props, size, fonts digest, pipeline version)`. Warm CI
  re-renders only pages whose title/summary/card actually changed.
- Format: PNG default (scrapers don't do AVIF), `format: 'jpeg'` opt-out for photo-heavy cards.

## 6. Deferred raster details

```svelte
<script>
  import UsageChart from '$lib/UsageChart.svelte' with {
    render: 'deferred', as: 'image', maxAge: '5m'
  };
</script>

<UsageChart user={session.id} />
```

- SSR emits `<img src={signedUrl} width height>` — the URL minted by the **existing** capability
  path: HMAC over the same length-prefixed message, props serialized + signed (existing 8 KB
  cap), `maxAge` signed in, probe-rate before HMAC, `Sec-Fetch-Site` gating. Nothing new is
  trusted.
- The handle's render branch: verify → ssr_render → rasterize → `image/png` +
  `Cache-Control: private, max-age=N`. One new signed field: `as: 'image'` (so a harvested HTML
  capability can't be replayed as an image mint or vice versa).
- PPR is the payoff: a CDN-cached static shell with a **per-visitor image hole**. On SPA
  navigation the hole is just another region call — but note: image holes do **not** join the
  HTML batch parcel (mixed content types in one stream buys nothing the browser's parallel
  image fetch doesn't already do). They're plain `<img>` fetches; the single-flight batch stays
  HTML-only.
- `wake` dial applies as loading strategy: default eager; `wake: 'visible'` → `loading="lazy"`.
- **Live**: not specced for raster. Live regions morph SVG/HTML in place — strictly better than
  bitmap streams. `as: 'image'` on `render: 'live'` is a build error with that explanation.

## 7. Fonts (satori engine only)

Satori needs raw font data — no system fonts, no CSS `@font-face`. Spec:

```ts
import interRegular from '$lib/fonts/Inter-Regular.ttf' with { font: true };  // → { name, data, weight, style }
```

A marked font import inlines the buffer at build (bake-style) and infers name/weight/style from
the file tables. `og: { fonts: [...] }` and the macro's `fonts` option take these values.
Zero fonts + Tier A card → build error: "satori renders no text without a font — mark a font
import and pass it." (SVG-root cards may embed paths and need none; the playwright engine ignores this entirely — it uses the app's real CSS fonts.)

## 8. The descriptor (shared with the photograph path)

```ts
type ImageDescriptor = {
  variants: { src: string; format: 'avif' | 'webp' | 'png' | 'jpeg'; width: number }[];
  width: number; height: number;          // intrinsic — CLS-proof by construction
  sizes?: string;                          // derived (prose column) or authored
  alt?: string;                            // from markdown/frontmatter; <Img> requires alt prop otherwise
};
```

Plain devalue-safe data: crosses island props, rides `refs()`, sits in frontmatter via
`fields.image`. `<Img of={desc}>` renders `<picture>`; `<Region>` learns to accept descriptors
(`<Img>` is the sugar). Providers (Cloudinary/imgix/CMS) are app values that map remote
metadata into this shape — the descriptor **is** the provider contract.

## 9. Failure modes, named

- Unsupported CSS in a Tier A card → build error citing the property + "the card dialect is
  flexbox + inline styles; render an `<svg>` root for full fidelity."
- Runtime props in the static macro → error pointing at `render: 'deferred'`.
- Missing fonts (Tier A, has text) → error per §5.
- Deferred raster on a runtime without the peers → boot-time error naming the three packages.
- `images()` check (separate spec): missing file / missing alt / oversized intrinsic vs rendered.

## 10. Open questions

1. `as: 'image'` vs `render: 'image'` — spec assumes `as:` (output target, orthogonal to when).
2. Does `emit.og()` allow per-SECTION card components (`og: { card, overrides: { blog: BlogCard } }`)? Lean yes, later.
3. Dev ergonomics: `/og/<slug>.png` renders on demand in dev with the satori error overlaid on a
   placeholder image (so the broken card is visible in situ). Nice; needs a spike.
4. JPEG/quality knobs for the photograph path live where — descriptor opts or provider config?
