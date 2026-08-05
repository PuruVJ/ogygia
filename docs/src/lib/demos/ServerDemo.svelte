<figure class="demo-block">
	<figcaption class="demo-header">
		<span class="demo-title">defer: 'load' · ServerGreeting.svelte</span>
		<span class="caption">0 KB component JS</span>
	</figcaption>
	<div class="demo-body demo-body--stack">
		<div class="demo-code">
			<pre><code>{@html codeHtml}</code></pre>
		</div>
		<div class="demo-preview" data-state="hydrated">
			<span class="preview-marker"><i></i>server HTML swapped in</span>
			<div class="preview-stage">
				<ServerGreeting salutation="Aloha">
					{#snippet fallback()}
						<div class="widget widget--greeting">
							<strong>Fetching island…</strong>
							<p class="widget-meta">Fallback while the server renders</p>
						</div>
					{/snippet}
				</ServerGreeting>
			</div>
		</div>
	</div>
</figure>

<script lang="ts">
	import ServerGreeting from '$lib/demos/ServerGreeting.svelte' with { defer: 'load' };

	const codeHtml = `<span class="tok-keyword">import</span> Greeting <span class="tok-keyword">from</span> <span class="tok-string">'$lib/Greeting.svelte'</span> <span class="tok-keyword">with</span> {
  defer: <span class="tok-string">'load'</span>
};

<span class="tok-punct">&lt;</span><span class="tok-tag">Greeting</span> <span class="tok-attr">salutation</span>=<span class="tok-string">"Aloha"</span><span class="tok-punct">&gt;</span>
  <span class="tok-punct">{#</span>snippet fallback()<span class="tok-punct">}</span>
    <span class="tok-punct">&lt;</span><span class="tok-tag">p</span><span class="tok-punct">&gt;</span>loading…<span class="tok-punct">&lt;/</span><span class="tok-tag">p</span><span class="tok-punct">&gt;</span>
  <span class="tok-punct">{/</span>snippet<span class="tok-punct">}</span>
<span class="tok-punct">&lt;/</span><span class="tok-tag">Greeting</span><span class="tok-punct">&gt;</span>`;
</script>
