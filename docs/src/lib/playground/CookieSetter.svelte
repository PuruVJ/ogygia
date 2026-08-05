<script lang="ts">
	// A tiny client island that writes the `pg_name` cookie and reloads. The reload is a full
	// document load, so the deferred server island re-fetches and re-renders with the new cookie.
	let name = $state('');

	function save() {
		const value = name.trim() || 'voyager';
		document.cookie = `pg_name=${encodeURIComponent(value)}; path=/; max-age=86400; samesite=lax`;
		location.reload();
	}
</script>

<div class="widget" data-cookie-setter style="max-width: 320px;">
	<span class="widget-label">personalize the greeting</span>
	<div class="widget-row">
		<input
			type="text"
			bind:value={name}
			placeholder="your name"
			data-cookie-input
			style="flex: 1; min-width: 0; padding: 0.5rem 0.625rem; border: 1px solid var(--line-strong); border-radius: var(--r-sm); background: var(--bg-raised); color: var(--text); font: 400 0.8125rem/1.4 var(--font-body);"
		/>
		<button type="button" data-cookie-save onclick={save}>Save + reload</button>
	</div>
	<p class="widget-meta">writes a cookie, then reloads so the server island reads it</p>
</div>
