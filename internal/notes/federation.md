# federation v2 — peers, remote regions, and cross-app thaw (design)

> STATUS: design, not built. Replaces the v1 surface documented in `apps/docs/.../04-federation`
> and `internal/notes/router.md` §federation. v1 has no users (user, 2026-09-02: "no one uses the
> mfe stuff yet, full leash"). Mechanics that v1 proved (signed hops, claims, foreign hydrate,
> wire document, replay defense, chains, traceparent) are KEPT; only the surface and the missing
> freeze integration change.

## The problem, in one paragraph

v1 grew as five verbs and three hand-placed route files: `expose()` + `catalog()` on the MFE (two
`+server.ts`), `client()` + `mount()` + `proxy()` on the shell (one more `+server.ts`), plus
`mount.kit`, `client.widget()`, and a `widgets` allowlist that exists only because `proxy()` turns
browser-chosen input into signed calls. Trust is configured per endpoint, in one direction
(shell → MFE). And there is no relationship at all between a fragment and the freeze store: a shell
page that baked an MFE fragment is frozen with no tag tying it to the MFE's document, the wire
document carries no provenance, the MFE cannot reach the shell, and the shell's fragment SWR cache
is a second stale copy nobody drops. Deploys strand frozen shells on old hashed asset URLs.

## The redesign, in six moves

### 1. One identity per app: `federate()`

```ts
// src/lib/federation.server.ts — the SHELL
export const { cms, dash } = federate({
	name: 'shell',
	key: env.OG_KEY,                       // this app's Ed25519 PRIVATE key (npx ogygia keys shell)
	visitor: (event) => session_from(event.cookies),   // ONE place; c.visitor derives from it
	peers: {
		cms:  { origin: 'http://cms.internal',  key: env.CMS_PUBLIC_KEY,  timeout: 800, cache: { ttl: 30_000 } },
		dash: { origin: ['http://dash-1', 'http://dash-2'], key: [env.DASH_PUB, env.DASH_PUB_OLD] }
	}
});
```

```ts
// src/lib/federation.server.ts — the CMS (an MFE)
export const { shell } = federate({
	name: 'cms',
	key: env.OG_KEY,
	peers: { shell: { origin: 'https://www.example.com', key: env.SHELL_PUBLIC_KEY } },
	expose: cms_router,                    // serve my route table as fragments
	widgets: { kpis: { props: ['org'], make: (props, { user }) => region(Kpis, { ...props, viewer: user }) } }
});
```

- **The peers map is symmetric and bidirectional.** Every app lists every app it talks to, in
  either direction. `peers.X.key` (public, list = rotation overlap) verifies inbound calls FROM X;
  `key` (private) signs outbound calls TO anyone. That is the whole trust config. Audience defaults
  to the peer's origin host (`audience` override per peer for Host-rewriting proxies).
- **`federate()` returns the peers, typed by their names.** `cms`, `dash` are `Peer` handles.
  Nothing else is exported; there is no separate `client()`.
- **No route files.** `federate()` registers with the handle (a `globalThis[Symbol.for(...)]`
  registry, same law as freeze routers). The handle serves everything under `/og/`:
  `/og/fragment/page` (the exposed table), `/og/fragment/<widget>`, `/og/fragment/__catalog`
  (unsigned manifest, as v1), `/og/thaw` (§4), and remote-region capabilities (§2). Kit shells and
  router shells get the same endpoints because the handle is the one thing every ogygia app has.
- `expose`/`widgets` absent = a pure shell; `peers` empty = a pure MFE. Both may be set (chains).
- Fail-closed stays: a `federate()` with `expose`/`widgets` and NO peers with keys refuses with a
  loud error unless `open: true` (v1's `verify: false`), because an exposed endpoint with nobody
  allowed to call it is a config bug, not a choice.

### 2. A remote fragment is a region: `peer.page()` / `peer.widget()`

Both return a **held region value** — the existing `region()` value type, so the wire law, `<Region
of>`, `placeholder`, CSS-travels, and nested-island wake all apply unchanged:

```svelte
<Region of={cms.page('/solar')} />                                   <!-- a remote ROUTE -->
<Region of={dash.widget('kpis', { org }, { render: 'deferred' })}>   <!-- a remote COMPONENT -->
	{#snippet placeholder()}<KpiSkeleton />{/snippet}
</Region>
```

The dials are the region dials, with the same meanings the freeze docs already give them:

| dial | behavior | in a frozen shell |
| --- | --- | --- |
| `render: 'static'` (default) | one buffered signed hop during the shell render; HTML baked | baked into the frozen bytes; thawed by notices (§4) |
| `render: 'deferred'` | a hole; the browser fetches it from the SHELL's handle, which signs and forwards to the peer with the visitor's claims derived at hole time | per-visitor, stays live |
| `render: 'live'` | baked canonical + self-freshen on mount through the same hole endpoint | canonical in the frozen bytes, personal after JS |
| `stitch: 'serve'` | spliced per serve at origin (`private, no-store`) | first response personal, no edge copy |

- **Streamed mounts fold into the model.** A `render: 'deferred'` remote region inside a streamed
  page (`page(async function*)`) arrives down the stream as a late region; inside a buffered page
  the browser fetches it. `mount(cms, { stream: true })` is deleted.
- **`proxy()` and the `widgets` allowlist are deleted.** A deferred remote region's hole URL is a
  SHELL-SIGNED CAPABILITY minted at render (like every deferred region): it names the peer, the
  widget/path, and the props. The browser cannot choose any of them. v1's "props are
  attacker-chosen" caveat disappears with the endpoint that caused it.
- **`client.widget()` is deleted.** `dash.widget('kpis', props)` awaited in a load IS the SSR
  stitch (a bare `await` on a region value bakes its HTML, per the existing region semantics).
- **Whole-app table mounting stays**: `'/cms/[...rest]': mount(cms)` (status/redirects/forms
  translate, canary via `pick`, rollout via `when`) and `mount.kit(cms)` for Kit catch-alls. These
  are ROUTE-level (the MFE owns the URL); regions are SLOT-level (the shell owns the URL). Same
  peer handle underneath.

### 3. Provenance rides the wire

The fragment document gains two fields, both additive:

```ts
{ status, location?, title, css[], body, runtime?,
  sources: [{ id: 'cms/src/lib/cms.ts#loadDoc', fp: 'a91f…' }, { id: '…', fp, via: 'dash' }],
  build: '1788341650' }   // Kit's version.name — changes per deploy
```

- `sources` = the receipts the MFE's render filed (`og.source`, unchanged) PLUS any it adopted
  from ITS peers, path-prefixed by `via`. A chain shell → cms → dash sees dash's receipts as
  `via: 'dash'` on cms's answer.
- The shell's freeze capture adopts them as tags on the stored entry: `s:cms:<id>:<fp>`,
  `s:cms/dash:<id>:<fp>`, plus one blanket tag per peer touched: `a:cms`, `a:cms/dash`.
- The peer's SWR document cache entries carry the SAME tags (today keyed only by path+search+claims).
- No receipts in a fragment (an MFE that declared no sources) = only the blanket `a:<peer>` tag,
  so deploy-thaw still works even for teams that never adopt `og.source`.

### 4. Cross-app thaw: notices

`freeze.invalidate(...)` on any app, in every grammar, already computes what it evicts. After the
local evict + edge purge it now also **notifies every peer**:

```
POST /og/thaw   (signed exactly like a fragment hop: ts, nonce, body hash, audience, claims=none)
{ id: '<uuid>', hop: 0, tags: ['s:<id>:<fp>', …] | 'all' }
```

Receiver (the handle, any app):

1. verify the signature → which peer sent it (key ↔ peer name); replay + freshness as v1.
2. dedupe by `id` (store SETNX with a 10-minute TTL — memory store: in-process set).
3. prefix: `s:<peer>:…` / `all` → `a:<peer>`; evict by tag in the freeze store (existing
   `evictByTag` → keys), purge those keys at every edge (existing fan-out), drop matching SWR
   document-cache entries.
4. forward: if this app has peers that consume IT, re-send with `hop + 1` and tags re-prefixed
   with its own name (`s:cms/dash:…`), `hop ≤ 4`. That is the chain rule: thaw locally, then tell
   whoever holds my bytes.

Sender: `Promise.allSettled` over peers, 3 attempts with backoff (200 ms, 1 s, 5 s), then log.
Like edge purges, a peer that is down never fails a publish. A peer down past the retries falls
back to the TTL backstop (≤ 24 h) — v1 accepts this; a durable outbox is a v2 knob.

**Deploys.** On boot, an app compares Kit's `version.name` with the value under `og:build` in its
freeze store. Different → `notify('all')` to its peers, then store the new value. So a new MFE
build thaws every shell page that baked its fragments (fixing the stranded-hash problem) with
zero config. With the in-process memory store this fires every boot; `federate({ deploy:
'manual' })` turns it off and `freeze.invalidateApp()` does it by hand.

**Freeze off** on a peer = `/og/thaw` answers 204 and does nothing; notices are still sent to it
(cheap) so turning freeze on later needs no re-wiring.

### 5. What freeze sees, and why nothing new is configured

- `freeze.configure({ store, edge })` is unchanged. Federation joins through the registry, not
  through config: if a `federate()` exists, capture adopts remote tags and invalidate notifies
  peers. If it does not, nothing changes.
- **Purity is unchanged and already right.** A static remote region rendered with anonymous
  claims is a pure hop → the shell page freezes with the fragment baked (the canonical, per the
  vary law). `visitor()` reading a session cookie is an observed read → cookied visitors render
  per-request, exactly like a local cookie read. Personalization that must survive freezing lives
  in a deferred/live remote region, exactly like a local one.
- **Experiments**: bucket claims come from flag reads → auto-disqualify. A shell page that
  decides cohorts per visitor is per-request by design (documented, not a bug).

### 6. Deleted, kept, renamed

| v1 | v2 |
| --- | --- |
| `client(origin, { sign, timeout, cache })` | `federate({ peers: { name: { origin, key, timeout, cache } } })` |
| `expose(router, { verify })` + route file | `federate({ expose: router })` (handle-served) |
| `catalog({...}, { verify })` + route file | `federate({ widgets: {...} })` (handle-served) |
| `proxy({ dash }, { widgets })` + route file | deleted — deferred remote regions carry signed capabilities |
| `client.widget(name, props, { claims })` | `await peer.widget(name, props)` |
| `mount(client, { stream, fallback })` | `mount(peer)` (routes only); slots are `peer.page()` regions with dials |
| `routes(table, { visitor })` | `federate({ visitor })` (table option kept as an alias that must agree) |
| `verify.publicKeys` / `sign.privateKey` | `peers.X.key` (public, list) / `key` (private) |
| `mount.kit`, `when`, `pick`, `keys` CLI, `fragments` CLI, traceparent, Server-Timing, CORS story | kept |

## Security review of the changes

- Trust becomes bidirectional but stays per-peer and key-bound: an MFE can only thaw tags under
  its own name because the receiver prefixes with the name the SIGNATURE identifies, never a name
  in the body. A rogue peer cannot thaw another peer's tags.
- `/og/thaw` is signed + replay-guarded + deduped; an unsigned call is a 401 before any work; a
  notice carries no data, only tags, so its blast radius is "re-render some pages".
- Deleting `proxy()` removes the one endpoint that converted browser input into signed calls.
  Capabilities are minted server-side per render; props are sealed and MAC-verified.
- `visitor()` at hole time runs on the shell with the browser's cookies, so a frozen (anonymous)
  shell can still serve personal holes — same posture as a local deferred region.

## Open questions (decide before building)

1. **Peer handle shape**: `federate()` returning the peers map (`const { cms } = federate(...)`)
   vs a namespace (`fed.peers.cms`). Recommendation: return the map — one import line per app.
2. **Deploy detection with the memory store**: broadcast every boot (recommended, loud but
   correct) vs off by default.
3. **Durable outbox** for notices: v1 retries-in-memory; store-backed queue later if a real
   outage bites.

## Build plan (after sign-off)

1. `federate()` + registry + handle-served `/og/*` (port v1 internals; delete route-file exports).
2. Remote regions: `peer.page/widget` → region values with dials; capability mint + handle
   forwarding; delete `proxy`/`stream`/`client.widget`.
3. Wire `sources`/`build`; capture adopts tags; SWR cache tags.
4. `/og/thaw` + notify on invalidate + boot deploy check + chain forwarding.
5. examples/mfe rewritten on v2; e2e: mfe suite + a freeze × federation deck (shell freezes with
   cms fragment → cms publish → shell thaws; cms deploy → shell thaws; chain via dash).
6. Docs page rewritten; SKILL both copies; memory.
