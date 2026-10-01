/* Type-level guard for `script()`: the combinations a browser silently ignores are refused, and
 * `args` follow `run`'s parameters. tsc-only (no runtime). */
import { script } from '../src/script.js';

// accepted
script(() => 0);
script((k: string, n: number) => k + n, 'og-theme', 2);
script({ run: () => 0 });
script({ run: (a: string, b: number) => a + b, args: ['x', 1] });
script({ run: async () => {}, type: 'module', async: true, blocking: 'render', nonce: 'n', id: 'i', 'data-x': 1 });
script({ run: () => 0, nomodule: true });
script({ json: { a: [1, 'b', null] }, id: 'cfg' });
script({ ld: { '@type': 'Article' } });
script({ importmap: { imports: { a: '/a.js' } } });
script({ speculation: { prerender: [{ where: { href_matches: '/*' } }] } });
const base = { type: 'module', nonce: 'n' } as const;
script({ ...base, run: () => 0 });

// @ts-expect-error the shortcut's args follow the function's params too
script((k: string) => k, 1);
// @ts-expect-error async on an inline CLASSIC script does nothing
script({ run: () => 0, async: true });
// @ts-expect-error blocking needs a module
script({ run: () => 0, blocking: 'render' });
// @ts-expect-error nomodule on a module script is meaningless
script({ run: () => 0, type: 'module', nomodule: true });
// @ts-expect-error run takes a param: args are required
script({ run: (a: string) => a });
// @ts-expect-error args must match run's params
script({ run: (a: string) => a, args: [1] });
// @ts-expect-error a data script has no code
script({ json: 1, run: () => 0 });
// @ts-expect-error a data script's type is fixed
script({ json: 1, type: 'module' });
// @ts-expect-error one data payload at a time
script({ json: 1, ld: 2 });
// @ts-expect-error not JSON
script({ json: new Map() });
