# frames — regions, finished

The `frames` branch experiment. Thesis: ogygia doesn't need four new features (address-keyed content,
out-of-order streaming, single-flight mutations, route weaving). It needs ONE primitive, and all four
fall out as facets of it.

## The primitive

A region is a call: `component + props`. The call is the **address**. Everything speaks one wire unit:

```ts
type Frame = { a: string; v: number; html: string };
```

- `a` — the address. For deferred regions this already exists: the signed endpoint URL serializes the
  call (region id + devalue'd props + MAC). Same call → same URL → same address. No new hashing
  scheme needed for v1; held/live regions can join with an explicit address later.
- `v` — a version **ticketed at request time, not write time**. A response carrying an older ticket
  than the last applied write is dropped. This is the entire stale-clobber defense.
- `html` — the payload. HTML in, morph/swap out. No component trees over the wire.

## The invariant

**No code path from network to DOM.** Every arrival — defer fetch, streamed parcel, (later) mutation
fragments, live refresh — writes the store at its address. DOM elements are subscribers that apply
store state to themselves. The store is the only meeting point.

What this buys, mechanically rather than by good intentions:

- A preload/prefetch can never clobber the wrong DOM (different address, nothing bound to it).
- N instances of the same call share ONE fetch (`ensure()` dedupes on the inflight entry).
- A stale response can never overwrite a newer one (ticket check in `write()`).
- Every future channel (OOO stream tail, mutation response, SSE someday) is just another writer.
  Transport is a setting, not architecture.

## The pieces (this slice)

- `src/frame.ts` — Frame type + `frameAddress(endpoint)` (origin-stripped endpoint URL). Shared.
- `src/runtime/frame-store.ts` — the store. `ensure / write / peek / subscribe / abandon`. Pure,
  no DOM, no Svelte; unit-tested to death (the version discipline is load-bearing).
- `runtime/core.ts` — `#fetch_html` and the streamed-parcel path route through the store. The element
  keeps all DOM-side work (lakes settling, attributes, events): it becomes a **binder**. Element
  disconnect `abandon()`s its address; the store aborts the shared fetch only when the LAST waiter
  leaves (one element unmounting must not kill a fetch its twin still awaits).

## Later slices (in order, each writes through the store)

1. **OOO streaming**: `ogygiaHandle` tees the response, keeps it open past Kit's document, flushes
   `<template data-frame>` fragments in settle order; a batch endpoint does the same on navigation.
   Client side is already done — fragments are just store writes.
2. **Single-flight mutations**: commands return regions-as-values with rendered HTML inline (the
   `Region:` transport codec + `__renderHtml` already exist); decode writes the store.
3. **Route weaving**: prescan's route→regions manifest + fire the batch stream in parallel with
   navigation; server renders parent-discovered children into the same stream.

## Deliberately kept

No server reactivity — frames settle once; live = re-invoke + re-frame. HTML + morph as payload.
HMAC capability URLs. Wake schedules orthogonal to content delivery. This is the split with Ryan
Carniato's Solid work: addressing/store/patching generalize across frameworks; reactive re-emission
during the response window doesn't, and we don't want it.
