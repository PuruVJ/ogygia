// The fixture's brain: per-route REAL render counters (the harness's strongest assertion is
// "second request: render count still 1") + a versioned fake-CMS store the publish webhook bumps.

const renders = new Map<string, number>();

/** Called from loads — counts an ACTUAL Kit render of `pathname` (freeze hits never run it). */
export function count_render(pathname: string): number {
	const n = (renders.get(pathname) ?? 0) + 1;
	renders.set(pathname, n);
	return n;
}

export function render_counts(): Record<string, number> {
	return Object.fromEntries(renders);
}

// ── fake CMS ───────────────────────────────────────────────────────────────────────────────────

const cms = new Map<string, { version: number; body: string }>();

export function cms_read(slug: string): { version: number; body: string } {
	let doc = cms.get(slug);
	if (!doc) {
		doc = { version: 1, body: `content of ${slug} v1` };
		cms.set(slug, doc);
	}
	return doc;
}

/** The "publish": bump the doc version (the webhook then invalidates its URL). */
export function cms_publish(slug: string): { version: number } {
	const doc = cms_read(slug);
	const next = { version: doc.version + 1, body: `content of ${slug} v${doc.version + 1}` };
	cms.set(slug, next);
	return { version: next.version };
}
