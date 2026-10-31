// The e2e scoping rules (e2e/scope.ts), on a small fake workspace. `node --test e2e/scope.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { affected_specs, OWNERS, SMOKE } from './scope.ts';

const ws = {
	names: { ogygia: 'ogygia', router: '@ogygia/router', federation: '@ogygia/federation', devtools: '@ogygia/devtools', cli: '@ogygia/cli', tooling: '@ogygia/tooling' },
	deps: {
		ogygia: [],
		'@ogygia/router': ['ogygia'],
		'@ogygia/federation': ['ogygia', '@ogygia/router'],
		'@ogygia/devtools': ['ogygia', '@ogygia/router'],
		'@ogygia/cli': ['ogygia'],
		'@ogygia/tooling': []
	}
};
const specs = (changed: string[]) => {
	const r = affected_specs(changed, ws);
	return r.all ? 'all' : r.specs;
};

test('core, tooling, the lockfile and the e2e harness run everything', () => {
	assert.equal(specs(['packages/ogygia/src/hooks.ts']), 'all');
	assert.equal(specs(['packages/tooling/src/tsdown.ts']), 'all');
	assert.equal(specs(['pnpm-lock.yaml']), 'all');
	assert.equal(specs(['e2e/fixtures/index.ts']), 'all');
	assert.equal(specs(['apps/playground/vite.config.ts']), 'all');
});

test('a plugin runs its own specs, its dependents\' and the smoke set', () => {
	const r = specs(['packages/router/src/router.ts']);
	assert.notEqual(r, 'all');
	for (const s of [...OWNERS.router, ...OWNERS.federation, ...OWNERS.devtools, ...SMOKE]) assert.ok((r as string[]).includes(s), s);
	assert.ok(!(r as string[]).includes('lakes.spec.ts'));
});

test('a leaf plugin does not pull in its dependencies\' specs', () => {
	const r = specs(['packages/federation/src/serve.ts']) as string[];
	assert.ok(r.includes('federation.spec.ts'));
	assert.ok(!r.includes('router-seed.spec.ts'));
});

test('unit tests, docs and notes run nothing; a plugin without specs adds no smoke', () => {
	assert.deepEqual(specs(['packages/devtools/test/x.test.ts', 'internal/notes/x.md', 'apps/docs/src/x.ts']), []);
	assert.deepEqual(specs(['packages/cli/src/cli.ts']), []);
});

test('a spec runs itself; a fixture app runs its specs', () => {
	assert.deepEqual(specs(['e2e/lakes.spec.ts']), ['lakes.spec.ts']);
	assert.deepEqual(specs(['examples/mfe/cms/src/x.ts']), ['federation.spec.ts', 'mfe-foreign-page.spec.ts']);
});
