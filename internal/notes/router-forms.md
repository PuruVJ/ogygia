# Route value: Object form vs Builder form — exhaustive comparison

Both forms give **fully typed `c.params`** (proven by tsc probes). The only form that
provably *cannot* type params is the bare fluent `view(Doc).load(...)` with no wrapper —
so it's out. What's left is a pure taste call between these two.

Goal for both: **maximum SvelteKit fidelity** — a Kit dev should transfer 1:1.

---

## The vocabulary of each form

### Object form — keys ARE Kit's `+file` exports

```ts
type RouteDef<P> =
  | { page, load?, actions?, layout?, error?, guard?, ...pageOpts }   // +page.* 
  | { layout, load?, error?, guard?, routes }                        // +layout.* + children
  | { GET?, POST?, PUT?, PATCH?, DELETE?, OPTIONS?, HEAD?, ...opts }  // +server.ts
  | ((c) => Answer)                                                   // quick handler / dynamic
  | Router                                                            // sub-router mount
```

### Builder form — a `(r) => …` callback; `r` carries the key's params

```ts
type Entry<P> = (r: R<P>) => Built
interface R<P> {
  page(Comp):   PageB<P>     // .load .action .actions .layout(reset) .set .guard
  layout(Comp): LayerB<P>    // .load .error .guard .routes(table)   ← .routes is terminal
  GET(fn): EndpointB<P>; POST(fn); PUT(fn); PATCH(fn); DELETE(fn); OPTIONS(fn); HEAD(fn)
  mount(router): Built
}
```

---

## 1. The simplest page (bare `+page.svelte`)

**Object**
```ts
'/': { page: Home },
```

**Builder**
```ts
'/': (r) => r.page(Home),
```

---

## 2. Static page with fixed data

**Object**
```ts
'/pricing': { page: Pricing, load: () => ({ plans: PLANS }) },
```

**Builder**
```ts
'/pricing': (r) => r.page(Pricing).load(() => ({ plans: PLANS })),
```

---

## 3. Dynamic page — load reads a typed param

**Object**
```ts
'/docs/[slug]': {
  page: Doc,
  load: (c) => ({ doc: getDoc(c.params.slug) }),   // c.params.slug: string
},
```

**Builder**
```ts
'/docs/[slug]': (r) =>
  r.page(Doc).load((c) => ({ doc: getDoc(c.params.slug) })),   // c.params.slug: string
```

---

## 4. Load that redirects / errors (Kit's `redirect()` / `error()`)

**Object**
```ts
'/account': {
  page: Account,
  load: (c) => {
    if (!c.locals?.user) return c.redirect('/login');   // 303
    const acct = getAccount(c.locals.user.id);
    if (!acct) return c.error(404, 'no account');
    return { acct };
  },
},
```

**Builder**
```ts
'/account': (r) =>
  r.page(Account).load((c) => {
    if (!c.locals?.user) return c.redirect('/login');
    const acct = getAccount(c.locals.user.id);
    if (!acct) return c.error(404, 'no account');
    return { acct };
  }),
```

---

## 5. Page with a default form action (`+page.server.ts` `actions.default`)

**Object**
```ts
'/contact': {
  page: Contact,
  actions: { default: (c) => { saveMessage(c); return { ok: true }; } },
},
```

**Builder**
```ts
'/contact': (r) =>
  r.page(Contact).action((c) => { saveMessage(c); return { ok: true }; }),
```

---

## 6. Page with named form actions (`?/login`, `?/register`)

**Object**
```ts
'/auth': {
  page: Auth,
  actions: {
    login:    (c) => doLogin(c),
    register: (c) => doRegister(c),
  },
},
```

**Builder**
```ts
'/auth': (r) =>
  r.page(Auth)
   .action('login',    (c) => doLogin(c))
   .action('register', (c) => doRegister(c)),
```

---

## 7. The full page — load + actions + reset + options together

**Object**
```ts
'/posts/[id]/edit': {
  page: EditPost,
  load: (c) => ({ post: getPost(c.params.id) }),
  actions: {
    save:   (c) => savePost(c.params.id, c),
    delete: (c) => { deletePost(c.params.id); return c.redirect('/posts'); },
  },
  layout: DashShell,      // reset: render inside DashShell, drop deeper shells
  prerender: false,
},
```

**Builder**
```ts
'/posts/[id]/edit': (r) =>
  r.page(EditPost)
   .load((c) => ({ post: getPost(c.params.id) }))
   .action('save',   (c) => savePost(c.params.id, c))
   .action('delete', (c) => { deletePost(c.params.id); return c.redirect('/posts'); })
   .layout(DashShell)     // reset
   .set({ prerender: false }),
```

---

## 8. Layout reset — bare page (Kit's `+page@.svelte`)

**Object**
```ts
'/login': { page: Login, layout: false },   // no chrome at all
```

**Builder**
```ts
'/login': (r) => r.page(Login).layout(false),
```

---

## 9. Endpoint — single method (`+server.ts` `GET`)

**Object**
```ts
'/api/health': { GET: (c) => c.json({ ok: true }) },
```

**Builder**
```ts
'/api/health': (r) => r.GET((c) => c.json({ ok: true })),
```

Or, for a one-liner endpoint, the bare handler is allowed in BOTH (a function value is
always an endpoint; GET by default):
```ts
'/api/health': (c) => c.json({ ok: true }),
```

---

## 10. Endpoint — multi-method (`+server.ts` GET + POST + DELETE)

**Object**
```ts
'/api/items/[id]': {
  GET:    (c) => c.json(getItem(c.params.id)),
  PUT:    (c) => c.json(putItem(c.params.id, c)),
  DELETE: (c) => { removeItem(c.params.id); return new Response(null, { status: 204 }); },
},
```

**Builder**
```ts
'/api/items/[id]': (r) =>
  r.GET((c) => c.json(getItem(c.params.id)))
   .PUT((c) => c.json(putItem(c.params.id, c)))
   .DELETE((c) => { removeItem(c.params.id); return new Response(null, { status: 204 }); }),
```

---

## 11. Endpoint with schema-gated input (Standard Schema: Zod/Valibot)

**Object**
```ts
'/api/search': {
  GET: { schema: SearchQuery, handler: (c) => c.json(search(c.input)) },   // c.input typed
},
```

**Builder**
```ts
'/api/search': (r) =>
  r.GET(SearchQuery, (c) => c.json(search(c.input))),   // overload: (schema, handler); c.input typed
```

> Note: the object form gets a little clunky here — a method value has to become
> `{ schema, handler }` to carry the schema. The builder's `GET(schema, handler)` overload
> reads cleaner. First real ergonomic split between the two.

---

## 12. Layout layer — chrome + load + children (`+layout.svelte` + `+layout.ts`)

**Object**
```ts
'/docs': {
  layout: DocsLayout,
  load: (c) => ({ nav: getNav() }),
  routes: {
    '/':       { page: DocsHome },
    '/[slug]': { page: Doc, load: (c) => ({ doc: getDoc(c.params.slug) }) },
  },
},
```

**Builder**
```ts
'/docs': (r) =>
  r.layout(DocsLayout)
   .load((c) => ({ nav: getNav() }))
   .routes({
     '/':       (r) => r.page(DocsHome),
     '/[slug]': (r) => r.page(Doc).load((c) => ({ doc: getDoc(c.params.slug) })),
   }),
```

---

## 13. Deeply nested layouts (app → docs → api-ref)

**Object**
```ts
{
  layout: AppShell,
  load: (c) => ({ user: c.locals?.user }),
  routes: {
    '/docs': {
      layout: DocsShell,
      load: () => ({ nav: getNav() }),
      routes: {
        '/api': {
          layout: ApiShell,
          load: () => ({ symbols: getSymbols() }),
          routes: {
            '/[symbol]': { page: Sym, load: (c) => ({ sym: getSym(c.params.symbol) }) },
          },
        },
      },
    },
  },
}
```

**Builder**
```ts
(r) => r.layout(AppShell)
  .load((c) => ({ user: c.locals?.user }))
  .routes({
    '/docs': (r) => r.layout(DocsShell)
      .load(() => ({ nav: getNav() }))
      .routes({
        '/api': (r) => r.layout(ApiShell)
          .load(() => ({ symbols: getSymbols() }))
          .routes({
            '/[symbol]': (r) => r.page(Sym).load((c) => ({ sym: getSym(c.params.symbol) })),
          }),
      }),
  })
```

> The builder's `.routes({...})` closes each layer, so deep nesting stacks `(r) => …` at
> every level. The object form nests plain braces. At depth, the object form has fewer
> moving parts per level; the builder has more punctuation but clearer "this layer ends here".

---

## 14. Error boundary (`+error.svelte`)

**Object**
```ts
'/docs': {
  layout: DocsLayout,
  error: DocsError,       // shown when a load under here throws/errors
  load: () => ({ nav }),
  routes: { … },
},
```

**Builder**
```ts
'/docs': (r) =>
  r.layout(DocsLayout).error(DocsError).load(() => ({ nav })).routes({ … }),
```

---

## 15. Guards — table-wide (whole subtree) and per-route

**Object**
```ts
// whole subtree: guard on the layer node
'/admin': {
  layout: AdminShell,
  guard: requireAdmin,           // runs before anything under /admin
  routes: {
    '/':        { page: AdminHome },
    '/users':   { page: Users, guard: auditLog },   // per-route, composes on top
  },
},
```

**Builder**
```ts
'/admin': (r) =>
  r.layout(AdminShell).guard(requireAdmin).routes({
    '/':      (r) => r.page(AdminHome),
    '/users': (r) => r.page(Users).guard(auditLog),
  }),
```

---

## 16. Sub-router mount (a library owning a subtree, its own `base`)

**Object**
```ts
'/blog': mountBlog,     // mountBlog = routes({ … }) from elsewhere; a Router value is a route value
```

**Builder**
```ts
'/blog': (r) => r.mount(mountBlog),
```

---

## 17. Dynamic component — pick a view at request time (beyond Kit)

Both use the bare handler; the handler returns a rendered view.

**Object & Builder (identical — it's just a handler)**
```ts
'/entry/[id]': (c) => {
  const e = getEntry(c.params.id);
  if (!e)          return c.error(404);
  if (e.kind === 'video') return view(VideoEntry, { e });
  return view(ArticleEntry, { e });
},
```

> `view(Comp, data)` here is the *render value* a handler returns (a held region), NOT the
> route-level page def. Same in both forms.

---

## 18. Every param shape (identical patterns, both forms)

```ts
'/docs/[slug]'          // { slug: string }
'/files/[...path]'      // { path: string }        (rest)
'/[[lang]]/about'       // { lang?: string }        (optional)
'/report/[id].json'     // { id: string }           (intra-segment)
'/[y]/[m]/[d]'          // { y: string; m: string; d: string }
```

---

## 19. Typed `href` (rename-safe links) — same in both

```ts
c.href('/docs/[slug]', { slug: 'intro' })       // "/docs/intro"  — params typed & required
c.href('/report/[id].json', { id: '42' })       // "/report/42.json"
c.href('/')                                       // "/"            — no params, none required
```

---

## 20. Page component side (identical — pure Kit)

```svelte
<!-- DocsLayout.svelte  (a +layout.svelte) -->
<script>let { data, children } = $props();</script>
<nav>{#each data.nav as l}<a href={l.href}>{l.title}</a>{/each}</nav>
{@render children()}

<!-- Doc.svelte  (a +page.svelte) -->
<script>let { data, form } = $props();</script>   <!-- data = load result + cascade; form = action result -->
<h1>{data.doc.title}</h1>
{#if form?.ok}<p>Saved.</p>{/if}
```

---

## A full realistic app — side by side

### Object form

```ts
export const router = routes({
  layout: AppShell,
  load: (c) => ({ user: c.locals?.user, theme: c.cookies?.get('theme') }),
  guard: rateLimit,
  routes: {
    '/':          { page: Home, prerender: true },
    '/login':     { page: Login, actions: { default: doLogin }, layout: false },
    '/logout':    (c) => { c.cookies?.delete('sid'); return c.redirect('/'); },

    '/docs': {
      layout: DocsLayout,
      load: () => ({ nav: getNav() }),
      error: DocsError,
      routes: {
        '/':       { page: DocsHome },
        '/[slug]': { page: Doc, load: (c) => ({ doc: getDoc(c.params.slug) }) },
      },
    },

    '/dashboard': {
      layout: DashShell,
      guard: requireAuth,
      load: (c) => ({ stats: getStats(c.locals!.user.id) }),
      routes: {
        '/':            { page: Dash },
        '/posts':       { page: Posts, load: (c) => ({ posts: myPosts(c) }) },
        '/posts/[id]':  {
          page: EditPost,
          load: (c) => ({ post: getPost(c.params.id) }),
          actions: { save: savePost, delete: delPost },
        },
      },
    },

    '/api/search':      { GET: { schema: SearchQuery, handler: (c) => c.json(search(c.input)) } },
    '/api/items/[id]':  { GET: (c) => c.json(getItem(c.params.id)), DELETE: (c) => c.json(del(c)) },
  },
});
```

### Builder form

```ts
export const router = routes((r) =>
  r.layout(AppShell)
   .load((c) => ({ user: c.locals?.user, theme: c.cookies?.get('theme') }))
   .guard(rateLimit)
   .routes({
     '/':       (r) => r.page(Home).set({ prerender: true }),
     '/login':  (r) => r.page(Login).action(doLogin).layout(false),
     '/logout': (c) => { c.cookies?.delete('sid'); return c.redirect('/'); },

     '/docs': (r) => r.layout(DocsLayout).error(DocsError)
       .load(() => ({ nav: getNav() }))
       .routes({
         '/':       (r) => r.page(DocsHome),
         '/[slug]': (r) => r.page(Doc).load((c) => ({ doc: getDoc(c.params.slug) })),
       }),

     '/dashboard': (r) => r.layout(DashShell).guard(requireAuth)
       .load((c) => ({ stats: getStats(c.locals!.user.id) }))
       .routes({
         '/':           (r) => r.page(Dash),
         '/posts':      (r) => r.page(Posts).load((c) => ({ posts: myPosts(c) })),
         '/posts/[id]': (r) => r.page(EditPost)
           .load((c) => ({ post: getPost(c.params.id) }))
           .action('save', savePost).action('delete', delPost),
       }),

     '/api/search':     (r) => r.GET(SearchQuery, (c) => c.json(search(c.input))),
     '/api/items/[id]': (r) => r.GET((c) => c.json(getItem(c.params.id)))
                                 .DELETE((c) => c.json(del(c))),
   }),
);
```

---

## Honest trade-offs

| | Object form | Builder form |
|---|---|---|
| Kit transfer | **1:1** — keys literally are `+file` exports | close, but `.page()/.load()` is a new idiom |
| Simple page | `{ page: Home }` | `(r) => r.page(Home)` |
| Ceremony per route | none | a `(r) =>` wrapper on every non-handler route |
| Schema endpoint | `{ GET: { schema, handler } }` (clunky) | `r.GET(schema, handler)` (clean) |
| Deep nesting | plain braces, fewer tokens/level | `(r) =>` + `.routes()` per level |
| Reads like | a config object / JSON | a fluent DSL |
| Discoverability | keys via autocomplete on the object | methods via autocomplete on `r.` |
| Extra keys later | just add a key | add a method |
| Bare handler | supported (endpoints/dynamic) | supported (same) |

**My read:** the object form wins on your stated north star (maximum Kit, transferable,
idiomatic) — every key is a Kit file export, zero new vocabulary, and it reads like the
`+page`/`+layout` files a Kit dev already knows. The builder wins only on the schema-endpoint
line and on "feels like a fluent DSL." The `(r) =>` wrapper is pure tax on every route.

The one place the object form is clunky (schema endpoints, #11) is fixable without the
builder: allow `get(schema, handler)` as a small value helper inside the object —
`{ GET: get(SearchQuery, handler) }` — so you keep the object everywhere and still get the
clean schema spelling.
