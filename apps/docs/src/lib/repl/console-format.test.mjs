// Unit coverage for the preview console's value formatter — type-aware inspect (objects, Date, Map/Set,
// functions, circular, depth, DOM-less). Run: `node console-format.test.mjs`.
import { inspect, format_console_args } from './console-format.ts';

let pass = 0;
let fail = 0;
const eq = (label, got, want) => {
	if (got === want) { pass++; console.log(`  ✓ ${label}`); }
	else { fail++; console.log(`  ✗ ${label}\n      got:  ${got}\n      want: ${want}`); }
};
const has = (label, got, sub) => {
	if (String(got).includes(sub)) { pass++; console.log(`  ✓ ${label}`); }
	else { fail++; console.log(`  ✗ ${label} — ${JSON.stringify(String(got))} lacks ${JSON.stringify(sub)}`); }
};

console.log('console-format\n');

// primitives (nested form: strings quoted)
eq('string quoted', inspect('hi'), '"hi"');
eq('number', inspect(42), '42');
eq('negative zero', inspect(-0), '-0');
eq('NaN', inspect(NaN), 'NaN');
eq('Infinity', inspect(Infinity), 'Infinity');
eq('boolean', inspect(true), 'true');
eq('null', inspect(null), 'null');
eq('undefined', inspect(undefined), 'undefined');
eq('bigint', inspect(10n), '10n');
eq('symbol', inspect(Symbol('s')), 'Symbol(s)');

// functions / classes
eq('function', inspect(function foo() {}), 'ƒ foo');
eq('arrow anon', inspect(() => {}), 'ƒ (anonymous)');
eq('class', inspect(class Widget {}), 'class Widget');

// arrays + objects (readable, unquoted identifier keys)
eq('empty array', inspect([]), '[]');
eq('array', inspect([1, 'a', true]), '[ 1, "a", true ]');
eq('empty object', inspect({}), '{}');
eq('object identifier keys', inspect({ a: 1, b: 'x' }), '{ a: 1, b: "x" }');
eq('object non-identifier key quoted', inspect({ 'a-b': 1 }), '{ "a-b": 1 }');
eq('nested', inspect({ a: [1, { b: 2 }] }), '{ a: [ 1, { b: 2 } ] }');

// built-ins
eq('Date → ISO', inspect(new Date('2026-08-23T00:00:00.000Z')), '2026-08-23T00:00:00.000Z');
eq('Invalid Date', inspect(new Date('nope')), 'Invalid Date');
eq('RegExp', inspect(/foo/gi), '/foo/gi');
has('Error', inspect(new Error('boom')), 'Error: boom');
eq('Map', inspect(new Map([['a', 1], ['b', 2]])), 'Map(2) { "a" => 1, "b" => 2 }');
eq('empty Map', inspect(new Map()), 'Map(0) {}');
eq('Set', inspect(new Set([1, 2, 3])), 'Set(3) { 1, 2, 3 }');
eq('TypedArray', inspect(new Uint8Array([1, 2, 3])), 'Uint8Array(3) [ 1, 2, 3 ]');
eq('Promise', inspect(Promise.resolve(1)), 'Promise');

// class instance → prefixed with the constructor name
class Point { constructor() { this.x = 1; this.y = 2; } }
eq('class instance', inspect(new Point()), 'Point { x: 1, y: 2 }');

// circular reference → [Circular], never throws
{
	const o = { a: 1 };
	o.self = o;
	eq('circular', inspect(o), '{ a: 1, self: [Circular] }');
	const arr = [1];
	arr.push(arr);
	eq('circular array', inspect(arr), '[ 1, [Circular] ]');
}
// depth cap
eq('depth cap', inspect({ a: { b: { c: { d: { e: { f: 1 } } } } } }), '{ a: { b: { c: { d: { e: {…} } } } } }');
// big array truncation
has('big array truncated', inspect(Array.from({ length: 250 }, (_, i) => i)), 'more');

// format_console_args: top-level strings RAW, others inspected, space-joined
eq('args: leading string raw', format_console_args(['hello', { a: 1 }]), 'hello { a: 1 }');
eq('args: number + date', format_console_args(['t=', 5, new Date('2026-08-23T00:00:00.000Z')]), 't= 5 2026-08-23T00:00:00.000Z');
eq('args: all inspected when not string', format_console_args([{ x: 1 }, [2, 3]]), '{ x: 1 } [ 2, 3 ]');
eq('args: empty', format_console_args([]), '');
// never throws on a hostile value
{
	const evil = new Proxy({}, { ownKeys() { throw new Error('boom'); } });
	let threw = false;
	try { format_console_args([evil]); } catch { threw = true; }
	eq('hostile Proxy → no throw', threw, false);
}

console.log(`\n${'─'.repeat(44)}`);
console.log(`${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
