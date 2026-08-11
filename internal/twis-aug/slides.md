---
theme: default
title: ogygia — SSR islands for SvelteKit
info: |
  Inventory + pitch for ogygia, with a chapter on Remote Functions inside islands.
  Docs: https://ogygia.puruvj.dev
class: text-left
colorSchema: dark
highlighter: shiki
lineNumbers: false
drawings:
  persist: false
transition: fade-out
fonts:
  # Names for UnoCSS stacks only — faces load via styles/fonts*.css (fontsource, like docs).
  sans: 'Instrument Sans Variable'
  serif: 'Newsreader Variable'
  mono: 'JetBrains Mono Variable'
  provider: none
themeConfig:
  primary: '#6fe3b0'
head:
  - - link
    - rel: preload
      as: font
      type: font/woff2
      crossorigin: anonymous
      href: /node_modules/@fontsource-variable/newsreader/files/newsreader-latin-opsz-italic.woff2
layout: cover
---

<div class="contours" aria-hidden="true">
<svg viewBox="0 0 640 640" fill="none" stroke="currentColor" stroke-width="1">
  <path d="M320 88 C430 84 556 160 566 300 C576 440 480 552 330 556 C180 560 78 452 74 312 C70 172 210 92 320 88 Z" />
  <path d="M322 148 C408 144 502 204 510 306 C518 408 446 496 328 500 C210 504 130 420 126 314 C122 208 236 152 322 148 Z" />
  <path d="M324 206 C388 202 452 246 458 314 C464 382 410 442 326 444 C242 446 180 390 178 316 C176 242 260 210 324 206 Z" />
  <path d="M326 260 C368 258 408 286 412 320 C416 354 380 388 326 390 C272 392 228 360 226 322 C224 284 284 262 326 260 Z" />
  <path d="M328 296 C352 295 372 306 374 322 C376 338 356 354 328 354 C300 354 280 340 279 324 C278 308 304 297 328 296 Z" />
  <path d="M330 318 C340 317 348 321 348 326 C348 331 340 335 330 335 C320 335 313 331 313 326 C313 321 320 319 330 318 Z" />
</svg>
</div>

# ogygia

<div class="subtitle">

SSR islands for SvelteKit. No Kit patches.

</div>

<div class="cover-kicker">

csr = false &nbsp;·&nbsp; ~7.6 KB runtime &nbsp;·&nbsp; real Kit remotes

</div>

<div class="meta">

npm · ogygia &nbsp;·&nbsp; docs · ogygia.puruvj.dev

</div>

<!--
Hey everyone. Today I want to show you Ogygia: SSR islands for SvelteKit, without patching SvelteKit.

The basic promise is simple. The page can stay server-rendered HTML, and only the components that genuinely need JavaScript have to receive it. That sounds like a small performance trick, but it changes how you can build content-heavy pages, partially interactive apps, and even pages that use Kit's Remote Functions.

I’ll start with the problem that pushed me into building this. Then we’ll build up the mental model one piece at a time: islands, lakes, deferred HTML, and the optional router. Once that foundation is clear, we’ll get to the part I care about most—using real SvelteKit Remote Functions inside those islands.

Before all of that, a very quick introduction.
-->

---
layout: center
class: intro text-left
---

<div class="speaker-intro">
  <div class="speaker-copy">
    <div class="eyebrow">Hello</div>
    <h1>Hi, I’m Puru.</h1>
    <p class="speaker-handle">puruvj.dev · @puruvjdev</p>
    <p class="speaker-bio">Svelte Ambassador · works with the Svelte team · conference speaker</p>
    <p class="speaker-motive">I built Ogygia because I wanted Kit pages to stay HTML until a component actually needed JavaScript.</p>
  </div>
  <img class="speaker-avatar" src="/puruvjdev-avatar.jpg" alt="Puru's cat profile picture" />
</div>

<!--
Hi, I’m Puru. You can find me at puruvj.dev, or as puruvjdev on Twitter. And yes, the cat is the official profile picture. At this point it represents me more reliably than an actual headshot.

I’m a Svelte Ambassador, I work with the Svelte team, and I care perhaps a little too much about web performance. I spend a lot of time looking at what frameworks ship to the browser.

Ogygia came out of a very specific frustration. I like SvelteKit. I wanted to keep its server rendering, its routing conventions, and its Remote Functions. But on pages that were mostly content, I kept facing a binary choice: boot the whole client app, or get no component interactivity at all.

I wanted a third answer. That is the story of this talk, and it starts with the choice Kit gives us today.

[Sources]
- Profile photo: https://x.com/puruvjdev
- Image asset: https://pbs.twimg.com/profile_images/1811643663186788352/L01Li01B_400x400.jpg
[/Sources]
-->

---
layout: center
class: text-left
---

<div class="eyebrow">Why this exists</div>

# Kit is all-or-nothing on the client

<div class="compare mt-6">
<div class="card">

### `csr = true`

Whole route boots Kit's client. Fine for apps. Expensive when three widgets need clicks and the rest is prose.

</div>
<div class="vs">vs</div>
<div class="card">

### `csr = false`

No Kit client. Forms still post. Component interactivity? None. Kit has no islands API here.

</div>
</div>

<p class="lede mt-8">

Astro shipped islands years ago. Kit didn't. So I added them on top of Kit instead of forking it.

</p>

<!--
Here is the choice I kept running into.

With `csr` set to true, SvelteKit boots the client for the whole route. For a highly interactive application, that is usually exactly what you want. But imagine a long documentation page with one search box, one chart, and one little counter. The browser still receives the machinery for the whole route, even though almost everything on screen is just prose.

So we can set `csr` to false. Now the page is beautifully simple server HTML. Normal links work. Forms still post. But that little counter cannot wake up on its own, because Kit does not expose an islands API.

That is the gap. I did not want to leave Kit, and I definitely did not want to maintain a fork of it. I wanted to keep the server page and selectively wake up a few components. Once you say the problem that way, the design goal becomes quite clear.
-->

---
layout: center
---

<div class="eyebrow">In one line</div>

# Keep the page as server HTML.<br>Opt components into JS.

<div class="pill-row mt-8">
<span class="pill accent">Vite plugin</span>
<span class="pill accent">WC runtime</span>
<span class="pill accent">server handle</span>
<span class="pill">no Kit patches</span>
<span class="pill">deep-imports remotes</span>
</div>

<p class="dim mt-8" style="max-width: 34em">

Mark an import with `hydrate`, `defer`, or a preset. Unmarked stuff stays SSR HTML. SPA router is optional.

</p>

<!--
So this is the one-sentence answer: keep the page as server HTML, and opt individual components into JavaScript.

Ogygia does that from the outside. A Vite plugin understands which imports are islands. A small browser runtime wakes those regions up. And a server handle can fill signed HTML holes when you want part of a static page to arrive later. SvelteKit itself remains unpatched.

That last point matters throughout this talk. I am not trying to rebuild Kit beside Kit. If you want normal document navigation, you can keep it. If you want soft navigation, the router is optional. And when we reach Remote Functions, those are Kit's own remote primitives—not an Ogygia-flavoured replacement.

That is the promise. Now let’s turn it into a picture we can keep in our heads for the rest of the talk.
-->

---

<div class="eyebrow">Shape</div>

# The page is HTML. Islands opt in.

<div class="arch">
  <div class="arch-page">
    <div class="arch-label">page · csr = false</div>
    <div class="arch-prose">Most of the route stays static markup. No Kit client.</div>
    <div class="arch-row">
      <div class="arch-region">
        <strong>Counter</strong>
        <span>hydrate · load</span>
      </div>
      <div class="arch-region">
        <strong>Chart</strong>
        <span>hydrate · visible</span>
      </div>
      <div class="arch-region defer">
        <strong>Greeting</strong>
        <span>defer · HTML later</span>
      </div>
    </div>
  </div>
  <div class="arch-runtime">
    <span>runtime <em>· custom element</em></span>
    <span>~7.6 KB</span>
  </div>
</div>

<p class="faint mt-4">

Hydrate regions put their module URL on <code>entry</code>. Adding islands does not grow the runtime.

</p>

<!--
This is the mental model I want you to carry from here.

The large box is still a `csr = false` page. It arrived as complete server-rendered HTML, and most of it will remain exactly that. Inside the page are a few regions with different jobs.

The counter wakes up immediately. The chart waits until it is visible. The greeting is different: its HTML itself arrives later from the server. Under all three is one small runtime. It reads the region, waits for the right moment, and either imports that island’s module or fetches the deferred HTML.

Each interactive region carries its own entry URL, so adding another island adds that island’s code, not another copy of the runtime. And if one island contains another, the inner component simply joins the parent’s interactive tree.

So the page remains the unit of HTML, while each region owns its own JavaScript decision. The next question is: what does that feel like to author?
-->

---

<div class="eyebrow">Authoring</div>

# Import attributes are the API

```svelte
<script>
  import Counter from '$lib/Counter.svelte' with { hydrate: 'load' };
  import Chart from '$lib/Chart.svelte' with { hydrate: 'visible' };
  import Greeting from '$lib/Greeting.svelte' with { defer: 'load' };
</script>

<Counter start={10} />
<Chart />
<Greeting name="world">
  {#snippet ogygiaFallback()}<p>loading…</p>{/snippet}
</Greeting>
```

<p class="dim mt-4">

Setup: `ogygia()` before `sveltekit()` in Vite, `ogygiaHandle()` in hooks, `csr = false` on the route.

</p>

<p class="faint mt-4">

Portable component binding: lists and dynamic `<Active />` work normally. Static imports only; lazy work belongs inside a host island.

</p>

<!--
The authoring API is deliberately small. You keep writing a normal Svelte import, then describe the boundary with an import attribute.

`hydrate: 'load'` says this component already has HTML and should wake up immediately. `hydrate: 'visible'` says the same thing, but only once it reaches the viewport. `defer: 'load'` says the component’s HTML should come later, and the `ogygiaFallback` snippet is what the audience sees while that happens.

The project setup is three pieces: put `ogygia()` before `sveltekit()` in Vite, add `ogygiaHandle()` to the server hooks, and set `csr = false` on the routes you want to convert. That can be one route at a time; this is not an all-at-once migration.

The marked import behaves like a real Svelte component binding, which we’ll come back to. The one intentional limitation is dynamic imports with these attributes. Ogygia fails those at build time, because allowing Vite to strip the metadata would produce a silent non-island. First, though, we need one shared vocabulary for when work begins.
-->

---

<div class="eyebrow">Timing</div>

# Same words, different jobs

<dl class="kv mt-4">
  <dt>load</dt><dd>Right away</dd>
  <dt>idle</dt><dd>When the browser is idle</dd>
  <dt>visible</dt><dd>When scrolled into view</dd>
  <dt>'(mq)'</dt><dd>When a media query matches</dd>
  <dt>none</dt><dd>Lake: static HTML inside an island, no lake JS</dd>
</dl>

<div class="grid-2 mt-6">
<div class="card">

### On `hydrate`

When JS starts for that region.

</div>
<div class="card">

### On `defer`

When the placeholder swaps to HTML from the signed endpoint.

</div>
</div>

<p class="dim mt-4">

You can combine: `with { defer: '…', hydrate: '…' }`. Matching schedules coalesce so you don't wait idle twice.

</p>

<!--
Ogygia reuses the same timing words in two different phases, which keeps the API learnable.

`load` means now. `idle` means when the browser has breathing room. `visible` means when the region reaches the viewport. A media query lets the environment decide. And `none` is special—we’ll use that in a moment to make a lake.

The word stays the same, but the job depends on the attribute. With `hydrate`, `visible` controls when JavaScript starts. With `defer`, it controls when the browser asks the server for HTML. You can even combine the two: fetch the HTML on one schedule, then hydrate it on another.

The runtime understands that these are two phases of the same region. If both phases say idle, it does not make you wait twice. If hydration says load after a defer, it starts as soon as the new HTML arrives.

Now that the timing is clear, we can look at what the marked import actually becomes.
-->

---

<div class="eyebrow">Portable bindings</div>

# `A` is the wrapper

```svelte
<script>
  import A from './A.svelte' with { hydrate: 'load' };
  let Active = $state(A);
</script>

<A start={n} />
<Active {...props} />
{#each items as item}<A {...item} />{/each}
```

<div class="grid-2 mt-2">
<div class="card">

### Rules

- Real props, then devalue for the wire
- UI + lakes stay in the island file
- Host children fail build (`ogygiaFallback` ok)

</div>
<div class="card">

### Dedupe

Same path + strategy → one wrapper, one client entry. Many instances share that module; each keeps its own region and props.

</div>
</div>

<!--
An island in Ogygia is a component binding, not a special tag site. That is what makes it feel natural inside Svelte code.

When I import `A` with `hydrate: 'load'`, the binding `A` becomes the island wrapper. I can render it directly, store it in `Active`, or use it repeatedly in a list. Those are all normal Svelte patterns, and they all keep working.

The props are also normal Svelte props during server rendering. At the boundary, Ogygia serializes the captured values with devalue so the browser can reconstruct them. That is why functions, promises, or class instances cannot cross from the host page into an island: they are not portable data. Keep the behaviour inside the island, and pass serializable state in.

For a given component path and strategy, the build creates one shared client entry. A thousand instances reuse that module, while each instance still gets its own server HTML and props.

That gives us a clean interactive boundary. But sometimes, inside that boundary, we still want a large piece of HTML to remain completely asleep. That is what lakes are for.
-->

---

<div class="eyebrow">Lakes</div>

# Static HTML inside an island

<div class="nest">
  <div class="nest-island">
    <div class="arch-label">island</div>
    <div class="nest-lake">
      <div class="arch-label">lake · hydrate: none</div>
      <p class="arch-prose" style="margin:0;font-size:1.3rem">Article body. Zero lake JS.</p>
      <div class="nest-inner">widget · island again</div>
    </div>
  </div>
  <div class="nest-side">
    <div class="arch-label" style="padding-top:0.15rem">on remount</div>
    <div class="nest-chip">
      <strong>cache</strong>
      <p>Keep the HTML you had.</p>
    </div>
    <div class="nest-chip">
      <strong>swr</strong>
      <p>Show stale, then hit the signed endpoint.</p>
    </div>

  </div>
</div>

<!--
Think of a lake as a frozen patch of server HTML inside an otherwise interactive island.

The outer region on the left has JavaScript. But the article body inside it is marked with `hydrate: 'none'`, so Ogygia lifts that DOM out before the parent hydrates and restores it afterwards. The server still rendered the real content, but the lake component’s client JavaScript never ships.

This can nest in a useful way. If the article contains a small widget that is marked as an island again, that widget gets its own boundary and wakes independently. So you can have an interactive shell, a large static body, and then another live component inside the body without turning the whole tree into JavaScript.

The choices on the right matter when that lake reappears after a route change or a conditional. `cache` restores the HTML you already had. `swr` restores it immediately, then revalidates it through the same signed server-region mechanism we are about to see.

Lakes answer “how do I keep HTML asleep inside an island?” The mirror-image question is “how do I leave a hole in the page and render its HTML later?”
-->

---

<div class="eyebrow">Server islands</div>

# HTML later. No JS required.

```svelte
<script>
  import Greeting from '$lib/Greeting.svelte' with { defer: 'load' };
</script>

<Greeting name={user}>
  {#snippet ogygiaFallback()}<p>loading…</p>{/snippet}
</Greeting>
```

<div class="grid-2 mt-6">
<div class="card">

### Contract

Signed capability URL (`?id=&props=&exp=&sig=`). Runtime fetches same-origin HTML and swaps the placeholder. Scripts in that HTML do not run.

</div>
<div class="card">

### Why bother

Prerender the shell to a CDN. Leave a hole. Fill it at request time with personalized HTML. Static page, live greeting.

</div>
</div>

<p class="faint mt-4">

Nested: server island inside an island renders inline (`defer` ignored). One interactive tree, one schedule.

</p>

<!--
That is a server island: show a fallback now, then replace it with server-rendered HTML later. If there is no `hydrate` attribute, that region never needs client JavaScript at all.

The browser does not send an arbitrary component name to a public renderer. The server creates a signed capability URL containing an opaque region id, the serialized props, an expiry, and an HMAC signature. The runtime only fetches that same-origin URL, and the server verifies it before rendering. The returned scripts are inert; this is an HTML swap, not a script injection path.

The practical use case is a mostly static page. You can prerender the shell onto a CDN, leave a small personalized hole, and fill only that greeting—or price, or account summary—at request time.

One security note is worth saying plainly: the signature protects integrity, not secrecy. The URL is a bearer capability, so do not put secrets in the props.

At this point we can build rich pages with almost no client surface. The moment we want those pages to navigate like an app, we need one more optional layer.
-->

---

<div class="eyebrow">SPA · persist</div>

# Opt-in router, durable chrome

<div class="grid-2 mt-4">
<div class="card">

### `<OgygiaRouter />`

Intercepts same-origin clicks, body swap, head merge, view transitions on by default. Without it: full document loads. Still a valid islands app.

</div>
<div class="card">

### `data-ogygia-persist="key"`

Layout chrome survives SPA nav. Islands inside stay mounted. Missing key on either side → remount. Outer key wins.

</div>
</div>

<div class="card mt-6">

### Soft vs hard

**Soft `invalidateAll`:** bust HTML cache, re-fetch, merge head, refresh page/remote seeds in place. No body swap, no VT, no island remount, no nav hooks.

**Hard navigate**: real route change → remount + optional VT.

</div>

<!--
The router is deliberately optional. If you do nothing, links perform normal document navigations, and that is a perfectly complete Ogygia application. For many content sites, I would keep it that way.

If you add `<OgygiaRouter />` to a layout, same-origin links can become soft navigations. The router fetches the next document, merges the head, swaps the body, and uses view transitions by default.

The persist key is how stable layout chrome survives that swap. When the current and incoming documents share the same `data-ogygia-persist` key, Ogygia keeps that DOM and the islands inside it remain mounted. If the key disappears on either side, the region remounts.

There is one distinction here that will become crucial in a minute. A hard navigation changes the document body. A soft invalidation only re-fetches the current URL and refreshes its data seeds in place. It does not remount the islands.

Why make that distinction so carefully? Because a real application does more than click counters. It reads from the server, submits forms, and invalidates data. That is where the project nearly becomes a toy—or becomes genuinely useful.
-->

---
layout: section
---

<div class="contours" aria-hidden="true">
<svg viewBox="0 0 640 640" fill="none" stroke="currentColor" stroke-width="1">
  <path d="M320 88 C430 84 556 160 566 300 C576 440 480 552 330 556 C180 560 78 452 74 312 C70 172 210 92 320 88 Z" />
  <path d="M322 148 C408 144 502 204 510 306 C518 408 446 496 328 500 C210 504 130 420 126 314 C122 208 236 152 322 148 Z" />
  <path d="M324 206 C388 202 452 246 458 314 C464 382 410 442 326 444 C242 446 180 390 178 316 C176 242 260 210 324 206 Z" />
  <path d="M326 260 C368 258 408 286 412 320 C416 354 380 388 326 390 C272 392 228 360 226 322 C224 284 284 262 326 260 Z" />
  <path d="M328 296 C352 295 372 306 374 322 C376 338 356 354 328 354 C300 354 280 340 279 324 C278 308 304 297 328 296 Z" />
  <path d="M330 318 C340 317 348 321 348 326 C348 331 340 335 330 335 C320 335 313 331 313 326 C313 321 320 319 330 318 Z" />
</svg>
</div>

# Remote Functions

<p class="dim mt-4" style="font-size: 2rem">

Islands with Kit remotes. This is the part that made the rest worth building.

</p>

<!--
So far, we have built a convincing islands demo. We can wake a counter, freeze a lake, defer some HTML, and navigate without reloading the whole page.

But this was the point where I had to ask whether Ogygia was actually useful. Real interfaces need server data. They need queries, commands, forms, validation, invalidation, and progressive enhancement. If an island needs a second, Ogygia-specific RPC system to do that, then I have split the application in two and made the architecture worse.

The better answer was much harder, but much cleaner: make SvelteKit’s own Remote Functions run inside the island graph, even though the full Kit client page never boots.

That is the second half of the story. Everything we have covered so far is the foundation that makes this part possible.
-->

---

<div class="eyebrow">Remotes × islands</div>

# Interactivity that talks to the server

<p class="lede mt-4">

Server data comes in as props. Talk-back goes through Kit's own remotes: deep-imported wire codec and client entry, not a parallel RPC layer.

</p>

<div class="grid-2 mt-8">
<div class="card">

### Without remotes

Islands are counters and charts. Classic form actions still work on csr false, and the SPA router doesn't steal the POST.

</div>
<div class="card">

### With remotes

`query` / `command` / `form` / `query.live` / `batch` / `prerender` inside the island. `form()` posts natively with JS off; enhanced submit when JS is on. Same endpoint.

</div>
</div>

<p class="dim mt-6">

SSR resolves queries in-process and seeds the client cache. Adopt what's on screen, no flash of pending.

</p>

<!--
It helps to separate the data flow into two directions.

Data that the server already knows can enter an island as serializable props. For richer interaction going back to the server, the island can import Kit’s own Remote Functions: query, command, form, live query, batch, and prerender.

Ogygia reuses Kit’s wire codec and client runtime rather than inventing a parallel protocol. That means the transport hook still applies, custom types still serialize the Kit way, and `File` arguments still behave as expected.

The progressive-enhancement story also survives. With JavaScript off, a remote form posts natively to Kit’s endpoint. Once the island hydrates, the same form gains enhanced submission, pending state, fields, and issues.

On the first render, queries run in-process on the server. Ogygia places their responses into the document so the island can adopt the data that is already painted instead of flashing back to a pending state.

To see how that works without booting the whole Kit app, let’s walk through the pieces around a single island.
-->

---

<div class="eyebrow">Composition</div>

# Remotes live inside the island

<div class="comp">
  <div class="comp-col">
    <div class="arch-label">SSR seeds</div>
    <div class="comp-item">ogygia-page</div>
    <div class="comp-item">ogygia-remote</div>
  </div>
  <div class="comp-col island">
    <div class="arch-label">island</div>
    <div class="comp-item">query()</div>
    <div class="comp-item">form()</div>
    <div class="comp-item">command()</div>
    <div class="comp-item">query.live</div>
  </div>
  <div class="comp-col">
    <div class="arch-label">Kit endpoint</div>
    <div class="comp-item">POST + CSRF</div>
    <div class="comp-item">single-flight q</div>
    <div class="comp-item">soft invalidate</div>
  </div>
</div>

<p class="comp-note">

`$app/*` shims for island importers only. Under `csr=false`, Kit's client page never boots.

</p>

<!--
The middle column is the interactive island. Inside it, the application imports the familiar Kit primitives: query, form, command, and live query.

The left column is what lets that island begin from the server-rendered state. One document-level seed carries the current page data. Another carries Remote Function responses collected during SSR. The browser applies those seeds before the island starts, so `$app/state` and the remote cache already agree with the HTML on screen.

The right column remains Kit’s endpoint. Form and command posts keep Kit’s CSRF rules and transport behaviour. Ogygia is only providing the isolated client environment around them.

That environment uses narrow `$app/*` shims for island imports, because under `csr = false` there is no Kit client page to provide those modules. The shims expose the current page snapshot and navigation hooks without pretending that the full router is running.

When a form succeeds, Kit normally calls `invalidateAll`. That sounds simple, but in an islands architecture the exact meaning of invalidation decides whether the UI stays alive or gets torn down.
-->

---

<div class="eyebrow">Matching Kit</div>

# Soft invalidate is not a navigation

<div class="compare mt-4">
<div class="card">

### What soft does

- Bust SPA HTML cache
- Re-fetch current URL
- Merge `<head>`
- Refresh page + remote seeds
- Islands stay mounted

</div>
<div class="card">

### What soft does not

- `body.replaceWith`
- View transition
- Island remount
- Clear live query maps
- Auto-refresh live queries
- `beforeNavigate` / `afterNavigate`

</div>
</div>

<p class="lede mt-8">

Kit remote `form()` always calls `invalidateAll` on success. Soft invalidate matches that without tearing down live islands or re-painting stale SSR HTML.

</p>

<!--
Ogygia treats `invalidateAll` as a soft refresh, not as a navigation. It throws away the cached HTML for the current URL, fetches a fresh copy, merges the head, and reapplies the page and Remote Function seeds. The body stays where it is, so every mounted island keeps its local state.

Just as importantly, soft invalidation does not pretend that navigation happened. There is no body swap, no view transition, no remount, and no `beforeNavigate` or `afterNavigate` cycle. Live query instances are not cleared either.

There is one boundary to understand: refreshing the document seed does not automatically update an already-mounted live `Query` object. For single-flight form updates, Kit already has a more precise mechanism, which is what we will look at next.
-->

---

<div class="eyebrow">Single-flight</div>

# `updates` + `requested().refreshAll`

```ts
// island: skip invalidateAll; send refresh keys
await submit().updates(entries);

// .remote.ts: honor keys so POST response includes `q`
await requested(getEntries, 1).refreshAll();
```

<div class="card mt-6">

### Both sides required

`updates` alone only sends keys and skips invalidate. Without `requested`, the POST has no `q` and live `.current` stays stale. Soft invalidate refreshes seeds, not mounted Query instances. Need fresh data: `.refresh()`, or this pair.

</div>

<p class="dim mt-4">

Same guestbook pattern as the docs playground. ogygia reuses Kit's form runtime inside islands.

</p>

<!--
Here is the precise pattern for “submit this form and return the fresh query value in the same response.”

On the island, `submit().updates(entries)` tells Kit which query keys should be refreshed and skips the broad `invalidateAll`. On the server, `requested(getEntries).refreshAll()` sees those keys, recomputes the query, and includes the new result in the form response. The mounted `Query` object can then update its current value immediately.

Both sides are necessary. `updates` by itself only sends the request for fresh keys. If the server never calls `requested`, the response has no refreshed query payload, and the live value remains stale. A soft invalidation does something different: it refreshes the document seeds, not that mounted query instance.

This is the pattern used by the guestbook in the Ogygia playground. You submit, the list updates in the same flight, and the island never remounts.

That closes the loop. We started with a mostly static page, and we now have selective JavaScript that can still use Kit’s real data model. So the final question is not “can this work?” It is “when is this the right trade?”
-->

---

<div class="eyebrow">Fit</div>

# Who should install this

<div class="grid-2 mt-4">
<div>

- Marketing / docs / content with a few interactive bits
- App chrome that still needs Kit loads, remotes, forms
- CDN-static shells + defer personalization
- Gradual adoption, one route at a time
- ~7.6 KB runtime; island entries own their modules

</div>
<div class="card">

### Skip it if

Your whole product is csr=true and everything hydrates anyway. Just use Kit. ogygia is for when the page is mostly HTML.

</div>
</div>

<div class="pill-row mt-8">
<span class="pill accent">SvelteKit native</span>
<span class="pill">no patches</span>
<span class="pill">portable bindings</span>
<span class="pill">lakes + remount</span>
<span class="pill">server islands</span>
<span class="pill">SPA + persist</span>
<span class="pill">remote functions</span>
</div>

<!--
Ogygia is a good fit when the page is mostly HTML and interactivity is the exception.

That could be a marketing site with a few live widgets, documentation with search and playgrounds, or an application shell that still needs Kit loads, forms, and Remote Functions. It also fits the CDN-static case we saw earlier, where deferred regions add request-time personalization to a prerendered page.

Adoption can be gradual. A route can move to `csr = false` when it is ready, while other routes continue using the normal Kit client. The optional router knows to stay out of the way on those `csr = true` pages.

But if almost every component in your product is interactive and the whole route should hydrate, please just use SvelteKit as designed. Ogygia is not a cheaper way to rebuild a fully client-rendered app. It is a way to preserve HTML as the default and spend JavaScript deliberately.

That is the whole story of Ogygia itself: start with server HTML, wake only the regions that need it, keep static content asleep even inside them, defer HTML when useful, and still speak Kit when the island talks back to the server.

Or at least, that was the whole story—until the same experiment made one more missing piece impossible to ignore.
-->

---
layout: section
class: content-reveal
---

# One more thing…

<p class="dim mt-4" style="font-size: 2.16rem">

`@ogygia/content`

</p>

<p class="lede mt-4" style="font-size: 1.68rem; max-width: 34em; margin-inline: auto">

Astro-style content collections, built from SvelteKit Remote Functions. Optional. Separately installed. Not released yet.

</p>

<!--
I said that was the whole story. There is one more thing.

Once Ogygia made a `csr = false` SvelteKit page feel this close to an Astro page, the next missing piece became very obvious: content collections.

So this is `@ogygia/content`. It is not released yet, and it is intentionally not bundled into Ogygia. You install it separately because these are two different decisions. Ogygia decides where JavaScript runs. The content package decides how files or CMS entries become application data.

The important part is that it does not introduce another data framework. It is built directly out of the Remote Functions we just spent time understanding. That keeps content inside the same SvelteKit application model instead of bolting an Astro-shaped island onto the side.

Let me show you the whole API on one slide.
-->

---

<div class="eyebrow">Preview · not released</div>

# Content becomes Kit remotes

```ts
const blog = content({
  from: import.meta.glob('../content/**/*.{svx,md}', { eager: true }),
  format: mdsvex,
  schema: postSchema
});

export const posts = blog.list();
export const post = blog.get({ mode: 'prerender', dynamic: true });
```

<div class="grid-3 mt-4">
<div class="card">

### Bring content

Markdown, JSON, YAML, a CMS fetch, or a push stream.

</div>
<div class="card">

### Keep it honest

Explicit formats, schema validation, filters, mapping, stable ids.

</div>
<div class="card">

### Export Kit

Real `prerender`, `query`, and `query.live` remotes. Pages import only those.

</div>
</div>

<p class="dim mt-4">

`.svx` can contain Ogygia islands. `render()` returns SSR HTML, and the region boundaries survive `{@html}`.

</p>

<!--
The content handle stays private inside a `.remote.ts` file. You give it a source, an explicit format, and a schema. The source can be Markdown or SVX from `import.meta.glob`, JSON, YAML, a one-time CMS fetch, or even a stream that keeps pushing new entries.

Then `.list()` and `.get()` mint real Kit remotes. Static files naturally become `prerender` remotes with generated inputs. An async CMS can use `query`. A streaming source can become `query.live`. The page never imports the catalog or the filesystem—it imports only the remotes and calls them like the rest of the app.

The experiment goes one step further. An SVX entry can contain Ogygia islands of its own. The content remote server-renders that entry to HTML, the page inserts it with `{@html}`, and the Ogygia region boundaries survive. So a Markdown article can contain a hydrated counter or a deferred server region without turning the entire article into a client app.

For content-heavy sites, this is the point where SvelteKit plus Ogygia can replace Astro while staying deeply integrated with Kit: one router when you want it, one Remote Functions model, one schema boundary, and islands all the way through the content. But it remains opt-in. Install it only when you want the content layer.

It is not on npm yet. Consider this the teaser.
-->

---
layout: center
class: text-left
---

<div class="eyebrow">Get Ogygia</div>

# Links

<div class="links">

<a href="https://www.npmjs.com/package/ogygia">npmjs.com/package/ogygia</a>
<a href="https://ogygia.puruvj.dev">ogygia.puruvj.dev</a>
<a href="https://github.com/PuruVJ/ogygia">github.com/PuruVJ/ogygia</a>
<a href="https://ogygia.puruvj.dev/playground">playground · strategies · remotes · router</a>

</div>

<p class="dim mt-10">

MIT · built on SvelteKit · inventory talk, not a framework pitch.

</p>

<!--
If you want to try it, the one address to remember is ogygia.puruvj.dev.

The docs cover installation, every timing strategy, lakes, server regions, the router, and the Remote Functions setup. The playground includes the pieces I cannot demonstrate properly inside this Slidev deck—especially the guestbook flow, router behaviour, and the different hydration schedules.

The package name on npm is simply `ogygia`, and the source is on GitHub under PuruVJ. It is MIT licensed. `@ogygia/content` is still a preview in that repository, so please do not go looking for a published package just yet.

The project is still moving, so if the deck and the docs ever disagree, trust the docs and the current package.

I’ll leave these links up for a moment. Then I’d love to hear where this model feels useful, where it feels suspicious, or which boundary you want to pull apart.
-->

---
layout: center
---

# Questions

<p class="dim mt-4">

Hydrate · defer · lakes · remotes · `@ogygia/content`

</p>

<div class="meta mt-10" style="font-family: var(--slidev-font-mono); font-size: 1.28rem; color: var(--ogy-faint);">

ogygia.puruvj.dev

</div>

<!--
Thank you.

I’m happy to go deeper on any part of the path we just walked: how the signed defer boundary works, how lakes survive hydration, what happens to live queries across soft navigation, or how the Ogygia router coexists with ordinary `csr = true` Kit routes.

And please challenge the design. If one of these boundaries feels wrong, or you think Kit already provides a cleaner path, that is a much more interesting conversation than a polite question.

If we need a place to start, ask me about the difference between soft invalidation and the `updates` plus `requested` pair. They sound similar, but they refresh two different kinds of state, and that distinction is one of the most useful lessons from building this.

The docs are at ogygia.puruvj.dev. Thanks again.
-->
