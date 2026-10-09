<script lang="ts">
	// Mounts the header region from the remote query, and the button that switches its locale.
	import { Region } from 'ogygia';
	import { headerRegion, switchHeaderLocale } from './header.remote';
</script>

<Region of={headerRegion()} />
<button data-hl-switch onclick={() => switchHeaderLocale('fr')}>français</button>
<button data-hl-back onclick={() => switchHeaderLocale('en')}>english</button>
