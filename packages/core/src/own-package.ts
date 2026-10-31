/**
 * Core's own identity. Core is reached by two package names: `ogygia`, the package apps install (a
 * thin layer that re-exports core subpath for subpath), and `@ogygia/core`, what plugins import.
 * Every "is this ogygia itself" check asks here instead of comparing one literal name.
 */

/** The package names core answers to. */
export const OWN_PACKAGE_NAMES: readonly string[] = ['ogygia', '@ogygia/core'];

/** A bare specifier that names core, by either name, or one of its subpaths. */
export function is_own_specifier(spec: string): boolean {
	for (const name of OWN_PACKAGE_NAMES)
		if (spec === name || spec.startsWith(name + '/')) return true;
	return false;
}

/** Core's names as a regex alternation, for import-clause scanners (`from 'ogygia'`). */
export const OWN_SPECIFIER_SOURCE = '(?:ogygia|@ogygia/core)';

/** A file inside core or the `ogygia` package, source or build: `…/node_modules/ogygia/dist/…`,
 *  `…/node_modules/@ogygia/core/dist/…`, and a checkout's `packages/ogygia/src/…` and
 *  `packages/core/src/…`. Either separator. */
export const OWN_FILE_RE: RegExp =
	/[\\/](?:ogygia|@ogygia[\\/]core|packages[\\/]core)[\\/](?:src|dist)[\\/]/;
