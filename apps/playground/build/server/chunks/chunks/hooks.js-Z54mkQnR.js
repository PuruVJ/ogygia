//#region src/hooks.ts
var Temperature = class {
	celsius;
	constructor(celsius) {
		this.celsius = celsius;
	}
	get fahrenheit() {
		return this.celsius * 1.8 + 32;
	}
};
var transport = { Temperature: {
	encode: (value) => value instanceof Temperature && [value.celsius],
	decode: ([celsius]) => new Temperature(celsius)
} };

export { Temperature as T, transport as t };
//# sourceMappingURL=hooks.js-Z54mkQnR.js.map
