import * as ogygia from 'ogygia';

// Regions cross the wire via Kit's transport hook — which must live in the UNIVERSAL hooks
// (the client needs `decode`), so it comes from 'ogygia', not 'ogygia/server'. This is what lets a
// remote-fetched page's lazy body arrive as a signed ticket that <Region> renders.
export const transport = ogygia.transport;
