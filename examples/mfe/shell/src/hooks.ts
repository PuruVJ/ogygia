// Universal hooks. `...ogygia.transport` registers the region codec on Kit's wire, so a REGION
// value can cross a Kit `+page.server.ts` load boundary (Kit serializes load data with devalue,
// which can't handle the region's Symbol-keyed brand on its own). That is what lets the home's
// `+page.server.ts` return `dash.widget(...)` regions — see routes/+page.server.ts. Without this
// line Kit throws "Cannot stringify POJOs with symbolic keys". The wire law: a region is the only
// unit of code that crosses; the transport walks the value and signs one capability per leaf.
import * as ogygia from 'ogygia';

export const transport = { ...ogygia.transport };
