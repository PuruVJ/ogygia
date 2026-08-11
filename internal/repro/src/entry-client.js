import { hydrate } from 'svelte';
import App from './App.svelte';
import Wrapper from './Wrapper.svelte';

const target = document.getElementById('app');
const sibling = document.getElementById('sibling');

// Record layout every animation frame from BEFORE hydrate through ~1.5s after, so a one-frame
// transient reflow (the ogygia "hero bounce" class of bug) is captured, not just the end state.
const frames = [];
let running = true;
function tick() {
  frames.push({
    t: Math.round(performance.now()),
    hostH: Math.round(target.getBoundingClientRect().height),
    siblingTop: Math.round(sibling.getBoundingClientRect().top),
    boxClass: target.querySelector('[data-box]')?.getAttribute('class') ?? null
  });
  if (running) requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// Mirror the ogygia island runtime: SSR emitted <App/> directly; the client hydrates a WRAPPER that
// renders App, into a target wrapped in `<!--[-->`…`<!--]-->` hydration-envelope comments.
target.insertBefore(document.createComment('['), target.firstChild);
target.appendChild(document.createComment(']'));

hydrate(Wrapper, { target, props: { component: App } });

// Dump the timeline once things settle so an external harness can read it.
setTimeout(() => {
  running = false;
  // Compress to transitions only.
  const out = [];
  let prev = null;
  for (const f of frames) {
    const key = `${f.hostH}|${f.siblingTop}|${f.boxClass}`;
    if (key !== prev) {
      out.push(f);
      prev = key;
    }
  }
  window.__reproTimeline = out;
  window.__reproDone = true;
  console.log('[repro] layout timeline (t, hostH, siblingTop, boxClass):');
  for (const f of out) console.log(`  +${f.t}ms hostH=${f.hostH} siblingTop=${f.siblingTop} class=${JSON.stringify(f.boxClass)}`);
  const tops = frames.map((f) => f.siblingTop);
  console.log(`[repro] siblingTop range: ${Math.min(...tops)}..${Math.max(...tops)} (delta ${Math.max(...tops) - Math.min(...tops)}px)`);
}, 1500);
