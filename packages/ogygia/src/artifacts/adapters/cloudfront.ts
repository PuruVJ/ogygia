/**
 * artifacts — CloudFront edge adapter: CreateInvalidation with real SigV4 request signing.
 *
 * CloudFront has NO tag purge — path invalidation with wildcards is native, so
 * `purgeWhere({ prefix })` becomes `<prefix>/*` (+ the bare prefix path). `headers()` adds
 * nothing: the distribution honors the origin's `cache-control` (stamped by the verdict).
 *
 * `baseUrl` override points the SAME adapter at the harness's edge emulator — e2e exercises
 * this exact signing/requesting code, not a mock of it.
 */
import { createHmac, createHash } from 'node:crypto';
import type { EdgeAdapter } from '../types.js';
import { normalize_prefix } from '../key.js';

export interface CloudfrontConfig {
	distributionId: string;
	accessKeyId: string;
	secretAccessKey: string;
	/** Harness override: send API calls here instead of the real AWS endpoint. */
	baseUrl?: string;
}

const SERVICE = 'cloudfront';
const REGION = 'us-east-1';
const API_HOST = 'cloudfront.amazonaws.com';
const API_VERSION = '2020-05-31';

const hex_sha = (data: string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();

/** amz dates: `20260901T120000Z` / `20260901`. */
function amz_dates(): { datetime: string; date: string } {
	const iso = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
	return { datetime: iso, date: iso.slice(0, 8) };
}

export function cloudfront(config: CloudfrontConfig): EdgeAdapter {
	const api_base = (config.baseUrl ?? `https://${API_HOST}`).replace(/\/+$/, '');

	const create_invalidation = async (paths: string[]): Promise<void> => {
		const items = paths.map((p) => `<Path>${p}</Path>`).join('');
		const body =
			`<?xml version="1.0" encoding="UTF-8"?>` +
			`<InvalidationBatch xmlns="http://cloudfront.amazonaws.com/doc/${API_VERSION}/">` +
			`<CallerReference>og-${Date.now()}-${Math.floor(Math.random() * 1e6)}</CallerReference>` +
			`<Paths><Quantity>${paths.length}</Quantity><Items>${items}</Items></Paths>` +
			`</InvalidationBatch>`;
		const path = `/${API_VERSION}/distribution/${config.distributionId}/invalidation`;
		const { datetime, date } = amz_dates();
		const payload_hash = hex_sha(body);
		// SigV4 canonical request → string-to-sign → derived key chain → signature.
		const canonical = [
			'POST',
			path,
			'',
			`host:${API_HOST}`,
			`x-amz-content-sha256:${payload_hash}`,
			`x-amz-date:${datetime}`,
			'',
			'host;x-amz-content-sha256;x-amz-date',
			payload_hash
		].join('\n');
		const scope = `${date}/${REGION}/${SERVICE}/aws4_request`;
		const string_to_sign = ['AWS4-HMAC-SHA256', datetime, scope, hex_sha(canonical)].join('\n');
		const k_date = hmac('AWS4' + config.secretAccessKey, date);
		const k_region = hmac(k_date, REGION);
		const k_service = hmac(k_region, SERVICE);
		const k_signing = hmac(k_service, 'aws4_request');
		const signature = createHmac('sha256', k_signing).update(string_to_sign).digest('hex');
		const res = await fetch(api_base + path, {
			method: 'POST',
			headers: {
				host: API_HOST,
				'content-type': 'text/xml',
				'x-amz-content-sha256': payload_hash,
				'x-amz-date': datetime,
				authorization:
					`AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, ` +
					`SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`
			},
			body
		});
		if (!res.ok) {
			throw new Error(
				`[ogygia] cloudfront invalidation failed: ${res.status} ${await res.text().catch(() => '')}`
			);
		}
	};

	return {
		name: 'cloudfront',
		headers() {
			return {}; // the distribution honors origin cache-control — nothing extra to stamp
		},
		async purgeUrl(url) {
			await create_invalidation([url]);
		},
		async purgeWhere({ prefix }) {
			const p = normalize_prefix(prefix);
			await create_invalidation([p, `${p}/*`]);
		}
	};
}
