<script lang="ts">
	// THE IMAGE LAB for the devtools answer key. The plant: big.png, 2000×1333 (~300 KB), shown at
	// 300×200 — most of its bytes are pixels nobody sees. The decoys: flat.png (the same size but a
	// few KB: nothing to save), right.png (shown at its own size), and big.png again in a hidden box
	// (no box, nothing shown). Only big.png in its 300×200 box is named.
</script>

<h1>image lab</h1>
<img src="/dt-img/big.png" width="300" height="200" alt="planted: far bigger than shown" />
<img src="/dt-img/flat.png" width="300" height="200" alt="decoy: big but tiny on the wire" />
<img src="/dt-img/right.png" width="400" height="300" alt="decoy: shown at its size" />
<div hidden><img src="/dt-img/big.png?hidden" alt="decoy: hidden" /></div>
