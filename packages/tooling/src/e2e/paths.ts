import { fileURLToPath } from 'node:url';

/** The repository root (with a trailing slash). */
export const REPO: string = fileURLToPath(new URL('../../../../', import.meta.url));
