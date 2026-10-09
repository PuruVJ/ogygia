// THE HEADER LAB on a Kit-hydrated page: the locale the header reads, from a cookie a command sets.
export const load = ({ cookies }) => ({ locale: cookies.get('hl_locale') ?? 'en' });
