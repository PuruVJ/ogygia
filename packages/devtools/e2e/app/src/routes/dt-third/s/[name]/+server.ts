// The planted third-party scripts (served cross-origin by the page's other loopback name).
const busy = (ms: number) => `{const u=performance.now()+${ms};while(performance.now()<u);}`;

const SCRIPTS: Record<string, string> = {
	// PLANTED third-party-blocking + third-party-edits: a sync script in <head> (holds the first paint)
	// that edits an island's markup before the island wakes
	'blocking.js': `${busy(30)}document.addEventListener('DOMContentLoaded',()=>{const b=document.querySelector('[data-dt="third-target"] button');if(b)b.textContent='edited by a third party';});`,
	// PLANTED third-party (a tag manager's shape): main-thread time, then three more scripts nothing
	// in the page names
	'tag.js': `${busy(150)}for(const n of ['px1','px2','px3']){const s=document.createElement('script');s.src=new URL(n+'.js',document.currentScript.src).href;document.head.appendChild(s);}`,
	'px1.js': busy(40),
	'px2.js': busy(40),
	'px3.js': busy(40),
	// DECOY: a small async script that does nothing heavy
	'tiny.js': 'window.__tiny_third = 1;'
};

export function GET({ params }) {
	const body = SCRIPTS[params.name];
	if (body === undefined) return new Response('not found', { status: 404 });
	// CORS + Timing-Allow-Origin, as real tag hosts send: the browser then reports sizes and lets the
	// sampler see inside the script
	return new Response(body, {
		headers: { 'content-type': 'text/javascript', 'access-control-allow-origin': '*', 'timing-allow-origin': '*', 'cache-control': 'no-store' }
	});
}
