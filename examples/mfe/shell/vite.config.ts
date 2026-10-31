import { sveltekit } from '@sveltejs/kit/vite';
import { ogygia } from 'ogygia/vite';
import { freeze } from '@ogygia/freeze/vite';
import { flags } from '@ogygia/flags/vite';
import { federation } from '@ogygia/federation/vite';
import { router } from '@ogygia/router/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	// `freeze()` = the shell's pages are frozen pages. Its anonymous home bakes a static dash
	// widget and freezes; a publish or deploy on the dash team thaws it via a cross-app thaw notice
	// (federation v2). The /cms/* mount pages read the shell's decided flags, so they stay per-request.
	plugins: [ogygia(), freeze(), flags(), federation(), router(), sveltekit()]
});
