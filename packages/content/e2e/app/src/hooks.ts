// `...ogygia.transport` teaches Kit's wire codec the region value, so a load can return a content
// entry's body (a region) the way the docs pages do.
import * as ogygia from 'ogygia';

export const transport = { ...ogygia.transport };
