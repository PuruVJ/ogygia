/**
 * The LATE WIRE — how a region that resolves after the document flushed reaches the page down the SAME
 * response. A slot (`<og-late-slot>`, also what `<Region of={promise}>` renders around its placeholder)
 * sits in the flushed document; each later state rides down as an inert `<template data-og-late>` chunk
 * that ONE small classic inline script in the head swaps in as it parses. Module scripts don't run until
 * parsing ENDS, which for a streamed document is the very thing we're not waiting for. After an SPA
 * navigation the runtime applies remaining templates itself (runtime/router-nav.ts).
 *
 * A renderer that delivers late chunks (the server router's streamed document) speaks this format; core
 * owns it because core's components emit the slots and core's runtime consumes the chunks.
 */

/** Wrap html as the swappable slot `id` (display:contents — layout-invisible). */
export function late_slot(id: string, html: string): string {
	return `<og-late-slot data-og-slot="${id}" style="display:contents">${html}</og-late-slot>`;
}

/** A late chunk: inert template + nothing else — the boot script (or the runtime, post-SPA-swap)
 *  performs the swap. Multiple chunks for one slot apply in order (progressive states). */
export function late_chunk(id: string, html: string): string {
	return `<template data-og-late="${id}">${html}</template>`;
}

/**
 * The classic inline boot: observes streamed-in `<template data-og-late>` nodes DURING parse and
 * swaps each into its slot immediately (stylesheet links hoist to head first so the swap never
 * paints unstyled). Kept dependency-free and tiny — it must run before any module script can.
 */
export const LATE_BOOT_SCRIPT: string =
	'<script data-og-late-boot>(function(){' +
	'function ap(t){var id=t.getAttribute("data-og-late");var s=document.querySelector(' +
	"'og-late-slot[data-og-slot=\"'+id+'\"]');if(!s){t.remove();return}" +
	'var c=t.content;var ls=c.querySelectorAll(\'link[rel="stylesheet"],style\');' +
	'for(var i=0;i<ls.length;i++){var l=ls[i];var h=l.getAttribute&&l.getAttribute("href");' +
	"if(h&&document.head.querySelector('link[href=\"'+h+'\"]'))l.remove();" +
	'else document.head.appendChild(l)}' +
	'while(s.firstChild)s.removeChild(s.firstChild);s.appendChild(c);t.remove()}' +
	'var mo=new MutationObserver(function(ms){for(var i=0;i<ms.length;i++){var ad=ms[i].addedNodes;' +
	'for(var j=0;j<ad.length;j++){var n=ad[j];if(n.nodeType===1&&n.tagName==="TEMPLATE"&&' +
	'n.hasAttribute("data-og-late"))ap(n)}}});' +
	'mo.observe(document.documentElement,{childList:true,subtree:true});' +
	'addEventListener("DOMContentLoaded",function(){' +
	'var ts=document.querySelectorAll("template[data-og-late]");' +
	'for(var i=0;i<ts.length;i++)ap(ts[i]);mo.disconnect()},{once:true});' +
	'})()</script>';
