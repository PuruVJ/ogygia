// Aliasing torture test: the codec key reaches the class through a RENAMED import and a
// const hop. The build must not care (it registers exported classes; the runtime symbol
// decides). If this crosses an island boundary, alias-proofing works.
import { wire as w } from 'ogygia';

const K = w;

export class AliasProbe {
	v = $state('');

	constructor(v = '') {
		this.v = v;
	}

	static [K] = {
		encode: (p: AliasProbe) => p.v,
		decode: (v: string) => new AliasProbe(v)
	};
}
