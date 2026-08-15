// Minimal-contract probe: the smallest legal wire mark — one field, explicit codec. If this
// crosses an island boundary and comes back alive, the strict one-contract path works end to end.
export class AliasProbe {
	v = $state('');

	constructor(v = '') {
		this.v = v;
	}

	static wire = import.meta.og.wire({
		encode: (p: AliasProbe) => p.v,
		decode: (v: string) => new AliasProbe(v)
	});
}
