# Images — spec v2 (design only, not built)

The primitive has two halves:

1. **`raster(component, props)` — one verb.** A component settles to pixels. Pixels settle on
   the same clocks as HTML — build (bake), per
   request (a dual region's ticket) — because an image *is* a region whose output is pixels.
2. **The descriptor — one currency.** Pixels travel under a stable identity (`id`: content hash
   of the source) as plain devalue data. The descriptor is to pixels what a **ref** is to an
   entry: the shallow face every wire carries for free; the pixels are the heavy face the
   browser pays for by URL. "A descriptor is what a page admits to showing; pixels are what
   the browser pays for."

Nothing else is an "image feature." Every capability here is an existing organ noticing the
currency — bake settles it, dual regions defer it, lakes keep it, the router warms and morphs
it, checks audit it, emissions publish it, refs carry it. If a capability needs a new subsystem
instead of a new reaction, it's designed wrong.

**No image imports.** `import hero from './hero.jpg'` is what everyone does and it's not nice:
import attributes take string-literal values only (the ES grammar), so every option ends up in
a string DSL. The macro takes real JS — arrays, numbers, values from imports — and is already
the house pattern (`og.bake`, `og.code`). Files go through the macro, full stop.

---

## 1. Packaging: images stand alone

- **`ogygia/image`** — browser-safe: `<Img>`, `cdn()`, `ImageDescriptor`.
- **`ogygia/image/server`** — `raster()`. (No endpoint export — the hook serves images, §6.)
- **`ogygia/image/adapters`** — the shipped adapter factories (§2). Each lazy-loads its own
  peers; unused adapters cost nothing.

Zero dependency on content/site — a bare Kit app with no collections gets the whole image
story. `site()`'s `cards` emission and the markdown pipeline are *consumers* of this layer,
never its home. **unpic is vendored** (MIT, tiny) as the URL-generation brain: layout-derived
srcset/sizes, CDN detection, platform-optimizer URL formats.

## 2. Adapters: three contracts, factories not strings

A dial is a value (the house contract pattern — formats are source builders, checks are
values). Three contracts cover the whole pipeline; every shipped adapter and every custom one
is the same citizenship.

```ts
ogygia({
  image: {
    optimizer: sharp({ quality: 80, formats: ['avif', 'webp'] }),   // the DEFAULT — source
                                                   // sites override via named presets (§2a)
    engine: satori({ fonts: [inter] }),
    placeholder: thumbhash(),                      // the default; shown for completeness
    breakpoints: [640, 960, 1280, 1600, 2048],     // the ONE global ladder
    remote: ['images.unsplash.com', '**.mycdn.dev']
  }
})
```

### 2a. `Optimizer` — pixels of a file: who resizes, where the URL points

```ts
/** The full grade — imagetools' vocabulary as a TYPED bag, not their URL-string DSL. */
type ImageOps = {
  // geometry
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
  position?: string;                    // incl. sharp's 'attention' / 'entropy' smart-crop
  rotate?: number; flip?: boolean; flop?: boolean; trim?: boolean | number;
  extract?: { left: number; top: number; width: number; height: number };
  // grade
  blur?: number | boolean; sharpen?: boolean | object; median?: number;
  gamma?: number; negate?: boolean; normalize?: boolean; clahe?: object; threshold?: number;
  tint?: string; grayscale?: boolean;
  modulate?: { brightness?: number; saturation?: number; hue?: number; lightness?: number };
  // encode
  quality?: number; progressive?: boolean; lossless?: boolean;
};

type Optimizer = {
  name: string;
  /** Which ops this adapter can honor. An op outside this set at build = error NAMING the
   *  adapter and the op ("cloudflare() has no `modulate` — grade with sharp(), or drop it"). */
  ops: (keyof ImageOps)[] | 'all';
  /** PURE — mint a variant URL. Runs at SSR/build. This is the unpic surface. */
  url(t: { src: string; width: number; format?: Format; ops?: ImageOps }): string;
  /** OPTIONAL — actually transcode. Only self-hosted adapters have one. Powers 🏝️/image at
   *  runtime AND the static-build encode. Absent → the platform edge does it. */
  transform?(t: { data: Uint8Array; width: number; format: Format; ops?: ImageOps }): Promise<Uint8Array>;
};
```

Shipped: `sharp({ quality?, formats? })` (`ops: 'all'` — internally imagetools-core's transform
pipeline over sharp, so the whole directive vocabulary comes tested and free; url → signed
`🏝️/image`; lazy peer) · `vercel({ quality? })` (`ops: []` — w/q only; url →
`/_vercel/image?url=&w=&q=`) · `netlify()` (→ `/.netlify/images`) · `cloudflare({ zone? })`
(`ops: ['fit','blur','sharpen','rotate','trim',…]` — what `/cdn-cgi/image` maps). The platform
three are ~20-line unpic wrappers — deploy to Vercel, swap one factory, every `<Img>` is
optimized by their edge with zero server code of ours.

Why we can afford `ops: 'all'` at request time and Next can't: `/_next/image` caps params at
`url,w,q` because it's an open endpoint behind an allowlist — arbitrary op chains would be a
DoS buffet. `🏝️/image` only serves URLs SSR minted, and **the HMAC covers the whole ops
object** — arbitrary sharp pipelines are safe because nobody but our own SSR can request one.

Ops join identity: `id = hash(source, ops)`. A grayscale crop is a different image than its
source — its own morph key, its own BuildCache entry, its own placeholder token (the blur is
grayscale too, automatically).

**Presets — per-source optimizer without adapters in app code.** Adapter factories are
imported in `vite.config.ts` and NOWHERE else — app code refers to a named preset. A preset
is a partial image config: `{ via?, ops?, placeholder?, formats? }`.

```ts
// vite.config.ts — the ONLY place adapters exist
ogygia({
  image: {
    optimizer: sharp({ quality: 80 }),        // the unnamed default every image gets
    presets: {
      cf:     { via: cloudflare() },
      covers: { via: cloudinary({ cloud: 'demo' }), ops: { fit: 'cover', position: 'attention' } },
      mono:   { ops: { grayscale: true }, placeholder: dominant() }
    }
  }
})
```

```ts
// app code — strings only, no imports:
import.meta.og.image('./hero.jpg', { preset: 'cf' })
schema: v.object({ cover: image({ preset: 'covers' }) })      // every blog cover
folder(glob, { image: { preset: 'cf' } })                     // one corpus's markdown bodies
// already-hosted URLs: cdn() picks the CDN per URL automatically — nothing to configure
```

- Per-site `ops` merge OVER the preset's ops; an unknown preset name is a build-voice error
  listing the declared ones. Preset names are typeable via the ambient interface (the
  `ogygia/types` pattern) for autocomplete.
- One app can build-encode its docs images and serve marketing heroes through two different
  CDNs — the descriptor carries FINAL urls, minted at build by whichever adapter the preset
  named, so mixing five adapters costs zero at the hook and runtime never knows.
- A platform adapter on a local file: build emits the full-res hashed asset once; variants
  are platform URLs wrapping it (`/cdn-cgi/image/w=…/_app/immutable/hero.[hash].jpg`).
  Fetch-style CDNs (Cloudinary) need an absolute origin — from `site.data.origin` or an
  adapter option.
- **Dev ignores the preset's `via`** and always transforms locally through `🏝️/image` — the
  platform edge doesn't exist on localhost. Ops still apply.

Custom is not an escape hatch:

```ts
const imgproxy = (base: string): Optimizer => ({
  name: 'imgproxy',
  ops: ['blur', 'sharpen', 'grayscale'],
  url: ({ src, width, format }) =>
    `${base}/insecure/w:${width}/f:${format ?? 'avif'}/plain/${encodeURIComponent(src)}`
});
```

Capability is visible in the contract: static build + plain-remote source + a `transform`-less
optimizer = build-voice error derived from `optimizer.transform === undefined` ("vercel() can't
encode at build; remote files on a static site need an optimizer with transform — sharp()"),
not from a hardcoded name list. Same shape for ops: the error falls out of `optimizer.ops`.

### 2b. `RasterEngine` — pixels of a component: html in, bytes out

```ts
type RasterEngine = {
  name: string;
  render(t: { html: string; size: [number, number]; fonts?: FontData[] }): Promise<Uint8Array>;
  start?(): Promise<void>;   // playwright's browser pool lives here
  stop?(): Promise<void>;
};
```

- **`satori({ fonts })`** (default): flexbox + inline styles ("the card dialect"), `<svg>` root
  bypasses satori for resvg-direct full-SVG fidelity. No browser, WASM-capable, serverless-safe.
  ~30–80 ms/card + ~5–30 ms rasterize (verify in spike). Lazy peers. Fonts live HERE — the
  engine is the thing that needs them.
- **`playwright({ pool = 2 })`**: one persistent browser per build/server, a page pool,
  screenshot of the SSR'd HTML with the app's real CSS. Anything Chromium renders. Tradeoffs in
  docs: heavyweight; per-request use needs a long-lived server (satori is the
  deferred-on-serverless recommendation); build use is unremarkable.
- Engine choice changes **fidelity only** — every calling surface is engine-agnostic.

`engine` and `optimizer` stay two dials, not one — resizing photos and rasterizing components
share nothing but the word "image", and every permutation of the two is legal.

### 2c. `Placeholder` — blur tokens: pluggable algo, thumbhash default

```ts
type Placeholder = {
  name: string;
  /** BUILD — pixels in, tiny token out. The token rides the DESCRIPTOR (and refs, and island
   *  props) — small is the contract: aim for bytes, not kilobytes. */
  encode(t: { data: Uint8Array; width: number; height: number }): Promise<string>;
  /** SSR — token → CSS painted on the element. Pure, sync, no I/O. Returning CSS (not markup,
   *  not JS) is what keeps it csr:false native — an algo needing a client canvas to decode
   *  can't implement this. On purpose. */
  css(token: string): string;
};
```

Shipped: `thumbhash()` (DEFAULT — ~28 B, encodes aspect + alpha, SSR-decodes to a data-URI;
encoder/decoder vendored, MIT) · `blurhash()` (~30 B — for migrations with stored blurhashes) ·
`lqip({ width: 16 })` (real tiny webp data-URI, ~600 B — highest fidelity, heaviest token) ·
`dominant()` (7 B — `css: t => \`background:${t}\``).

Placeholders are a **pipeline default, not an `<Img>` feature**: EVERY image that passes
through — the macro, markdown `![…]()`, remote probes, provider descriptors, the deferred
hole's fallback — gets a token at encode time; every renderer paints `css(token)` server-side.
Blur is in the static HTML before any pixel arrives. Zero config, zero client JS. Opt out per
image (`placeholder: false` in the macro), per app (plugin config) — never opt in. Per-image
adapter override: `placeholder: dominant()` in the macro. The hashing probe always runs on the
build-side encoder regardless of serving optimizer (hashing needs pixels once at build;
serving doesn't).

## 3. The descriptor

```ts
type ImageDescriptor = {
  id: string;                    // content hash of SOURCE — organs key on this (morph, warm, cache)
  variants: { src: string; format: 'avif' | 'webp' | 'png' | 'jpeg'; width: number }[];
  width: number; height: number; // intrinsic — CLS-proof by construction
  ph?: [name: string, token: string];  // placeholder token + which adapter minted it — the
                                       // name travels WITH the token so per-image overrides
                                       // and CMS-stored blurhashes survive any wire
  alt?: string;                  // from markdown/frontmatter; <Img> requires alt prop otherwise
  dark?: ImageDescriptor;        // theme twin (§5)
  art?: { media: string; variants: Variant[];    // art-direction crops (§5) — each with its
          width: number; height: number;         // own aspect ratio and its own ph
          ph?: [string, string] }[];
};
```

Plain devalue-safe data: crosses island props, rides `refs()`, sits in frontmatter. NO `sizes`,
NO widths in user space — derived from `layout` at render (§5). Providers (Cloudinary / imgix /
CMS) map remote metadata into this shape — the descriptor **is** the provider contract, and
vendored unpic implements it for 20+ CDNs (§4C).

## 4. Every source

```ts
// ── A. local file — the macro. real JS options, no import-attribute string jail ──
const hero = import.meta.og.image('./hero.jpg', {
  ops: { fit: 'cover', position: 'attention', quality: 80 },   // the full grade (§2a)
  dark: { src: './hero.jpg', ops: { modulate: { brightness: 0.6 } } },
  // ↑ a dark variant can be a GRADE of the same file — no second asset. or a plain path.
  art: { '(max-width: 640px)': './hero-square.jpg' },
  preset: 'cf'          // per-image optimizer override BY NAME — adapters never leave vite.config (§2a)
});
// build: encode the ladder → hashed assets, call rewritten to the descriptor LITERAL
// (bake-style, content-addressed — warm CI skips unchanged images).
// dev: no encode — variants point at 🏝️/image, transformed on demand (§6).

// ── A2. a FOLDER of files — the glob form. one call, one record of descriptors ──
const shots = import.meta.og.image.glob('./gallery/*.jpg', {
  preset: 'covers',
  ops: { fit: 'cover', position: 'attention' }     // options apply to every match
});
// → Record<string, ImageDescriptor>, keys = glob-relative paths, insertion order sorted
//   by the numbered() convention (a `NN-` prefix orders a gallery like it orders docs):
// { 'gallery/01-dawn.jpg': {…}, 'gallery/02-harbor.jpg': {…}, … }
//
// conventions the glob form adds (file-name, folder()-style):
//   name.dark.jpg  → attached as `dark` twin of name.jpg, NOT its own key
//   NN- prefix     → iteration order (strip it nowhere — keys stay real paths)
// zero matches → build-voice error (and the dev lesson from folder(): globs expand via
// ARRAY form internally — brace globs match in build but not dev; build-green ≠ dev-green).

{#each Object.values(shots) as shot}
  <Img of={shot} layout="constrained" width={400} alt="…" />
{/each}

// ── B. component card — NOT a macro form. og.bake already IS the build clock ──
const card = import.meta.og.bake(() =>
  raster(SocialCard, { title: 'Single-flight navigation' }, { size: [1200, 630] })
);
// raster() under bake writes the hashed asset and returns the descriptor (devalue-safe),
// so bake inlines it as a literal. bake's existing contract does all the policing:
// self-contained fn, static inputs, build-voice errors. The macro takes FILES only —
// og.image(Component, props) does not exist, so there is nothing to keep in sync.

// ── C. transform CDN — unpic detection. nobody's server, no build work ──
const pic = cdn('https://res.cloudinary.com/demo/image/upload/sample.jpg');
// recognized CDN → variants are URL TRANSFORMS. infinite ladder, zero assets.

// ── D. plain remote — routed through the optimizer; host must be allowlisted ──
const photo = import.meta.og.image('https://images.unsplash.com/photo-1x');
// probe once at build (partial fetch → intrinsic size + ph, cached).
// static build: fetched + encoded once. SSR deploy: signed 🏝️/image proxy (§6).

// ── E. frontmatter — a schema field; descriptors ride refs ──
schema: v.object({ title: v.string(), cover: image() })   // './cover.jpg' → descriptor
// listings, prev/next, search, backlinks get thumbnails WITHOUT paying for an entry —
// refs are what they already consume. The shallow-face law doing its job.

// ── F. markdown body — nothing to write ──
// ![The harbor](./harbor.jpg)          → descriptor-backed <img>, blur included
// ![](https://images.unsplash.com/…)   → obeys image.remote, else an images() finding

// ── G. per-visitor — a dual region whose output is pixels (§8) ──
import UsageChart from '$lib/UsageChart.svelte' with {
  render: 'deferred', format: 'image', maxAge: '5m'
};
```

`raster()` itself stays a plain server function — the escape hatch that keeps everything else
honest:

```ts
// src/routes/badge/[user].png/+server.ts — og:image with DB data, no ogygia ceremony
export const GET = async ({ params, setHeaders }) => {
  const u = await db.user(params.user);
  setHeaders({ 'cache-control': 'public, max-age=3600' });
  return new Response(await raster(Badge, { name: u.name }, { size: [400, 120] }),
    { headers: { 'content-type': 'image/png' } });
};
```

## 5. Rendering: `<Img>`, layout intent (the unpic brain)

Users never write `widths` or `sizes`. They declare **layout intent**; srcset, sizes, the
ladder subset, aspect-ratio style, and loading attributes are all derived (unpic's exact
trick, vendored):

```svelte
<Img of={hero} layout="fullWidth" priority alt="The harbor at dusk" />
<Img of={ref.data.cover} layout="constrained" width={400} alt={ref.data.title} />
<Img of={avatar} layout="fixed" width={48} alt="" />
```

- `layout`: `constrained | fullWidth | fixed`. Picks the ladder subset (capped at 2× the
  display width), derives `sizes`, sets `aspect-ratio` + `max-width` styles.
- `priority`: `loading="eager" fetchpriority="high"` + `<link rel="preload">` in head. The
  first-load twin of router warming — the LCP story. Default is `loading="lazy" decoding="async"`.
- `alt` required by type when the descriptor doesn't carry one.

What SSR emits (fullWidth + priority + dark + art — all machinery visible):

```html
<link rel="preload" as="image" imagesrcset="…" imagesizes="100vw">
<picture data-img-light>
  <source media="(max-width: 640px)" srcset="…640w, …1080w" width="1080" height="1080">
  <img src="…" srcset="…640w, …1280w, …2048w" sizes="100vw" width="2048" height="1152"
       alt="The harbor at dusk" fetchpriority="high" decoding="async"
       style="aspect-ratio:2048/1152;background-image:url(data:image/png;base64,…)">
</picture>
<picture data-img-dark><!-- same shape, dark descriptor --></picture>
```

- **Theme is CSS state, not server resolution.** `preference()` lives in localStorage and the
  pages are prerendered — the server can never see it. So `<Img>` with a `dark` twin renders
  BOTH, and CSS picks, exactly like the JS↔TS toggle:

  ```css
  :root[data-pref-theme="dark"] [data-img-light] { display: none }
  :root:not([data-pref-theme="dark"]) [data-img-dark] { display: none }
  ```

  No flash, no JS, csr:false native, prerender-safe. (v1's "resolve theme server-side through
  preference()" was wrong and is dead.)
- **Art direction** renders as `<source media>` entries with their OWN width/height (no CLS
  when the crop switches) and their own placeholder token; a scoped `@media` rule swaps the
  blur with the crop.

## 6. The image endpoint — served by the hook, nothing to mount

There is no `+server.ts` and no `images.endpoint()`. We own `hooks.server.ts` already — the
same handle that serves region tickets at `<base>/🏝️` grows one sibling branch:

```
GET <base>/🏝️/image?src=…&w=1280&f=avif&sig=hVx2…
```

- Zero user setup: install the plugin, the endpoint exists. Clash-safe by the same argument as
  the region route; the base is the existing configurable hook path.
- Next.js protects `/_next/image` with domain + width allowlists. We own a stronger tool: the
  HMAC capability path from deferred regions. **SSR mints every variant URL with a signature
  over `(src, w, f, q)`** — the hook refuses anything it didn't mint. Not an open proxy:
  no SSRF surface, no width-enumeration abuse. Signature is deterministic → same URL every
  request → CDN-cacheable; no expiry for public images.
- Response headers by src kind: local hashed asset → `public, max-age=31536000, immutable`;
  remote → `public, max-age=86400, stale-while-revalidate` + ETag from upstream; per-visitor
  ticket → `private, max-age=N` (the existing region path, unchanged).
- **Dev is this same branch** — the macro doesn't encode in dev; variants point here and a
  memoized `optimizer.transform` answers. No second system, no dev-startup encode wall.
- On a platform optimizer (`vercel()` etc.) the branch simply never mints URLs — `url()`
  points at the platform edge and the hook path stays region-only.

## 7. Who resizes what, when

| source | dev | static build | SSR deploy |
|---|---|---|---|
| local file / frontmatter / markdown | `🏝️/image` on demand | hashed assets | hashed assets |
| component card (bake / emission) | rendered on request, error overlaid | hashed assets (BuildCache) | hashed assets |
| transform CDN (`cdn()`) | CDN URLs | CDN URLs | CDN URLs |
| plain remote | `🏝️/image` proxy | fetched + encoded once | signed `🏝️/image` proxy |
| per-visitor region | region ticket | build error (needs a server) | region ticket |

## 8. Deferred raster — a dual region whose output is pixels

```svelte
<script>
  import UsageChart from '$lib/UsageChart.svelte' with {
    render: 'deferred', format: 'image', maxAge: '5m'
  };
</script>

<UsageChart user={session.id} />
```

- SSR emits `<img src={signedUrl} width height>` with the fallback's blur painted — the URL
  minted by the **existing** capability path: HMAC over the same length-prefixed message,
  props serialized + signed (existing 8 KB cap), `maxAge` signed in, probe-rate before HMAC,
  `Sec-Fetch-Site` gating. One new signed field: `format: 'image'` (a harvested HTML capability
  can't be replayed as an image mint or vice versa). Nothing new is trusted.
- The handle's render branch: verify → ssr_render → `engine.render` → `image/png` +
  `Cache-Control: private, max-age=N`.
- **PPR payoff**: a CDN-cached static shell with a per-visitor image hole. **The hole gets a
  preview**: at build, the region's *fallback* render is rastered once and placeholder-encoded;
  the shell paints that blur in the hole. The visitor's image arrives into a frame that already
  has its shape and palette.
- Image holes do **not** join the HTML batch parcel — they're plain `<img>` fetches (mixed
  content types in one stream buys nothing over the browser's parallel image fetch). The
  single-flight batch stays HTML-only.
- `wake` dial = loading strategy: default eager; `wake: 'visible'` → `loading="lazy"`.
- **Live**: not specced for raster. Live regions morph SVG/HTML in place — strictly better
  than bitmap streams. `format: 'image'` on `render: 'live'` is a build error saying so.

## 9. `cards` on `site()` — fields in, region out

The card is what the house already holds renders as: a **region**. One shape, no shorthands —
a bag whose `of` is a function from the page's fields to a region:

```ts
export const docs = site({
  outline: guides,
  cards: {
    of: (page) => region(SocialCard, { title: page.title, eyebrow: page.section }),
    size: [1200, 630],
    format: 'png'          // default; 'jpeg' for photo-heavy cards
  },
  checks: [links(), images(), snapshots()]
});
```

- `page` is the SAME fields surface pages read. `region()` type-checks props against the
  component at the call site — a typo'd prop is a red squiggle today, not a blank card at build.
- Everything the hardcoded v1 shape couldn't do falls out of the one function:

  ```ts
  of: (page) =>
    page.section === 'blog'    ? region(BlogCard, { title: page.title, author: page.data.author })
    : page.slug === '/'        ? region(HomeCard, { stars: page.data.stars })
    : page.data.card === false ? null        // null → no card, no meta, no 404. per-page opt-out.
    : region(DocCard, { title: page.title, summary: page.summary })
  ```

- Per-card override: `of` may return `{ of: region(…), size?, format? }` instead of a bare
  region; the bag's values are the defaults.

  Full type: `{ of: (page) => Region | { of: Region, size?, format? } | null,
  size?: [number, number], format?: 'png' | 'jpeg', fonts?: FontData[] }`. No
  `cards: Component`, no bare-function form — one shape to read, one shape to document.

Mounting is one route, shaped exactly like every other emission (rss/sitemap/llms):

```ts
// src/routes/og/[...slug].png/+server.ts
export const prerender = true;
export const { GET, entries } = docs.emit.cards();
```

- `entries()` = outline leaves where the fn returned non-null; `page()` emits
  `<meta property="og:image">` + width/height for exactly those (origin from
  `site.data.origin`). One declaration, two views, zero drift; no declaration → no meta → no
  surprise 404s.
- **The deferred face is sitting right there**: mount the same emission WITHOUT `prerender`
  and cards raster at request time, cached by your headers — same function, different clock,
  zero new API. (Huge sites, preview deploys.)
- Cached content-addressed in the BuildCache (`raster` namespace). Key: `hash(region.module
  digest, props, size, fonts digest, pipeline version)` — falls straight out of the region
  already holding `module` + `props`. Warm CI re-renders only pages whose card inputs changed.
- Format: PNG default (scrapers don't do AVIF); `format: 'jpeg'` for photo-heavy cards.
- Naming: the emission is `emit.cards()`, config key `cards`. **`emit.og()` is dead** — `og`
  means ogygia (`import.meta.og.*`) and nothing else. The v1 og/og collision is resolved by
  not existing.

## 10. Fonts (satori engine only)

```ts
import inter from '$lib/fonts/Inter-Regular.ttf' with { type: 'font' };
// (string-valued attribute — valid ES. v1's `font: true` didn't parse; booleans can't
// appear in import attributes.)
```

A marked font import inlines the buffer at build (bake-style) and infers name/weight/style
from the file tables. Fonts live on the ENGINE — `satori({ fonts: [inter] })` — with a
per-card `fonts` override in the bag form. Zero fonts + a satori card with text → build error:
"satori renders no text without a font — mark a font import with { type: 'font' } and pass it
to satori()." (SVG-root cards may embed paths and need none; playwright ignores fonts
entirely — it uses the app's real CSS.)

## 11. Organs react to the currency

Each a one-line consequence — no image subsystem behind any of them:

- **Warm** (router): descriptors ride the single-flight nav parcel like any region payload;
  the router preloads the next page's hero variant during the batch. Land → already painted.
- **Morph** (router): the same `id` on both sides of a navigation gets an automatic
  `view-transition-name` derived from it. Blog cover glides into article hero — art crops
  included. Identity IS the transition key.
- **Lakes** (runtime): a lake lifts/restores the `<img>` across body-swap — per-visitor pixels
  survive navigation without a re-mint, and the lake's `maxAge`/`swr` remount policy IS the
  image's client cache policy. Avatar in a persistent header never refetches.
- **Refs** (content): `cover: image()` descriptors ride `refs()` — listings, prev/next cards,
  search results, backlink panels get real thumbnails at shallow-face cost.
- **Blur** (SSR): §2c — the placeholder pipeline default.
- **Checks** (site): `images()` — missing file, missing alt, remote host absent from
  `image.remote`, oversized intrinsic vs rendered, art crop whose aspect matches the default
  (pointless), `ph` token over ~1 KB ("this placeholder rides every ref; lqip at width 32
  costs more than the thumbnail it blurs"). `snapshots()` — playwright screenshots of the
  outline's leaves (check-internal, not a public raster source), content-addressed in the
  BuildCache, diffed against the previous build: a CSS refactor that silently reshapes 12
  pages becomes a named list. (Playwright engine only.)
- **Embed** (emission): a descriptor mounted on a public route is a component usable where
  HTML can't go — GitHub READMEs, emails, RSS readers. `emit.cards()` is one instance; a bare
  `raster()` +server.ts is the general form.
- **Diagram** (markdown): a `mermaid`/`d2` fence renders to SVG at build (crisp, selectable),
  and may wake as a live island for pan/zoom. A diagram is a region that happens to look like
  an image — image identity (morph, warm) *and* region aliveness.

## 12. Failure modes, named at the right clock

- Runtime values in a baked `raster()` → og.bake's existing contract error, pointing at
  `render: 'deferred'` for the per-request clock.
- Unsupported CSS in a satori card → build error citing the property + "the card dialect is
  flexbox + inline styles; render an `<svg>` root for full fidelity."
- Satori card with text, zero fonts → error per §10.
- `snapshots()` check on satori → "route screenshots need a browser — engine: playwright()".
- Static build + plain-remote source + `transform`-less optimizer → error per §2a.
- Remote host not in `image.remote` → build error (macro) / `images()` finding (markdown).
- An op outside the resolved optimizer's `ops` → build error naming the adapter and the op
  ("cloudflare() has no `modulate` — grade with sharp(), or drop the op").
- Unknown `preset` name → build-voice error listing the declared presets.
- `og.image.glob()` matching zero files → build-voice error (checked in DEV too — the
  folder() brace-glob lesson: build-green ≠ dev-green).
- `format: 'image'` on `render: 'live'` → build error per §8.
- Deferred raster without the engine's peers → boot-time error naming the packages.
- Expired/invalid `🏝️/image` sig → 403; the placeholder stays painted — the shell never shows
  a broken-image icon.

## 13. Settle — the law this spec is a cell of

Not an API — a recognition, extracted from the code, that the whole framework follows one
grammar:

```
settle(source, clock, format) → artifact + identity
```

- **Source**: anything renderable — a component, a file, a corpus, a fn.
- **Clock**: when it comes to rest — build (bake is the door), request (the 🏝️ hook is the
  door), continuous (live).
- **Format**: what it comes to rest as — html, pixels, text/xml, a value.
- **Identity**: every settled artifact gets a content-hash id and a shallow face that travels
  instead of the payload — ref (entries), descriptor (pixels), ticket (deferred renders). One
  law, three costumes: *identity travels light, payload settles on a clock, organs react to
  identity.*

Every feature is a cell: bake = (fn, build, value); this spec's macro = (file, build, pixels);
cards = (region, build, pixels) and request-time cards are the same cell on the other clock
(delete `prerender`, zero new API); deferred images = (region, request, pixels); emissions =
(corpus, build|request, text) — llms.txt is the site settled to markdown. The cube predicts
free features (icons = cards with a size list) and vetoes redundant ones (`og.image(Component)`
died because bake already owns that cell; (fn, request, value) is just a Kit remote — don't
build it).

**Not a code unification** — mechanisms stay layered (the preload lesson: 15 mechanisms,
layered, don't merge). satori/devalue/sharp/RSS share a grammar, not a body. Exactly two
places where the grammar becomes literal shared code:

1. **`settle_key()`** (build-cache.ts) — one cache-identity recipe instead of one per feature.
   bake already hand-rolls `hash(fn source + imports)`; this spec hand-rolls two more (cards:
   `hash(module digest, props, size, fonts, version)`; images: `hash(source bytes, ops,
   format, version)`). Same idea three times → one function:

   ```ts
   settle_key({ source: string; inputs?: unknown; format: string; version: string }): string
   //           content digest    props/ops/size    'html'|'image'   pipeline — bump = global invalidation
   ```

   Warm CI, invalidation, and "why did this re-render" become one debugged story.

2. **`format` in the ticket** — the deferred ticket's HMAC becomes
   `(id, props, exp, format: 'html' | 'image')` as a first-class field, not a bolt-on.
   Security: a harvested HTML ticket can't replay against the image branch or vice versa.
   Dispatch: the 🏝️ hook branches on it (ssr_render → HTML vs ssr_render → engine.render →
   PNG); the next format is an enum value + a branch, never a new endpoint or signer.

House rules that fall out (naming law, enforced in review): same words on every settle
surface — `maxAge` never `ttl`, `preset` never `profile`, `format` never `output`/`as`; every
build-clock error names the request clock and vice versa. Design test for any future feature:
*which cell of the cube is this?* If it isn't one, it's a new subsystem wearing a costume.

## 14. Open questions

1. Dev ergonomics: card routes render on demand in dev with the satori error overlaid on a
   placeholder image (broken card visible in situ). Nice; needs a spike.
2. Does the `<Img>` `dark` twin pair with `art` cleanly (dark × crop matrix on the
   descriptor), or is dark-per-crop a bridge too far? Lean: `dark` at the top level only;
   crops inherit the light/dark split.
3. `sizes` authored override on `<Img>` for the rare layout the three intents don't cover —
   escape-hatch prop, or a fourth `layout: 'custom'`?
4. Twitter meta (`twitter:card`) alongside `og:image` in `page()` — emit both by default?
   Lean yes.
5. Icon emission (favicon / apple-touch / manifest) — same raster machinery, natural sibling
   of `emit.cards()`. Separate small spec.
