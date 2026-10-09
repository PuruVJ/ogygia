import { handle as ogygiaHandle } from 'ogygia/server';
// federate() registers dash's widget catalog + peers with the handle (which serves /og/fragment/*).
import './lib/federation.server.js';

export const handle = ogygiaHandle();
