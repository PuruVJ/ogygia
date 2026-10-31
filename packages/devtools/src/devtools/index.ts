/**
 * `@ogygia/devtools` — the event layer (`ogygia/events`: types + the bus + sink helpers, re-exported
 * here unchanged) plus the devtools UI's installer.
 *
 * The framework EMITS from its own seams behind the `__OGYGIA_DEVTOOLS__` compile gate (turned on by
 * `devtools()` in `ogygia({ plugins })`); this module is what a SINK author imports to read the stream.
 */
export {
	DEVTOOLS,
	emit,
	snapshot,
	clear,
	add_sink,
	configure,
	ingest,
	type DevtoolsSink,
	install_window_sink,
	install_postmessage_sink,
	install_console_sink,
	ingest_server_events,
	to_trace,
	type DevtoolsWindowHook,
	type DevtoolsTrace,
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
} from 'ogygia/events';

export { install_devtools_ui } from './ui.ts';
