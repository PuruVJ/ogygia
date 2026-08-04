// Universal hooks. `transport` teaches (de)serialization of CUSTOM types across the remote
// boundary. ogygia reuses Kit's own wire codec + these decoders on the client, so custom
// types now round-trip inside islands (previously only built-in devalue types worked).
export class Temperature {
	constructor(public celsius: number) {}
	get fahrenheit() {
		return this.celsius * 1.8 + 32;
	}
}

export const transport = {
	Temperature: {
		encode: (value: unknown) => value instanceof Temperature && [value.celsius],
		decode: ([celsius]: [number]) => new Temperature(celsius)
	}
};
