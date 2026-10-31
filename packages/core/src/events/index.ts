/**
 * `ogygia/events` — the PUBLIC surface of the event layer (internal/notes/devtools.md, Rung 0).
 * Deliberately minimal: types + the bus + sink helpers. Everything downstream (the devtools UI, the
 * REPL, the Boundary lens, the Vite devtools plugin) is a consumer of what's here; ogygia itself
 * carries no UI opinion.
 *
 * The framework EMITS from its own seams behind the `__OGYGIA_DEVTOOLS__` compile gate (turned on by
 * a plugin's `b.events()`: the devtools plugin); this module is what a SINK author imports to read the stream.
 */
export {
	DEVTOOLS,
	emit,
	snapshot,
	clear,
	add_sink,
	configure,
	ingest,
	type DevtoolsSink
} from './bus.ts';

export {
	install_window_sink,
	install_postmessage_sink,
	install_console_sink,
	ingest_server_events,
	to_trace,
	type DevtoolsWindowHook,
	type DevtoolsTrace
} from './sinks.ts';

export {
	DEVTOOLS_SCHEMA_VERSION,
	type DevtoolsDomain,
	type DevtoolsEnvelope,
	type DevtoolsEvent,
	type DevtoolsEventInput,
	type CompileEventInput,
	type ServerEventInput,
	type WireEventInput,
	type RuntimeEventInput,
	type HubEventInput,
	type NavEventInput
} from './schema.ts';
