/**
 * The profiler UI's one stylesheet, injected as a raw `<style>` via Shell's `<svelte:head>` (which
 * `document()` lifts into `<head>`). A single global sheet — not Svelte scoped styles — on purpose:
 * the consumer's build compiles these server-only components with `css: 'external'`, so scoped CSS
 * lands in an asset the routeless profiler page can't link. A raw head `<style>` sidesteps that
 * entirely; the components just use the classes/ids below. Ported verbatim from report.ts's STYLE.
 */
export const PROFILER_STYLE = `
:root { color-scheme: dark; }
* { box-sizing: border-box; margin: 0; }
body { background: #101318; color: #d8dee6; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; padding: 24px; max-width: 1150px; margin: 0 auto; }
h1 { font-size: 20px; margin: 0 0 4px; }
h1 small { color: #7d8590; font-weight: 400; font-size: 13px; margin-left: 8px; }
h2 { font-size: 15px; margin: 32px 0 4px; }
h2 + p.hint { margin: 0 0 10px; }
p.hint { color: #7d8590; font-size: 12.5px; }
a { color: #6cb2ff; text-decoration: none; }
a:hover { text-decoration: underline; }
code { background: #171c24; padding: 1px 5px; border-radius: 4px; font-size: 12.5px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 5px 10px 5px 0; border-bottom: 1px solid #1e232b; vertical-align: top; }
th { color: #7d8590; font-weight: 500; font-size: 12px; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.file { color: #7d8590; font-family: ui-monospace, monospace; font-size: 12px; word-break: break-all; }
td.fn { font-family: ui-monospace, monospace; font-size: 12.5px; }
.chip { display: inline-block; padding: 0 7px; border-radius: 999px; font-size: 11px; line-height: 18px; color: #0d1014; font-weight: 600; }
.summary { display: flex; flex-wrap: wrap; gap: 10px; margin: 16px 0; }
.stat { background: #171c24; border: 1px solid #232a35; border-radius: 8px; padding: 10px 14px; min-width: 108px; }
.stat b { display: block; font-size: 18px; font-variant-numeric: tabular-nums; }
.stat span { color: #7d8590; font-size: 11.5px; }
.verdict { background: #171c24; border-left: 3px solid #e8734a; border-radius: 6px; padding: 12px 16px; margin: 16px 0; font-size: 14px; }
.verdict p + p { margin-top: 6px; }
.bar { height: 14px; border-radius: 3px; min-width: 2px; }
.barrow { display: grid; grid-template-columns: 220px 1fr 90px; gap: 10px; align-items: center; padding: 3px 0; font-size: 13px; }
.barrow .num { text-align: right; font-variant-numeric: tabular-nums; color: #aeb6c2; }
.budget { display: flex; height: 34px; border-radius: 7px; overflow: hidden; border: 1px solid #232a35; margin: 6px 0; }
.budget > div { display: flex; align-items: center; justify-content: center; font-size: 10.5px; color: #0d1014; font-weight: 600; overflow: hidden; white-space: nowrap; min-width: 0; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 6px 0 0; font-size: 11.5px; color: #aeb6c2; }
.legend span { display: inline-flex; align-items: center; gap: 5px; }
.legend i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
.tree { width: 100%; height: 440px; border: 1px solid #232a35; border-radius: 8px; background: #0c0f13; display: block; cursor: pointer; }
.tree-tip { position: fixed; pointer-events: none; background: #1c232d; border: 1px solid #2b3340; border-radius: 6px; padding: 6px 10px; font-size: 12px; display: none; max-width: 420px; z-index: 10; box-shadow: 0 4px 16px #0008; }
.tree-tip b { font-family: ui-monospace, monospace; }
th.sort { cursor: pointer; user-select: none; white-space: nowrap; }
th.sort:hover { color: #d8dee6; }
th.sort.active { color: #6cb2ff; }
th.sort .arr { opacity: 0.5; font-size: 10px; }
td.split { min-width: 160px; }
.split-bar { position: relative; height: 12px; background: #1a212b; border-radius: 3px; overflow: hidden; }
.split-bar .tot { position: absolute; left: 0; top: 0; height: 100%; background: #3a4a5e; border-radius: 3px; }
.split-bar .slf { position: absolute; left: 0; top: 0; height: 100%; border-radius: 3px; }
form.inline { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 10px 0; }
input, select, button { background: #171c24; color: #d8dee6; border: 1px solid #2b3340; border-radius: 6px; padding: 6px 10px; font: inherit; font-size: 13px; }
button { cursor: pointer; background: #22303f; }
button:hover { background: #2b3d50; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 14px 0; }
.btn { display: inline-flex; align-items: center; gap: 7px; padding: 8px 14px; border-radius: 8px; border: 1px solid #2b3340; background: #1c2530; color: #d8dee6; cursor: pointer; font: inherit; font-size: 13px; text-decoration: none; transition: background .12s, border-color .12s; }
.btn:hover { background: #26313f; border-color: #3a4757; }
.btn.primary { background: #24507e; border-color: #356293; color: #eaf1f8; }
.btn.primary:hover { background: #2b5f96; }
.btn[disabled] { opacity: .6; cursor: default; }
.btn .ic { width: 15px; height: 15px; opacity: .85; }
.btn .sub { color: #8a94a2; font-size: 11px; }
.flame { width: 100%; height: 460px; border: 1px solid #232a35; border-radius: 8px; background: #0c0f13; cursor: pointer; }
.flame-tip { position: fixed; pointer-events: none; background: #1c232d; border: 1px solid #2b3340; border-radius: 6px; padding: 6px 10px; font-size: 12px; display: none; max-width: 480px; z-index: 10; box-shadow: 0 4px 16px #0008; }
.flame-tip b { font-family: ui-monospace, monospace; }
.crumb { color: #7d8590; font-size: 12px; margin: 6px 0; min-height: 18px; }
.wf { position: relative; background: #0c0f13; border: 1px solid #232a35; border-radius: 8px; padding: 8px 0; margin: 8px 0; }
.wf-row { position: relative; height: 19px; }
.wf-bar { position: absolute; height: 13px; top: 3px; border-radius: 3px; background: #5b8fd6; min-width: 2px; }
.wf-bar.err { background: #c1544f; }
.wf-bar .body { position: absolute; right: 0; top: 0; height: 100%; background: #3a5d8f; border-radius: 0 3px 3px 0; }
.wf-label { position: absolute; font: 11px ui-monospace, monospace; color: #aeb6c2; top: 2px; white-space: nowrap; }
.spark { display: block; margin: 6px 0; }
.footer { margin-top: 40px; padding-top: 12px; border-top: 1px solid #1e232b; color: #7d8590; font-size: 12px; }
.warn { color: #d9a03d; }
.reqs { display: flex; flex-direction: column; gap: 4px; margin: 8px 0; }
.req { background: #0c0f13; border: 1px solid #232a35; border-radius: 8px; }
.req[open] { background: #0e1219; }
.req-sum { display: grid; grid-template-columns: 48px minmax(0,1fr) 46px auto 68px; gap: 12px; align-items: center; padding: 7px 12px; cursor: pointer; list-style: none; font-size: 12.5px; }
.req-sum::-webkit-details-marker { display: none; }
.req-sum:hover { background: #12161d; }
.req-sum .rm { font-family: ui-monospace, monospace; color: #aeb6c2; font-weight: 600; }
.req-sum .ru { font-family: ui-monospace, monospace; color: #7d8590; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.req-sum .rs { color: #8b93a0; font-variant-numeric: tabular-nums; }
.req-sum .rt { color: #d8dee6; font-variant-numeric: tabular-nums; }
.req-sum .rz { color: #d8dee6; font-variant-numeric: tabular-nums; text-align: right; }
.dim { color: #5c636e; }
.req-detail { padding: 0 12px 12px; }
.req-detail dl { display: grid; grid-template-columns: 132px minmax(0,1fr); gap: 3px 12px; margin: 8px 0 0; font-size: 12.5px; padding-top: 8px; border-top: 1px solid #1c222c; }
.req-detail dt { color: #7d8590; }
.req-detail dd { color: #d8dee6; margin: 0; min-width: 0; }
.req-detail dd.brk { font-family: ui-monospace, monospace; font-size: 12px; word-break: break-all; }
pre.payload { grid-column: 1 / -1; max-height: 600px; overflow: auto; margin: 4px 0 0; padding: 10px 12px; background: #0a0d11; border: 1px solid #1c222c; border-radius: 6px; font: 12px/1.5 ui-monospace, monospace; color: #cdd6e0; white-space: pre; tab-size: 2; }
pre.payload code { display: block; background: transparent; padding: 0; border-radius: 0; font: inherit; color: inherit; }
`;
