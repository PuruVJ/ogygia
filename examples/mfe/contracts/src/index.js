/**
 * @corp/contracts — the shared vocabulary between teams. A few lines per concept;
 * each app compiles its own copy. The truly shared thing is the NAME + the shape.
 * Cart belongs to the dash team; changing a shape here is a reviewed version bump.
 */
import { SharedState } from 'ogygia';
import { flag } from 'ogygia/flag';

/** @type {SharedState<{ items: string[] }>} */
export const cart = new SharedState('corp.cart', { items: [] });

/** The boss's question, as a contract: does full hydration beat islands? The SHELL decides
 *  (sticky 50/50 weighted variants), the bucket rides the signed claims, every team renders the
 *  same world. A weighted-variant `flag` — `static` is control, `hydrated` gets half. */
export const csr_flag = flag('csr-mode', { static: 50, hydrated: 50 });
