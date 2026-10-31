import { query, prerender } from '$app/server';
import * as v from 'valibot';
export const getSquare = query.batch(v.number(), async (nums: number[]) => (n: number) => n * n);
export const getManifesto = prerender(async () => 'standalone-prerender-ok', { dynamic: true });
