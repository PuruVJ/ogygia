import * as ogygia from 'ogygia';

// Partials cross the wire via Kit's transport hook — which must live in the UNIVERSAL hooks
// (the client needs `decode`), so it comes from 'ogygia', not 'ogygia/server'.
export const transport = ogygia.transport;
