/** Client-safe blog helpers — shared by the remote and the server loads. */
import { dateOf } from 'ogygia/content';

/** ISO date off an entry's source path (`…/2026-08-13-slug.md`). */
export function post_date(filePath: string | undefined): string | null {
	if (!filePath) return null;
	const base = filePath.split('/').pop()!.replace(/\.md$/, '');
	return dateOf(base);
}
