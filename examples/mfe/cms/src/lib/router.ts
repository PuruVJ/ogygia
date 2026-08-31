/**
 * The CMS team's whole app as a v2 route table — the thing `fragment.routes()` exposes.
 * Nested layouts + loads (merged cascade), a form action (method passthrough over the wire),
 * a redirect, a miss → everything the shell's mount must translate faithfully.
 */
import { routes, page, layout, error, redirect } from 'ogygia/router';
import { csr_flag } from '@corp/contracts';
import { stitch_dash_kpis } from './nested-stitch.js';
import CmsShell from './CmsShell.svelte';
import PostsShell from './PostsShell.svelte';
import Home from './Home.svelte';
import Post from './Post.svelte';
import Message from './Message.svelte';
// The boss's test, as two BINDINGS of one file: plain = pure server HTML (zero JS ships);
// `wake: 'load'` = the whole page is one island (the csr=true experience). The experiment
// picks per visitor; `$infer` never notices (types come from the load).
import Lab from './Lab.svelte';
import LabLive from './Lab.svelte' with { wake: 'load' };

export const BASE = '/cms';

// in-memory content (per server instance — fine for the POC)
const POSTS = [
	{ id: '1', title: 'Redesigning the docs', body: 'We moved everything to ogygia/content.' },
	{ id: '2', title: 'Ship log', body: 'Router v2 landed this week.' }
];
const COMMENTS: Record<string, string[]> = { '1': ['first!'], '2': [] };

const shell = layout('cms', CmsShell, {
	// `c.visitor`: THE identity — here the signature-bound claims an upstream shell signed in
	// (they win over any local resolver); undefined on the standalone door
	load: (c) => ({ site: 'ACME CMS', base: BASE, viewer: c.visitor ?? null }),
	// layout-level boundary: thrown errors render INSIDE the cms chrome (Kit's nearest +error.svelte)
	error: Message
});
const posts_shell = layout('posts', PostsShell, {
	load: () => ({ section: 'Posts', count: POSTS.length })
});

export const cms_router = routes(
	{
		...shell({
			'/': page(Home, {
				load: async (c) => ({
					posts: POSTS.map(({ id, title }) => ({ id, title })),
					// THREE TEAMS, ONE PAGE: the cms itself stitches dash's widget, signed with the
					// CMS's key, forwarding the visitor's claims AND the trace onward
					dash_html: await stitch_dash_kpis(c.visitor, c.request.headers.get('traceparent'))
				})
			}),
			'/lab': page(csr_flag.pick({ static: Lab, hydrated: LabLive }), {
				load: (c) => ({ mode: csr_flag(c), stamp: csr_flag.stamp(c) })
			}),
			...posts_shell({
				'/posts/[id]': page(Post, {
					load: (c) => {
						const post = POSTS.find((p) => p.id === c.params.id);
						if (!post) error(404, 'No such post.');
						return { post, comments: COMMENTS[post.id] ?? [] };
					},
					actions: {
						default: async (c) => {
							const form = await c.request.formData();
							const text = String(form.get('comment') ?? '').trim();
							const id = c.params.id!;
							if (text) (COMMENTS[id] ??= []).push(text);
							// PRG: classic form action answers with a redirect back to the page
							redirect(303, `${BASE}/posts/${id}`);
						}
					}
				})
			}),
			// legacy URL — proves redirect passthrough + rebase through the mount
			'/old-blog': page(Home, {
				load: () => {
					redirect(308, `${BASE}/posts/1`);
				}
			}),
			// catchall PAGE (not `miss`): a thrown 404 from a page load renders the root error
			// BOUNDARY as HTML with status 404 — so the mounted shell shows the CMS's OWN 404
			// page under its chrome. (`miss` answers JSON — no page context; router-v2 gap noted.)
			'/[...all]': page(Message, {
				load: () => {
					error(404, 'This CMS page does not exist.');
				}
			})
		})
	},
	{
		base: BASE,
		error: Message
	}
);
