/**
 * THIRD PARTIES — what other origins cost this page, from what the browser measured: their files and
 * bytes (resource timing), the ones that held the first paint, the scripts that loaded more scripts
 * at runtime (a tag manager's shape), and their main-thread time when there is a CPU trace. Pure, so
 * the devtools Page tab and the profiler report run the same analysis on the same visit.
 *
 * Detection is by behavior (another origin; blocking; CPU; a script whose arrival is followed by
 * scripts nothing in the page names). The host table only puts a readable label on well-known
 * public services — a host it does not know is still measured, as "other".
 */

export type ThirdPartyKind = 'tag manager' | 'analytics' | 'ads' | 'session replay' | 'chat' | 'a/b testing' | 'consent' | 'fonts' | 'library cdn' | 'other';

/** host suffix → what that kind of service is (labels only; detection does not need them) */
const KNOWN: [string, ThirdPartyKind][] = [
	['googletagmanager.com', 'tag manager'],
	['tiqcdn.com', 'tag manager'],
	['tealiumiq.com', 'tag manager'],
	['adobedtm.com', 'tag manager'],
	['segment.com', 'tag manager'],
	['google-analytics.com', 'analytics'],
	['analytics.google.com', 'analytics'],
	['plausible.io', 'analytics'],
	['mxpnl.com', 'analytics'],
	['amplitude.com', 'analytics'],
	['heapanalytics.com', 'analytics'],
	['hotjar.com', 'session replay'],
	['fullstory.com', 'session replay'],
	['clarity.ms', 'session replay'],
	['mouseflow.com', 'session replay'],
	['doubleclick.net', 'ads'],
	['googlesyndication.com', 'ads'],
	['googleadservices.com', 'ads'],
	['facebook.net', 'ads'],
	['licdn.com', 'ads'],
	['bing.com', 'ads'],
	['ads-twitter.com', 'ads'],
	['intercom.io', 'chat'],
	['intercomcdn.com', 'chat'],
	['zdassets.com', 'chat'],
	['crisp.chat', 'chat'],
	['optimizely.com', 'a/b testing'],
	['visualwebsiteoptimizer.com', 'a/b testing'],
	['abtasty.com', 'a/b testing'],
	['cookielaw.org', 'consent'],
	['onetrust.com', 'consent'],
	['cookiebot.com', 'consent'],
	['usercentrics.eu', 'consent'],
	['fonts.googleapis.com', 'fonts'],
	['fonts.gstatic.com', 'fonts'],
	['typekit.net', 'fonts'],
	['jsdelivr.net', 'library cdn'],
	['unpkg.com', 'library cdn'],
	['cdnjs.cloudflare.com', 'library cdn'],
	['esm.sh', 'library cdn']
];

export function kind_of_host(host: string): ThirdPartyKind {
	for (const [suffix, kind] of KNOWN) if (host === suffix || host.endsWith('.' + suffix)) return kind;
	return 'other';
}

export interface ThirdPartyOrigin {
	host: string;
	kind: ThirdPartyKind;
	files: number;
	scripts: number;
	/** decoded bytes of its scripts */
	script_bytes: number;
	/** its scripts the browser gave no size for (some engines hide every other origin's sizes,
	 *  even with Timing-Allow-Origin): `script_bytes` leaves them out */
	unsized: number;
	/** every byte on the wire */
	wire: number;
	/** files that held the first paint */
	blocking: number;
	/** when its first file started (ms from navigation) */
	first: number;
	/** main-thread ms in its scripts (a CPU trace), else null */
	cpu_ms: number | null;
}

export interface ThirdParty {
	origins: ThirdPartyOrigin[];
	script_bytes: number;
	unsized: number;
	/** scripts whose size the browser hid and that were weighed apart from the visit */
	weighed: number;
	wire: number;
	blocking: number;
	cpu_ms: number | null;
	/** third-party scripts that started after another third-party script arrived and that no
	 *  document ref names: loaded at runtime (by a tag manager, a loader) */
	runtime_loaded: number;
}

interface Res {
	url: string;
	type: string;
	start: number;
	end: number;
	transfer?: number;
	size?: number;
	blocking?: boolean;
	/** a size the browser hid, weighed apart from the visit */
	weighed?: true;
}

function host_of(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return '';
	}
}

/** `named`: URLs the server's HTML references (its scripts, preloads, their imports) — another
 *  origin's script not among them came at runtime. Without it (the live page already holds the
 *  injected script elements), `parsed`: when the HTML was parsed (domInteractive) — a script that
 *  starts after that and after another origin's script ran was loaded by a script. `in_page`: the
 *  URLs the live document holds — a script no element names came by an import or a fetch (a
 *  self-loading library's parts), whenever it started. */
export function third_party(resources: readonly Res[], page_origin: string, cpu_by_host: ReadonlyMap<string, number> | null, named?: ReadonlySet<string>, parsed?: number, in_page?: ReadonlySet<string>): ThirdParty | null {
	const page_host = host_of(page_origin);
	const by = new Map<string, ThirdPartyOrigin>();
	let first_third_script_end = Infinity;
	let runtime_loaded = 0;
	let weighed = 0;
	const sorted = [...resources].sort((a, b) => a.start - b.start);
	for (const r of sorted) {
		const host = host_of(r.url);
		if (!host || host === page_host) continue;
		const o = by.get(host) ?? { host, kind: kind_of_host(host), files: 0, scripts: 0, script_bytes: 0, unsized: 0, wire: 0, blocking: 0, first: r.start, cpu_ms: cpu_by_host ? (cpu_by_host.get(host) ?? 0) : null };
		o.files++;
		o.wire += r.transfer ?? 0;
		if (r.blocking) o.blocking++;
		if (r.type === 'script') {
			o.scripts++;
			o.script_bytes += r.size ?? 0;
			if (!r.size) o.unsized++;
			else if (r.weighed) weighed++;
			if (r.start >= first_third_script_end && (named ? !named.has(r.url) : (in_page !== undefined && !in_page.has(r.url)) || (parsed !== undefined && r.start > parsed))) runtime_loaded++;
			first_third_script_end = Math.min(first_third_script_end, r.end);
		}
		by.set(host, o);
	}
	if (!by.size) return null;
	const origins = [...by.values()].sort((a, b) => (b.cpu_ms ?? 0) - (a.cpu_ms ?? 0) || b.script_bytes - a.script_bytes || b.wire - a.wire);
	const sum = (k: 'script_bytes' | 'unsized' | 'wire' | 'blocking') => origins.reduce((s, o) => s + o[k], 0);
	return {
		origins,
		script_bytes: sum('script_bytes'),
		unsized: sum('unsized'),
		weighed,
		wire: sum('wire'),
		blocking: sum('blocking'),
		cpu_ms: cpu_by_host ? origins.reduce((s, o) => s + (o.cpu_ms ?? 0), 0) : null,
		runtime_loaded
	};
}

/** What to do about each kind, in one line (Partytown only where it tends to work). */
const ADVICE: Record<ThirdPartyKind, string> = {
	'tag manager': 'audit its tags (each one is a script it adds at runtime), fire them after the page is interactive or on consent, or move them to server-side tagging',
	analytics: 'load it after the page is interactive (idle or first interaction); a pure beacon tag is the kind that runs well off the main thread in a worker (Partytown), worth trying there',
	ads: 'reserve the slots at their final size and load the ad code after the main content; conversion pixels can wait for idle',
	'session replay': 'start it after the first interaction, or sample it (record a share of visits): it watches every DOM change',
	chat: 'show a plain button that looks like the widget and load the widget on its first click (a facade)',
	'a/b testing': 'it edits the page before or as islands wake: run the experiment on the server (render the variant) so islands hydrate clean',
	consent: 'keep it small and async, and let it gate the other tags rather than load beside them',
	fonts: 'self-host the fonts (one origin fewer on the critical path) and preload the one the first screen uses',
	'library cdn': 'bundle the library with the app (one origin fewer, cached with your code, no runtime fetches of its parts)',
	other: 'load it async, after the first paint, or where it is used'
};

export interface ThirdPartyFinding {
	code: string;
	severity: 'warn' | 'info';
	message: string;
	fix?: string;
}

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1048576).toFixed(1)} MB` : n > 0 && n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`);

/** `edited`: islands that did not wake from the server's markup on this visit (changed, recovered,
 *  healed, failed), with when they woke (ms; Infinity when unknown or never). */
export function third_party_findings(tp: ThirdParty | null, edited: readonly { name: string; done: number }[] = []): ThirdPartyFinding[] {
	if (!tp) return [];
	const out: ThirdPartyFinding[] = [];
	// a browser that hides other origins' sizes reports 0 for each of their files: count those scripts
	// instead of calling them 0 KB, and let a library that loads many parts be worth naming on count
	const MANY = 5;
	const heavy = tp.origins.filter((o) => (o.cpu_ms ?? 0) >= 50 || o.script_bytes >= 50 * 1024 || o.unsized >= MANY || o.blocking);
	const size = (bytes: number, scripts: number, unsized: number) =>
		!unsized ? kb(bytes) : unsized === scripts ? `${scripts} script${scripts === 1 ? '' : 's'}, sizes hidden` : `at least ${kb(bytes)}`;
	const label = (o: ThirdPartyOrigin) => `${o.host}${o.kind !== 'other' ? ` (${o.kind})` : ''} ${size(o.script_bytes, o.scripts, o.unsized)}${o.cpu_ms ? `, ${Math.round(o.cpu_ms)} ms CPU` : ''}${o.blocking ? `, ${o.blocking} blocking` : ''}`;
	const scripts = tp.origins.reduce((s, o) => s + o.scripts, 0);
	// (sizes the browser hid that were weighed apart from the visit: real bytes, said whose they are)
	const weighed = tp.weighed ? ` (this browser hid the size of ${tp.weighed === scripts ? (scripts === 1 ? 'it' : 'each') : `${tp.weighed} of them`}; weighed from the files themselves)` : '';
	const served = !tp.unsized
		? `${kb(tp.script_bytes)} of JS${weighed}`
		: tp.unsized === scripts
			? `${scripts} script${scripts === 1 ? '' : 's'} (this browser hides other origins' file sizes; a Chromium visit shows them)`
			: `at least ${kb(tp.script_bytes)} of JS (${tp.unsized} of the ${scripts} scripts had their size hidden by this browser${tp.weighed ? `; ${tp.weighed} more it hid were weighed from the files themselves` : ''})`;
	const worth = tp.script_bytes >= 30 * 1024 || tp.unsized >= MANY || (tp.cpu_ms ?? 0) >= 50 || tp.blocking > 0;
	if (worth)
		out.push({
			code: 'third-party',
			severity: (tp.cpu_ms ?? 0) >= 200 || tp.blocking > 0 || tp.script_bytes >= 200 * 1024 ? 'warn' : 'info',
			message:
				`${tp.origins.length} other origin${tp.origins.length === 1 ? '' : 's'} served ${served}${tp.cpu_ms !== null ? ` and ran ${Math.round(tp.cpu_ms)} ms on the main thread` : ''}` +
				`${tp.runtime_loaded ? `; ${tp.runtime_loaded} of their scripts the page never names, loaded by other scripts (how a tag manager or a self-loading library adds code)` : ''}. ` +
				`The heaviest: ${(heavy.length ? heavy : tp.origins).slice(0, 3).map(label).join('; ')}.`,
			fix: [...new Set((heavy.length ? heavy : tp.origins).slice(0, 3).map((o) => `${o.kind === 'other' ? o.host : o.kind}: ${ADVICE[o.kind]}`))].join(' · ')
		});
	const blocking = tp.origins.filter((o) => o.blocking);
	if (blocking.length)
		out.push({
			code: 'third-party-blocking',
			severity: 'warn',
			message: `${blocking.map((o) => o.host).join(', ')} held the first paint: the page waited on another origin's server before showing anything.`,
			fix: 'Load its scripts with async or defer, self-host a stylesheet or font it serves, or at least preconnect to it.'
		});
	// a third party that could have edited the page: its scripts started before islands that did not
	// wake clean had woken (a font or a library CDN does not edit markup)
	const last_woke = edited.reduce((m, e) => Math.max(m, e.done), -Infinity);
	const editors = tp.origins.filter((o) => o.scripts > 0 && o.first < last_woke && o.kind !== 'fonts' && o.kind !== 'library cdn');
	if (edited.length && editors.length)
		out.push({
			code: 'third-party-edits',
			severity: 'warn',
			message: `${[...new Set(edited.map((e) => e.name))].slice(0, 3).join(', ')} did not wake from the server's markup, and ${editors.slice(0, 3).map((o) => `${o.host}${o.kind !== 'other' ? ` (${o.kind})` : ''}`).join(', ')} ran scripts before ${edited.length === 1 ? 'it' : 'they'} woke: a script from another origin that edits the DOM is the usual cause.`,
			fix: 'Keep third-party edits out of island subtrees (target the markup around them), or render the variant on the server so the island hydrates what it was sent.'
		});
	return out;
}
