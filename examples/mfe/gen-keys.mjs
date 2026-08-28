/**
 * Mint the demo's Ed25519 keypairs → keys.env (gitignored — keys are never committed).
 * Two callers: the SHELL signs its hops to cms + dash; the CMS re-signs its own stitch to
 * dash (the three-team chain). MFEs hold only PUBLIC keys.
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

writeFileSync(
	new URL('./keys.env', import.meta.url),
	[
		`export SHELL_SIGNING_KEY=${shell.priv}`,
		`export SHELL_PUBLIC_KEY=${shell.pub}`,
		`export CMS_SIGNING_KEY=${cms.priv}`,
		`export CMS_PUBLIC_KEY=${cms.pub}`,
		''
	].join('\n')
);

console.log('wrote keys.env — run:  source keys.env');
