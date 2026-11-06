// What dialog.sheet's request carried, for tests/windows-desktop.test.ts.
export const load = ({ request, url }) => ({ header: request.headers.get('x-desktop-view'), title: url.searchParams.get('t') ?? 'sheet probe' });
