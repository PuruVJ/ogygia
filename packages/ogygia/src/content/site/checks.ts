/**
 * Content CHECKS — corpus-wide invariants that keep docs from rotting, as pluggable VALUES. The link
 * audit is one instance; freshness SLAs, ownership, style linting are others. A check speaks in
 * {@link Finding}s (file-anchored, severity-tagged), and runs two ways:
 *  - `page(slug)` — in `site.load`, so an ERROR finding throws in EVERY render mode (dev open, SSR,
 *    prerender), which Kit's prerender-only crawler can't give you.
 *  - `site()` — whole-corpus, for `site.check()` (CI / vitest / dynamic sites) as plain data, never throws.
 *
 * Structural invariants (orphans, slug collisions, `NN-` verification) are NOT checks — they are
 * always-on build errors in the outline/`folder()`. Checks are opt-in POLICY.
 */
import type { LinkRef } from '../index.js';
import { href_of, type Outline } from './outline.js';
import type { ReadContext } from './site.js';

/** How loud a finding is: `'error'` fails the build (load throws); `'warn'` logs in dev. */
export type Severity = 'error' | 'warn';

/** One check result — file-anchored where possible, so it reads in the build-error voice. */
export type Finding = {
	/** The check that produced it (its `name`). */
	check: string;
	severity: Severity;
	message: string;
	/** The page it belongs to, when page-scoped. */
	slug?: string;
	/** Source file of the page (from the entry's `filePath`), for editor-jumpable errors. */
	file?: string;
	/** Approximate 1-based line, when the finding carries one (e.g. a link's position). */
	line?: number;
};

/** What a check is handed: the address space + the current read context + the mount base. */
export type CheckContext = { outline: Outline; base: string; ctx: ReadContext };

/**
 * A content check. Implement `page` (per-page, runs in `load`), `site` (whole-corpus), or both. A
 * check with only `page` gets a default `site` that runs `page` over every address.
 */
export type Check = {
	name: string;
	page?: (slug: string, cx: CheckContext) => Finding[] | Promise<Finding[]>;
	site?: (cx: CheckContext) => Finding[] | Promise<Finding[]>;
};

/** Pull `headings` off a source-derived meta (`markdown` supplies it), defensively. */
function headings_of(meta: unknown): Array<{ id: string }> {
	if (meta && typeof meta === 'object' && 'headings' in meta) {
		const h = (meta as { headings: unknown }).headings;
		if (Array.isArray(h)) return h as Array<{ id: string }>;
	}
	return [];
}
/** Pull `links` off a source-derived meta (`markdown` supplies it), defensively. */
function links_of(meta: unknown): LinkRef[] {
	if (meta && typeof meta === 'object' && 'links' in meta) {
		const l = (meta as { links: unknown }).links;
		if (Array.isArray(l)) return l as LinkRef[];
	}
	return [];
}
/** Did the format collect link data at all? `links: []` counts; an absent property does not. */
function has_link_data(meta: unknown): boolean {
	return !!meta && typeof meta === 'object' && 'links' in meta;
}

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const TRAILING_SLASHES_RE = /\/+$/;
const EDGE_SLASHES_G = /^\/+|\/+$/g;

/** Tuning for the {@link links} check — the old `audit` options, now on the value. */
export type LinkOptions = {
	/** Validate `#fragments` against the target page's collected headings (default `true`). */
	anchors?: boolean;
	/** Policy for links that resolve through a declared redirect (they WORK, 308, but are stale):
	 *  `'warn'` (default) logs, `'error'` fails the build, `'ok'` stays silent. */
	redirected?: 'error' | 'warn' | 'ok';
	/** Skip hrefs the check should not judge (generated / intentionally external-ish paths). */
	ignore?: (href: string) => boolean;
};

/**
 * The link audit as a check value. Validates each page's in-prose markdown links (`meta.links`,
 * collected by the markdown format) against the site's own address space — missing pages, missing
 * anchors, and stale redirect links. A blocks/CMS corpus that collects no `meta.links` is warned
 * about once (dev), then passes (any format can fill `meta.links` to opt in).
 *
 *   site({ outline: docs, checks: [links()] })
 *   site({ outline: docs, checks: [links({ anchors: false, redirected: 'error' })] })
 */
export function links(opts: LinkOptions = {}): Check {
	const anchors = opts.anchors ?? true;
	const redirected_policy = opts.redirected ?? 'warn';
	const ignore = opts.ignore;
	const warned = new WeakSet<object>();

	const check_page = async (slug: string, cx: CheckContext): Promise<Finding[]> => {
		const hit = await cx.outline.resolve(slug, cx.ctx);
		if (!hit) return [];
		const entry = await hit.collection.get(hit.record.entryId, cx.ctx);
		if (!has_link_data(entry?.meta)) {
			if (!warned.has(hit.collection)) {
				warned.add(hit.collection);
				if (import.meta.env?.DEV) {
					console.warn(
						`[ogygia/content] links() check is on, but '${slug}' comes from a collection whose entries carry no 'meta.links' (only markdown collects them). Link checking is a NO-OP for this corpus — fill 'meta.links' in the format to enable it.`
					);
				}
			}
			return [];
		}
		const file = hit.record.filePath;
		const findings: Finding[] = [];
		const b = (cx.base || '').replace(TRAILING_SLASHES_RE, '');

		for (const link of links_of(entry?.meta)) {
			const href = link.href;
			if (!href || ignore?.(href)) continue;

			let path: string;
			let frag: string | undefined;
			if (href.startsWith('#')) {
				path = slug;
				frag = href.slice(1);
			} else if (URL_SCHEME.test(href) || href.startsWith('//')) {
				continue; // external — not ours to judge
			} else if (href.startsWith('/')) {
				let rest: string;
				if (b && (href === b || href.startsWith(b + '/'))) rest = href.slice(b.length);
				else if (!b) rest = href;
				else continue; // absolute but outside the mount — the app's business
				const [p, f] = rest.split('#');
				path = p.replace(EDGE_SLASHES_G, '');
				frag = f;
			} else {
				continue; // relative (colocated asset etc.) — not judged
			}

			const at = {
				check: 'links',
				slug,
				...(file ? { file } : {}),
				...(link.line !== undefined ? { line: link.line } : {})
			};
			const hit2 = await cx.outline.resolve(path, cx.ctx);
			if (hit2) {
				if (frag && anchors) {
					const target = await hit2.collection.get(hit2.record.entryId, cx.ctx);
					if (!headings_of(target?.meta).some((h) => h.id === frag)) {
						findings.push({
							...at,
							severity: 'error',
							message: `'${href}': missing anchor #${frag}${link.text ? ` — link text "${link.text}"` : ''}`
						});
					}
				}
				continue;
			}
			const canonical = await cx.outline.alias(path, cx.ctx);
			if (canonical) {
				if (redirected_policy !== 'ok') {
					findings.push({
						...at,
						severity: redirected_policy === 'error' ? 'error' : 'warn',
						message: `'${href}' works via redirect_from → update to ${href_of(b, canonical)}`
					});
				}
				continue;
			}
			findings.push({
				...at,
				severity: 'error',
				message: `'${href}': missing page${link.text ? ` — link text "${link.text}"` : ''}`
			});
		}
		return findings;
	};

	return {
		name: 'links',
		page: check_page,
		async site(cx) {
			const out: Finding[] = [];
			for (const slug of await cx.outline.addresses(cx.ctx))
				out.push(...(await check_page(slug, cx)));
			return out;
		}
	};
}

// ── runners (used by ogygia: load throws on errors, site.check() returns data) ──

/** Run every check's `page` pass for one slug. */
export async function run_page_checks(
	checks: Check[],
	slug: string,
	cx: CheckContext
): Promise<Finding[]> {
	const out: Finding[] = [];
	for (const c of checks) if (c.page) out.push(...(await c.page(slug, cx)));
	return out;
}

/** Run every check's whole-corpus pass (default: `page` over every address). */
export async function run_site_checks(checks: Check[], cx: CheckContext): Promise<Finding[]> {
	const out: Finding[] = [];
	for (const c of checks) {
		if (c.site) out.push(...(await c.site(cx)));
		else if (c.page)
			for (const slug of await cx.outline.addresses(cx.ctx)) out.push(...(await c.page(slug, cx)));
	}
	return out;
}

/** Format a page's error findings into ONE thrown message — file-anchored, every finding named. */
export function format_findings(
	slug: string,
	findings: Finding[],
	file: string | undefined
): string {
	const rows = findings.map(
		(f) => `  - [${f.check}] ${f.message}${f.line !== undefined ? ` (line ~${f.line})` : ''}`
	);
	return `[ogygia/content] check failure${findings.length === 1 ? '' : 's'} on '${slug}'${file ? ` (${file})` : ''}:\n${rows.join('\n')}`;
}
