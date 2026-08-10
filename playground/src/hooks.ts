// Universal hooks. `transport` teaches (de)serialization of CUSTOM types across the remote
// boundary. ogygia reuses Kit's own wire codec + these decoders on the client, so custom
// types now round-trip inside islands (previously only built-in devalue types worked).
// `...ogygia.transport` adds the Partial codec so `region()` values cross the wire — required
// for live partials (a `query.live` yielding an awaited partial).
import * as ogygia from 'ogygia';

export class Temperature {
	constructor(public celsius: number) {}
	get fahrenheit() {
		return this.celsius * 1.8 + 32;
	}
}

export const transport = {
	...ogygia.transport,
	Temperature: {
		encode: (value: unknown) => value instanceof Temperature && [value.celsius],
		decode: ([celsius]: [number]) => new Temperature(celsius)
	}
};
