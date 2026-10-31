<script lang="ts" module>
	// A live snippet's body may read the host's MODULE script too: an import and a value.
	import MxModuleRead from '$lib/mx/MxCtxRead.svelte';
	const MODULE_START = 600;
</script>

<script lang="ts">
	// Nesting matrix: every kind of container × a lake holding a `visible` island (or the island
	// alone). Every inner island must wake on its own and every lake must keep its server HTML.
	// `?only=<case>` renders one case alone. e2e/nest-matrix.spec.ts.
	import { page } from '$app/state';
	import MxTwoSlots from '$lib/mx/MxTwoSlots.svelte' with { wake: 'load' };
	import MxToggleApp from '$lib/mx/MxToggleApp.svelte' with { wake: 'load' };
	import SnipApp from '$lib/SnipApp.svelte' with { wake: 'load' };
	import MxChildrenApp from '$lib/mx/MxChildrenApp.svelte' with { wake: 'load' };
	import MxLakeHost from '$lib/mx/MxLakeHost.svelte' with { wake: 'load' };
	import MxHoleHost from '$lib/mx/MxHoleHost.svelte' with { wake: 'load' };
	import MxRowsApp from '$lib/mx/MxRowsApp.svelte' with { wake: 'load' };
	import MxPlainForward from '$lib/mx/MxPlainForward.svelte';
	import SnipLake from '$lib/SnipLake.svelte' with { wake: 'none' };
	import Bumper from '$lib/Bumper.svelte' with { wake: 'visible' };
	import MxLakeHole from '$lib/mx/MxLakeHole.svelte' with { render: 'deferred' };
	import MxLakeHoleWake from '$lib/mx/MxLakeHoleWake.svelte' with {
		render: 'deferred',
		fetch: 'load'
	};
	import MxIslandHole from '$lib/mx/MxIslandHole.svelte' with { render: 'deferred' };
	import MxIslandHoleWake from '$lib/mx/MxIslandHoleWake.svelte' with {
		render: 'deferred',
		fetch: 'load'
	};
	import MxCtxRead from '$lib/mx/MxCtxRead.svelte';
	import MxMounted from '$lib/mx/MxMounted.svelte';
	import MxCtxLake from '$lib/mx/MxCtxLake.svelte' with { wake: 'none' };
	import { setContext } from 'ogygia';

	const only = page.url.searchParams.get('only');
	const show = (c: string) => !only || only === c;
	setContext('mx-design', 'v2');
	const base_start = 700;
</script>

<!-- template-root snippets, shared by live snippets below: a parameter, an import, a host value -->
{#snippet banner(position: 'top' | 'middle')}
	<p data-banner={position}>
		banner {position}
		<Bumper start={base_start + (position === 'top' ? 1 : 2)} />
	</p>
{/snippet}
{#snippet banner_hole(position: 'top' | 'middle')}
	<MxIslandHole start={base_start + (position === 'top' ? 10 : 20)}>
		{#snippet ogygiaFallback()}<p data-hole-fallback={position}>loading {position}</p>{/snippet}
	</MxIslandHole>
{/snippet}

{#if show('snippet-root-sibling')}
	<div data-case="snippet-root-sibling">
		<MxTwoSlots>
			{#snippet top()}{@render banner('top')}{/snippet}
			{#snippet middle()}{@render banner('middle')}{/snippet}
		</MxTwoSlots>
	</div>
{/if}

{#if show('snippet-root-hole')}
	<div data-case="snippet-root-hole">
		<MxTwoSlots>
			{#snippet top()}{@render banner_hole('top')}{/snippet}
			{#snippet middle()}{@render banner_hole('middle')}{/snippet}
		</MxTwoSlots>
	</div>
{/if}

{#if show('snippet-module')}
	<div data-case="snippet-module">
		<SnipApp>
			{#snippet blocks()}<MxModuleRead label="module" /><Bumper start={MODULE_START} />{/snippet}
		</SnipApp>
	</div>
{/if}

{#if show('snippet-timing')}
	<div data-case="snippet-timing">
		<SnipApp>
			{#snippet blocks()}<MxMounted />{/snippet}
		</SnipApp>
	</div>
{/if}

{#if show('snippet-context')}
	<div data-case="snippet-context">
		<SnipApp>
			{#snippet blocks()}<MxCtxRead label="direct" /><MxCtxLake />{/snippet}
		</SnipApp>
	</div>
{/if}

<h1 data-static>Nesting matrix</h1>

{#if show('shell-lake')}<div data-case="shell-lake"><SnipLake start={100} /></div>{/if}

{#if show('island-own-lake')}<div data-case="island-own-lake"><MxLakeHost start={110} /></div>{/if}

{#if show('island-own-hole')}<div data-case="island-own-hole"><MxHoleHost start={115} /></div>{/if}

{#if show('slot-lake')}
	<div data-case="slot-lake">
		<MxChildrenApp><SnipLake start={120} /></MxChildrenApp>
	</div>
{/if}

{#if show('snippet-lake')}
	<div data-case="snippet-lake">
		<SnipApp>
			{#snippet blocks()}<SnipLake start={130} />{/snippet}
		</SnipApp>
	</div>
{/if}

{#if show('snippet-island')}
	<div data-case="snippet-island">
		<SnipApp>
			{#snippet blocks()}<p>direct <Bumper start={140} /></p>{/snippet}
		</SnipApp>
	</div>
{/if}

{#if show('snippet-mixed')}
	<div data-case="snippet-mixed">
		<SnipApp>
			{#snippet blocks()}<SnipLake start={145} />
				<p>direct <Bumper start={146} /></p>{/snippet}
		</SnipApp>
	</div>
{/if}

{#if show('snippet-hole-recreate')}
	<div data-case="snippet-hole-recreate">
		<MxToggleApp>
			{#snippet blocks()}
				<MxIslandHole start={160}>
					{#snippet ogygiaFallback()}<p data-hole-fallback>loading</p>{/snippet}
				</MxIslandHole>
			{/snippet}
		</MxToggleApp>
	</div>
{/if}

{#if show('snippet-hole')}
	<div data-case="snippet-hole">
		<SnipApp>
			{#snippet blocks()}<MxIslandHole start={150} />{/snippet}
		</SnipApp>
	</div>
{/if}

{#if show('snippet-args-lake')}
	<div data-case="snippet-args-lake">
		<MxRowsApp>
			{#snippet row(i: number)}<SnipLake start={300 + i * 10} />{/snippet}
		</MxRowsApp>
	</div>
{/if}

{#if show('snippet-forwarded-lake')}
	<div data-case="snippet-forwarded-lake">
		<MxPlainForward>
			{#snippet blocks()}<SnipLake start={400} />{/snippet}
		</MxPlainForward>
	</div>
{/if}

{#if show('snippet-in-snippet-lake')}
	<div data-case="snippet-in-snippet-lake">
		<SnipApp>
			{#snippet blocks()}
				<SnipApp>
					{#snippet blocks()}<SnipLake start={500} />{/snippet}
				</SnipApp>
			{/snippet}
		</SnipApp>
	</div>
{/if}

{#if show('static-snippet-island')}
	<div data-case="static-snippet-island">
		{#each [160] as k (k)}
			{#snippet frozen()}<p>frozen <Bumper start={k} /></p>{/snippet}
			<SnipApp blocks={frozen} />
		{/each}
	</div>
{/if}

{#if show('hole-lake')}<div data-case="hole-lake"><MxLakeHole start={170} /></div>{/if}

{#if show('hole-wake-lake')}<div data-case="hole-wake-lake">
		<MxLakeHoleWake start={180} />
	</div>{/if}

{#if show('hole-island')}<div data-case="hole-island"><MxIslandHole start={190} /></div>{/if}

{#if show('hole-wake-island')}<div data-case="hole-wake-island">
		<MxIslandHoleWake start={200} />
	</div>{/if}
