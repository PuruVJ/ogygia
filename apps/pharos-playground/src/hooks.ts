// A doc's baked BODY crosses the wire as a region ticket — that requires ogygia's transport codec in
// the UNIVERSAL hooks (Kit's `transport` hook), so `<Region>`/`<Doc>` can revive it client-side.
import * as ogygia from 'ogygia';

export const transport = ogygia.transport;
