// The `host` global in a website: `desktop({ adapter })` without a desktop target. Nothing of the
// shell comes with it, on the page or in the server code. It says it isn't the desktop, and any
// call rejects, as one does in a browser tab of the desktop app.
const member = (path) =>
  new Proxy(function () {}, {
    get: (_, key) => (typeof key === "symbol" || key === "then" ? undefined : member(`${path}.${key}`)),
    apply: () => Promise.reject(Object.assign(new Error(`host.${path} needs the desktop app`), { code: "unavailable" })),
  });

globalThis.host ??= new Proxy(
  { available: false },
  { get: (target, key) => (typeof key === "symbol" || key in target ? target[key] : member(key)) },
);
