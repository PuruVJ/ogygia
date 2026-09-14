// A SECOND remote module for the gate's permutations: the gate is per MODULE (Kit's id-hash), so a
// page whose island imports only this module must seed this one and not `greetings.remote`.
import { query } from '$app/server';
import * as v from 'valibot';

export const second = query(v.string(), async (n) => ({ n, second: true }));
