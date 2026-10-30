// `pnpm run version-packages` (the release workflow's version step): `changeset version` bumps
// `ogygia`, then the changelog's `## [Unreleased]` becomes `## [<version>] - <date>`. The changelog is
// hand-written (one line per change, `changelog: false` in .changeset/config.json), so a release
// without an `[Unreleased]` section is a mistake: refuse rather than ship an undocumented version.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const PKG = 'packages/ogygia/package.json';
const CHANGELOG = 'packages/ogygia/CHANGELOG.md';
const UNRELEASED = '## [Unreleased]';

const before = JSON.parse(fs.readFileSync(PKG, 'utf8')).version;
execFileSync('pnpm', ['exec', 'changeset', 'version'], { stdio: 'inherit' });
const version = JSON.parse(fs.readFileSync(PKG, 'utf8')).version;
if (version === before) {
	console.log(`ogygia stays ${version}: no changeset bumps it`);
	process.exit(0);
}

const log = fs.readFileSync(CHANGELOG, 'utf8');
if (!log.includes(UNRELEASED)) {
	console.error(`${CHANGELOG} has no "${UNRELEASED}" section for ${version}: add the release's lines there.`);
	process.exit(1);
}
const date = new Date().toISOString().slice(0, 10);
fs.writeFileSync(CHANGELOG, log.replace(UNRELEASED, `## [${version}] - ${date}`));
console.log(`ogygia ${before} → ${version}, changelog dated ${date}`);
