// THE HEADER LAB (e2e/header-refresh.spec.ts): the locale the header reads, from a cookie a command sets.
export const load = ({ cookies }) => ({ locale: cookies.get('hl_locale') ?? 'en' });
