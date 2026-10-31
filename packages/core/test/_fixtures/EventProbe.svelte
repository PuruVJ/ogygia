<script lang="ts">
	// Probe: what `requestEvent()` hands a server-rendered component.
	import { requestEvent } from '../../src/request-event.js';
	const event = requestEvent<{ locals: { user: string | null }; url: URL }>();
</script>

<p>{event ? `${event.locals.user ?? 'guest'}|${event.url.pathname}` : 'NO EVENT'}</p>
