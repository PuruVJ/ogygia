/**
 * Shiki themes for the docs site: forest neutrals + moderated green.
 * Green carries keywords / strings / tags; functions, types, constants, and
 * numbers use other hues so blocks stay readable (not a mint wash).
 */
import type { ThemeRegistrationResolved } from 'shiki';

/** Bump when palette changes so the highlighter singleton reloads in vite HMR. */
export const THEME_REV = 3;
type Palette = {
	bg: string;
	fg: string;
	faint: string;
	dim: string;
	/** keywords — site accent */
	keyword: string;
	/** strings — softer green, same family */
	string: string;
	/** HTML/Svelte tags — brighter accent */
	tag: string;
	/** functions / entities */
	fn: string;
	/** types / classes */
	type: string;
	/** constants, language vars */
	constant: string;
	/** numbers, attrs */
	warn: string;
	warnSoft: string;
	support: string;
};

const DARK: Palette = {
	bg: '#060907',
	fg: '#e6eee9',
	faint: '#6b7a72',
	dim: '#9aaba1',
	keyword: '#6fe3b0',
	string: '#9fc9b0',
	tag: '#8ff0c6',
	fn: '#a8b8e8',
	type: '#c4a8e0',
	constant: '#7ec8e0',
	warn: '#e0b56f',
	warnSoft: '#f0c9a0',
	support: '#8fa398'
};

const LIGHT: Palette = {
	bg: '#e6ece9',
	fg: '#121a16',
	faint: '#7a8c82',
	dim: '#4a5c52',
	keyword: '#0f7a4f',
	string: '#1a6b4a',
	tag: '#0a5c3b',
	fn: '#2f4f7a',
	type: '#5a3d7a',
	constant: '#0e6e8c',
	warn: '#9a6b1c',
	warnSoft: '#8b3a2a',
	support: '#4a5c52'
};

/** github-dark → ogygia dark */
const DARK_MAP: Record<string, string> = {
	'#24292e': DARK.bg,
	'#2f363d': '#1c2620',
	'#6a737d': DARK.faint,
	'#79b8ff': DARK.constant,
	'#85e89d': DARK.string,
	'#9ecbff': DARK.support,
	'#b392f0': DARK.fn,
	'#d1d5da': DARK.dim,
	'#dbedff': DARK.type,
	'#e1e4e8': DARK.fg,
	'#f97583': DARK.keyword,
	'#fdaeb7': DARK.warnSoft,
	'#ffab70': DARK.warn
};

/** github-light → ogygia light */
const LIGHT_MAP: Record<string, string> = {
	'#ffffff': LIGHT.bg,
	'#fff': LIGHT.bg,
	'#f6f8fa': LIGHT.bg,
	'#fafbfc': '#f2f6f4',
	'#24292e': LIGHT.fg,
	'#586069': LIGHT.dim,
	'#6a737d': LIGHT.faint,
	'#005cc5': LIGHT.constant,
	'#032f62': LIGHT.fn,
	'#22863a': LIGHT.string,
	'#6f42c1': LIGHT.type,
	'#d73a49': LIGHT.keyword,
	'#e36209': LIGHT.warn,
	'#b31d28': LIGHT.warnSoft
};

function remap_hex(value: string, map: Record<string, string>) {
	const key = value.toLowerCase();
	return map[key] ?? map[key.replace(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i, '#$1$1$2$2$3$3')] ?? value;
}

function paint_tags(theme: ThemeRegistrationResolved, tag: string): ThemeRegistrationResolved {
	const tag_scopes = new Set([
		'entity.name.tag',
		'entity.name.tag.html',
		'entity.name.tag.svelte',
		'support.class.component',
		'support.class.component.svelte'
	]);
	const tokenColors = (theme.tokenColors ?? []).map((rule) => {
		const scopes = Array.isArray(rule.scope) ? rule.scope : rule.scope ? [rule.scope] : [];
		if (scopes.some((s) => tag_scopes.has(s))) {
			return { ...rule, settings: { ...rule.settings, foreground: tag } };
		}
		return rule;
	});
	return { ...theme, tokenColors };
}

function remap_theme(
	base: ThemeRegistrationResolved,
	name: string,
	displayName: string,
	type: 'dark' | 'light',
	palette: Palette,
	map: Record<string, string>
): ThemeRegistrationResolved {
	const colors: Record<string, string> = {};
	for (const [k, v] of Object.entries(base.colors ?? {})) {
		colors[k] = typeof v === 'string' ? remap_hex(v, map) : v;
	}
	colors['editor.background'] = palette.bg;
	colors['editor.foreground'] = palette.fg;

	const tokenColors = (base.tokenColors ?? []).map((rule) => {
		const settings = { ...rule.settings };
		if (typeof settings.foreground === 'string') {
			settings.foreground = remap_hex(settings.foreground, map);
		}
		if (typeof settings.background === 'string') {
			settings.background = remap_hex(settings.background, map);
		}
		return { ...rule, settings };
	});

	return paint_tags(
		{
			...base,
			name,
			displayName,
			type,
			colors,
			tokenColors,
			bg: palette.bg,
			fg: palette.fg
		},
		palette.tag
	);
}

export async function load_ogygia_themes() {
	const { bundledThemes } = await import('shiki');
	const [dark_mod, light_mod] = await Promise.all([
		bundledThemes['github-dark'](),
		bundledThemes['github-light']()
	]);

	return {
		dark: remap_theme(dark_mod.default, 'ogygia-dark', 'Ogygia Dark', 'dark', DARK, DARK_MAP),
		light: remap_theme(light_mod.default, 'ogygia-light', 'Ogygia Light', 'light', LIGHT, LIGHT_MAP)
	};
}
