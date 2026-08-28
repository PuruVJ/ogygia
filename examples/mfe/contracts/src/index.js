/**
 * @corp/contracts — the shared vocabulary between teams. A few lines per concept;
 * each app compiles its own copy. The truly shared thing is the NAME + the shape.
 * Cart belongs to the dash team; changing a shape here is a reviewed version bump.
 */
import { SharedState, experiment } from 'ogygia';

/** @type {SharedState<{ items: string[] }>} */
export const cart = new SharedState('corp.cart', { items: [] });

/** The boss's question, as a contract: does full hydration beat islands? The SHELL assigns
 *  (sticky 50/50), the bucket rides the signed claims, every team renders the same world. */
export const csr_exp = experiment('csr-mode', {
	variants: ['static', 'hydrated'],
	split: { hydrated: 50 }
});
