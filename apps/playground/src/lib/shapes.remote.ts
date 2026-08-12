/**
 * Wire-law harness remotes — one per shape. The law under test: any data shape crosses if its
 * leaves are regions; composition crosses as shape + a marked recomposer.
 *
 *   array      — flat list of regions, mixed static/interactive, UN-awaited (per-leaf endpoint fetch)
 *   object     — named slots; `main` awaited (HTML rides the response), others lazy
 *   props_eager — region as a PROP of another region, outer awaited (nested renders same-pass)
 *   props_lazy  — same but outer UN-awaited (outer's props must serialize INTO the signed url —
 *                 expected trouble spot: a region value inside endpoint props)
 *   recomposer  — marked app-owned FeedList over region leaves, awaited
 */
import { query } from '$app/server';
import { region } from 'ogygia';
import NoteCard from './shapes/NoteCard.svelte' with { region: 'raw' };
import TapBadge from './shapes/TapBadge.svelte' with { wake: 'load' };
import PanelMain from './shapes/PanelMain.svelte' with { region: 'raw' };
import VideoEmbed from './shapes/VideoEmbed.svelte' with { region: 'raw' };
import FeedCard from './shapes/FeedCard.svelte' with { region: 'raw' };
import FeedList from './shapes/FeedList.svelte' with { region: 'raw' };
import TreeHost from './shapes/TreeHost.svelte' with { region: 'raw' };
import Grid from './blocks/Grid.svelte' with { region: 'raw' };

export const arrayShape = query(async () => {
	return [
		region(NoteCard, { text: 'first note' }),
		region(TapBadge, { start: 3 }),
		region(NoteCard, { text: 'second note' })
	];
});

export const objectShape = query(async () => {
	return {
		header: region(NoteCard, { text: 'header slot' }),
		main: await region(PanelMain, { title: 'Main (awaited)' }),
		rail: region(NoteCard, { text: 'rail slot' })
	};
});

export const propsEager = query(async () => {
	return await region(FeedCard, {
		author: 'puru',
		media: region(VideoEmbed, { src: 'intro.mp4' })
	});
});

export const propsLazy = query(async () => {
	return region(FeedCard, {
		author: 'puru (lazy)',
		media: region(VideoEmbed, { src: 'lazy.mp4' })
	});
});

// The blocks shape: NESTED tree, leaves resolved to regions server-side (this is what a
// wire-law-obeying blocks() would mint). Grid is a container with a children slot.
export const treeShape = query(async () => {
	return await region(TreeHost, {
		nodes: [
			{ of: region(NoteCard, { text: 'tree root note' }) },
			{
				of: region(Grid, {}),
				children: [
					{ of: region(VideoEmbed, { src: 'nested.mp4' }) },
					{ of: region(TapBadge, { start: 11 }) }
				]
			}
		]
	});
});

export const recomposerShape = query(async () => {
	return await region(FeedList, {
		items: [
			region(NoteCard, { text: 'recomposed note' }),
			region(TapBadge, { start: 7 }),
			region(VideoEmbed, { src: 'clip.mp4' })
		]
	});
});
