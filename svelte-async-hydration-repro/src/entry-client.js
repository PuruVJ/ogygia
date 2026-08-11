import { hydrate } from 'svelte';
import App from './App.svelte';
import Wrapper from './Wrapper.svelte';

const target = document.getElementById('app');
const box = target.querySelector('[data-box]');

console.log('[repro] before hydrate  class =', JSON.stringify(box?.getAttribute('class')));
new MutationObserver(() => {
  console.log('[repro] class changed to', JSON.stringify(box?.getAttribute('class')));
}).observe(box, { attributes: true, attributeFilter: ['class'] });

// The island runtime does NOT hydrate the async component directly. The SSR emitted `<App/>`, but the
// client hydrates a WRAPPER that renders App, into a target wrapped in `<!--[-->`…`<!--]-->` hydration
// envelope comments (so a custom-element host can be the hydration target). This asymmetry —
// SSR = App's markers, client = Wrapper→App — is what triggers the attribute reset for an ASYNC App.
target.insertBefore(document.createComment('['), target.firstChild);
target.appendChild(document.createComment(']'));

hydrate(Wrapper, { target, props: { component: App } });
