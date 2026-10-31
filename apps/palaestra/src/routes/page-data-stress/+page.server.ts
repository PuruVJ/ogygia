// Adversarial streaming fixture: a rejecting promise, a promise that resolves to a value holding a
// NESTED promise (recursive deferral), 12 staggered promises, a falsy resolution, and a CUSTOM
// transport type (`Temperature`) both plain and inside a streamed promise — all at once.
import { Temperature } from '../../hooks';

export const load = () => ({
	plain: 'here',
	rejects: Promise.reject(new Error('BOOM-REJECT')),
	nested: Promise.resolve({
		label: 'outer',
		inner: new Promise<string>((res) => setTimeout(() => res('INNER-DEEP'), 120))
	}),
	many: Array.from({ length: 12 }, (_, i) => new Promise<string>((res) => setTimeout(() => res(`m${i}`), 40 + i * 12))),
	falsy: Promise.resolve(null),
	// Custom transport type: the getter only exists if `decode` reconstructed the class (not a plain object).
	temp: new Temperature(20),
	tempAsync: new Promise<Temperature>((res) => setTimeout(() => res(new Temperature(100)), 100))
});
