# Images — spec (design only, not built)

The thesis: **an image is a region whose output is pixels.** Pixels settle on the same clock as
HTML — at build (`static`), per request (`deferred`), or continuously (`live`) — and a
component-rendered image is the same machinery with a raster step appended.

This file specs the component→pixels path (OG cards and friends) end to end, plus the descriptor
and provider contracts the photograph path shares.

---

## 1. The raster pipeline

```
component ──ssr_render──▶ HTML ──satori-html──▶ satori tree ──satori──▶ SVG ──resvg──▶ PNG/JPEG
                            │
                            └── root is <svg>? ──────────────────────────▶ resvg direct
```

- **Tier A (default): the card dialect.** The component SSRs to HTML; `satori-html` lifts it;
  `satori` does text layout + flexbox and emits positioned SVG; `@resvg/resvg-js` rasterizes.
  This is the `@vercel/og` stack — proven on serverless, no headless browser, WASM-capable.
  The cost: satori renders a **subset** — flexbox only (no grid/float), inline styles only,
  explicit dimensions on the root. This is the accepted DX of the whole OG-image ecosystem;
  we document it as "the card dialect" with build-voice errors naming the unsupported property.
- **Tier B (escape hatch): SVG root.** If the component's rendered root is `<svg>`, satori is
  skipped entirely — resvg rasterizes directly. Full Svelte power, full SVG fidelity, text
  wrapping is on you. Mode is **inferred from the output**, never configured.
- All three packages are **optional peers**, lazily imported only on the raster path (the
  orama/bits-ui/mdsvex pattern). A build with no raster usage never loads them.

Order-of-magnitude budget (to verify in a spike): satori ~30–80 ms/card, resvg ~5–30 ms at
1200×630. Fine per-request on a server; fine at build behind the cache.

## 2. One macro, two sources

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

## 3. The OG emission — cards for every page

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

## 4. Pixels per request — the deferred raster

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

## 5. Fonts (satori's hard requirement)

Satori needs raw font data — no system fonts, no CSS `@font-face`. Spec:

```ts
import interRegular from '$lib/fonts/Inter-Regular.ttf' with { font: true };  // → { name, data, weight, style }
```

A marked font import inlines the buffer at build (bake-style) and infers name/weight/style from
the file tables. `og: { fonts: [...] }` and the macro's `fonts` option take these values.
Zero fonts + Tier A card → build error: "satori renders no text without a font — mark a font
import and pass it." (Tier B SVG cards may embed paths and need none.)

## 6. The descriptor (shared with the photograph path)

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

## 7. Failure modes, named

- Unsupported CSS in a Tier A card → build error citing the property + "the card dialect is
  flexbox + inline styles; render an `<svg>` root for full fidelity."
- Runtime props in the static macro → error pointing at `render: 'deferred'`.
- Missing fonts (Tier A, has text) → error per §5.
- Deferred raster on a runtime without the peers → boot-time error naming the three packages.
- `images()` check (separate spec): missing file / missing alt / oversized intrinsic vs rendered.

## 8. Open questions

1. `as: 'image'` vs `render: 'image'` — spec assumes `as:` (output target, orthogonal to when).
2. Does `emit.og()` allow per-SECTION card components (`og: { card, overrides: { blog: BlogCard } }`)? Lean yes, later.
3. Dev ergonomics: `/og/<slug>.png` renders on demand in dev with the satori error overlaid on a
   placeholder image (so the broken card is visible in situ). Nice; needs a spike.
4. JPEG/quality knobs for the photograph path live where — descriptor opts or provider config?
