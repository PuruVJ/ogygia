// A PLANTED DUPLICATE's build twin (see ../src/catalog.ts): the same module, reached by its dist path.
export const CATALOG = [
	{ sku: 'A-1001', title: 'Harbor lantern', blurb: 'Brass lantern with a frosted globe, for porches that face the sea wind.' },
	{ sku: 'A-1002', title: 'Tide clock', blurb: 'Wall clock that shows high and low water alongside the hour and minute.' },
	{ sku: 'A-1003', title: 'Rope coaster set', blurb: 'Six coasters of braided cotton rope, finished with a waxed edge.' },
	{ sku: 'A-1004', title: 'Driftwood frame', blurb: 'Photo frame cut from beach driftwood, each grain pattern its own.' },
	{ sku: 'A-1005', title: 'Sailcloth tote', blurb: 'Heavy tote sewn from retired sailcloth, with leather handles.' },
	{ sku: 'A-1006', title: 'Lighthouse print', blurb: 'Screen print of a cliff light at dusk, on cotton rag paper.' },
	{ sku: 'A-1007', title: 'Compass bowl', blurb: 'Turned walnut bowl with a compass rose burned into its base.' },
	{ sku: 'A-1008', title: 'Storm glass', blurb: 'Sealed glass of camphor crystals that cloud before a change in weather.' },
	{ sku: 'A-1009', title: 'Anchor hook', blurb: 'Cast iron hook in the shape of a fouled anchor, for coats and keys.' },
	{ sku: 'A-1010', title: 'Knot board', blurb: 'Oak board with twelve sailor knots tied and labeled in hemp.' },
	{ sku: 'A-1011', title: 'Shell candle', blurb: 'Soy candle poured into a scallop shell, scented with sea salt.' },
	{ sku: 'A-1012', title: 'Chart blanket', blurb: 'Wool throw woven with the soundings of a small harbor chart.' },
	{ sku: 'A-1013', title: 'Porthole mirror', blurb: 'Round mirror in a hinged brass porthole, eleven inches across.' },
	{ sku: 'A-1014', title: 'Buoy bookends', blurb: 'Pair of painted wooden buoys weighted to hold a shelf of books.' },
	{ sku: 'A-1015', title: 'Net hammock', blurb: 'Hand knotted cotton hammock with spreader bars of ash.' },
	{ sku: 'A-1016', title: 'Captain mug', blurb: 'Stoneware mug with a wide base that does not tip on a moving deck.' },
	{ sku: 'A-1017', title: 'Barometer', blurb: 'Aneroid barometer in a teak case, set at the factory for sea level.' },
	{ sku: 'A-1018', title: 'Oar rack', blurb: 'Wall rack that holds two oars crossed above a doorway.' },
	{ sku: 'A-1019', title: 'Signal flags', blurb: 'Set of forty signal flags on a cord, for a mast or a hallway.' },
	{ sku: 'A-1020', title: 'Ship in a bottle', blurb: 'Three masted barque assembled inside a hand blown bottle.' },
	{ sku: 'A-1021', title: 'Kelp soap', blurb: 'Cold process soap with dried kelp and a little sand for scrub.' },
	{ sku: 'A-1022', title: 'Pier bench', blurb: 'Slatted bench of reclaimed pier decking, weathered silver.' },
	{ sku: 'A-1023', title: 'Cork float lamp', blurb: 'Table lamp built around a cluster of old net cork floats.' },
	{ sku: 'A-1024', title: 'Harbor map tiles', blurb: 'Nine ceramic tiles that join into a map of a fishing harbor.' },
	{ sku: 'A-1025', title: 'Wave glassware', blurb: 'Four tumblers with a rolling wave line etched near the rim.' },
	{ sku: 'A-1026', title: 'Deck shoes', blurb: 'Canvas shoes with siped soles that grip a wet teak deck.' },
	{ sku: 'A-1027', title: 'Sextant replica', blurb: 'Working brass sextant in a fitted box with a spare mirror.' },
	{ sku: 'A-1028', title: 'Fog horn bell', blurb: 'Bronze bell on a wall bracket, rung with a short lanyard.' },
	{ sku: 'A-1029', title: 'Salt cellar', blurb: 'Wooden salt cellar carved like a small dory with a lid.' },
	{ sku: 'A-1030', title: 'Sea glass mobile', blurb: 'Mobile of tumbled sea glass on fishing line and a driftwood bar.' },
	{ sku: 'A-1031', title: 'Tidal almanac', blurb: 'Printed almanac of tide tables, moon phases and sunrise times.' },
	{ sku: 'A-1032', title: 'Cleat hooks', blurb: 'Pair of boat cleats mounted as towel hooks, in polished steel.' },
	{ sku: 'A-1033', title: 'Rigging lamp', blurb: 'Hanging lamp shaped like a masthead light, wired for the home.' },
	{ sku: 'A-1034', title: 'Pebble rug', blurb: 'Bath mat of smooth river pebbles set on a rubber backing.' },
	{ sku: 'A-1035', title: 'Galley spoon set', blurb: 'Five olive wood spoons with holes for hanging on a galley rail.' },
	{ sku: 'A-1036', title: 'Pennant garland', blurb: 'String of small pennants in faded blues and sand colors.' },
	{ sku: 'A-1037', title: 'Brass spyglass', blurb: 'Telescoping spyglass that folds to the length of a hand.' },
	{ sku: 'A-1038', title: 'Wharf crate', blurb: 'Slatted crate stenciled with an old wharf mark, for storage.' },
	{ sku: 'A-1039', title: 'Seal ornament', blurb: 'Felted wool seal resting on a little rock of felted grey.' },
	{ sku: 'A-1040', title: 'Mooring chain bowl', blurb: 'Fruit bowl welded from short lengths of galvanized chain.' }
];

/**
 * The catalog rows whose title or blurb mention every word of `q`.
 * @param {string} q
 * @returns {{ sku: string; title: string }[]}
 */
export function search_catalog(q) {
	const words = q.toLowerCase().split(' ').filter(Boolean);
	return CATALOG.filter((r) => {
		const text = (r.title + ' ' + r.blurb).toLowerCase();
		return words.every((w) => text.includes(w));
	}).map((r) => ({ sku: r.sku, title: r.title }));
}
