/**
 * Mint the demo's Ed25519 keypairs → keys.env (gitignored — keys are never committed).
 * v2 federation is symmetric: EVERY app both calls and answers, so each app gets its own
 * signing key and every app holds all three public keys (+ every origin). MFEs still hold only
 * PUBLIC keys of their peers.
 *
 *     node gen-keys.mjs && source keys.env
 */
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const pair = () => {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	return {
		pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
		priv: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
	};
};

const shell = pair();
const cms = pair();
const dash = pair();

writeFileSync(
	new URL('./keys.env', import.meta.url),
	[
		`export SHELL_SIGNING_KEY=${shell.priv}`,
		`export CMS_SIGNING_KEY=${cms.priv}`,
		`export DASH_SIGNING_KEY=${dash.priv}`,
		`export SHELL_PUBLIC_KEY=${shell.pub}`,
		`export CMS_PUBLIC_KEY=${cms.pub}`,
		`export DASH_PUBLIC_KEY=${dash.pub}`,
		`export SHELL_ORIGIN=http://localhost:5190`,
		`export CMS_ORIGIN=http://localhost:5192`,
		`export DASH_ORIGIN=http://localhost:5191`,
		''
	].join('\n')
);

console.log('wrote keys.env — run:  source keys.env');
