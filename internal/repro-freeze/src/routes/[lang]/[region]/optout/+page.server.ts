// OPT-OUT proof: this page is PURE (reads nothing per-visitor), so under `freeze: true` it would
// normally store. `export const freeze = false` opts it out — the handle must NOT store/serve it.
// It also proves the strip: Kit would throw `Invalid export 'freeze'` without ogygia removing it.
export const freeze = false;
export const load = () => ({ note: 'pure but opted out' });
