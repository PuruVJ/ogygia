/**
 * `ogygia/federation` — fragment federation v2 (SERVER side of the wire). One `federate()` per app
 * declares its identity + peers; the handle serves `/og/fragment/*` and `/og/thaw`. Remote
 * fragments are region values (`peer.page()` / `peer.widget()`), and a publish or deploy on one
 * team thaws the frozen pages of every team that baked its fragments. Design:
 * internal/notes/federation.md.
 */
export { federate } from './federate.js';
export { mount, type MountOptions, type KitMountOptions } from './mount.js';
export { user, sign_headers, child_traceparent, verify_signed_request } from './wire.js';
export { serve_federation, install_federation } from './serve.js';
export type {
	FederateConfig,
	PeerConfig,
	Peer,
	RemoteDials,
	Widget,
	WidgetInfo,
	VisitorResolver
} from './types.js';
export type { Claims, FragmentDocument, WidgetDocument, VerifyConfig } from './wire.js';
