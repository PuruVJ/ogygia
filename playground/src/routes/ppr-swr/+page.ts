// SWR mode (same API as `remount`): serve the cached shell instantly, revalidate in the
// background. The shell timestamp advances across requests, unlike 'cache' which freezes.
export const shell = 'swr';
