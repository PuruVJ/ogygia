<script lang="ts">
	// The lab index — a hand guide for testing the passage-branch runtime. No islands here; the
	// interactive demos live on the sub-pages linked in the header.
</script>

<h1>ogygia runtime lab</h1>
<p class="intro">
	A small hands-on test rig for the <code>passage</code> branch: server-delta nav, streaming server
	islands, and cross-island serialization. Open your browser <b>DevTools → Network</b> and
	<b>Console</b> before you start. Console should stay clean the whole time.
</p>

<section>
	<h2>1 · Server-delta navigation (kept regions)</h2>
	<p>
		The blue island above lives in the shared <code>/lab</code> layout. On an SPA nav between pages
		that both show it unchanged, the server sends back a <b>delta</b> and skips re-rendering it.
	</p>
	<ol>
		<li>Click the <b>clicks</b> button a few times (say to 4).</li>
		<li>Note the <b>hydrated at</b> time and <b>times mounted: 1</b>.</li>
		<li>Now click <a href="/lab/a" data-lab-a>Page A</a> and <a href="/lab/b" data-lab-b>Page B</a> back and forth.</li>
	</ol>
	<p class="verdict">
		✅ <b>PASS:</b> clicks stay at 4, hydrated-time unchanged, mounts still 1, and only the page
		heading swaps. In Network, the nav request returns a small delta; the persistent region carries
		<code>data-og-skipped</code>.<br />
		❌ <b>FAIL:</b> clicks reset to 0, hydrated-time changes, or the whole page hard-reloads.
	</p>
</section>

<section>
	<h2>2 · Streaming server islands (deferred holes)</h2>
	<p>
		<a href="/lab/stream">Streaming →</a> renders <em>server islands</em>: a fallback shows in the
		initial HTML, then the runtime fetches the real component (rendered on the server, no client JS)
		and swaps it in.
	</p>
	<p class="verdict">
		✅ <b>PASS:</b> you briefly see the dashed “loading…” fallback, then a purple greeting with a
		server timestamp appears. Network shows an <code>/_islands</code> request. No component JS in the
		page bundle.<br />
		❌ <b>FAIL:</b> the fallback never resolves, or a console/hydration error appears.
	</p>
</section>

<section>
	<h2>3 · Cross-island serialization (one live object, many islands)</h2>
	<p>
		<a href="/lab/wire">Serialization →</a> provides ONE transportable class instance
		(<code>import.meta.og.wire</code>) to the page. Three separate island bundles read it from
		context — the encoded object is revived to the <b>same live instance</b> in every island.
	</p>
	<p class="verdict">
		✅ <b>PASS:</b> click <b>inc</b> in the writer and BOTH readers' count + double update instantly
		(same heap). Each island shows <code>is-instance: true</code>.<br />
		❌ <b>FAIL:</b> a reader stays at −1 / <code>is-instance: false</code>, or only one island updates.
	</p>
</section>

<section class="more">
	<h2>Already-built fixtures worth a look</h2>
	<ul>
		<li><a href="/delta/a">/delta/a</a> ⇄ <a href="/delta/b">/delta/b</a> — the minimal server-delta pair (e2e-backed).</li>
		<li><a href="/live-partial">/live-partial</a> — <code>query.live</code> pushing rendered HTML each tick over Kit's SSE.</li>
		<li><a href="/server">/server</a> — a single deferred server island with a fallback.</li>
		<li><a href="/context">/context</a> — the full cross-island context + transportable matrix.</li>
		<li><a href="/dollar-fn">/dollar-fn</a> — a function (<code>import.meta.og.$</code>) crossing the boundary.</li>
		<li><a href="/portable">/portable</a> — one island import used as tag, dynamic component, and each-list.</li>
	</ul>
</section>

<style>
	.intro {
		background: #f8fafc;
		border-left: 3px solid #2563eb;
		padding: 10px 14px;
	}
	section {
		margin: 22px 0;
	}
	h2 {
		font-size: 1.15rem;
	}
	.verdict {
		background: #f1f5f9;
		border-radius: 8px;
		padding: 10px 14px;
		line-height: 1.6;
	}
	.more ul {
		line-height: 1.9;
	}
	code {
		background: #eef2ff;
		padding: 1px 5px;
		border-radius: 4px;
	}
	a {
		color: #2563eb;
	}
</style>
