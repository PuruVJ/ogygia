<script lang="ts">
	import { page } from '$app/state';
	let { children, data } = $props();
</script>

<div style="display:flex; gap:2rem;">
	<aside style="min-width:180px;">
		<h3 data-static-shell>Dashboard</h3>
		<p data-static-shell>User: {data.user.name} ({data.user.role})</p>
		<nav style="display:flex; flex-direction:column; gap:.25rem;">
			<a href="/dashboard/orders">Orders ({data.navCounts.get('pending')} pending)</a>
			<a href="/dashboard/orders?status=shipped&sort=total&dir=desc">Shipped (by total)</a>
			<a href="/dashboard/analytics">Analytics</a>
			<a href="/dashboard/settings">Settings</a>
			<a href="/">← Site home</a>
		</nav>
	</aside>
	<main style="flex:1;">
		<!-- shell breadcrumb uses page.state server-side; re-renders every nav -->
		<div data-breadcrumb style="color:#888; font-size:.9rem;">
			route: {page.route.id} — path: {page.url.pathname}
		</div>
		{@render children()}
	</main>
</div>
