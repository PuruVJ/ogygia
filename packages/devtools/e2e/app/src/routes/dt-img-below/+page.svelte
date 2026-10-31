<script lang="ts">
	// IMAGES BELOW THE FIRST SCREEN, for the devtools answer key. The plants: two ~350 KB images 3,000px
	// down with no `loading="lazy"` — they load at start. The decoys: the hero (on the first screen),
	// the same image below with `loading="lazy"`, and a ~11 KB image below (too small to matter).
</script>

<h1>images below the fold lab</h1>
<img src="/dt-img/right.png?hero" width="400" height="300" alt="decoy: the hero, on the first screen" />
<div style="height: 3000px"></div>
<img src="/dt-img/right.png?a" width="400" height="300" alt="planted: far below, eager" />
<img src="/dt-img/right.png?b" width="400" height="300" alt="planted: far below, eager" />
<img src="/dt-img/right.png?lazy" width="400" height="300" loading="lazy" alt="decoy: far below, lazy" />
<img src="/dt-img/flat.png?icon" width="300" height="200" alt="decoy: far below, small" />
