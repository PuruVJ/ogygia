/**
 * `@ogygia/federation` — fragment federation v2 (SERVER side of the wire). `federation()` in the vite
 * plugins turns it on; one `federate()` per app declares its identity + peers; the handle serves
 * `/og/fragment/*` and `/og/thaw`. Remote
 * fragments are region values (`peer.page()` / `peer.widget()`), and a publish or deploy on one
 * team thaws the frozen pages of every team that baked its fragments. Design:
 * internal/notes/federation.md.
 */
export { federate } from './federate.ts';
export { mount, type MountOptions, type KitMountOptions } from './mount.ts';
export { user, sign_headers, child_traceparent, verify_signed_request } from './wire.ts';
export type {
	FederateConfig,
	PeerConfig,
	Peer,
	RemoteDials,
	Widget,
	WidgetInfo,
	VisitorResolver
} from './types.ts';
export type { Claims, FragmentDocument, WidgetDocument, VerifyConfig } from './wire.ts';
