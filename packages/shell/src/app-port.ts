// The app's server keeps its port from one launch to the next. Web views keep localStorage,
// IndexedDB, saved permissions and service workers by origin, and the port is part of the origin:
// on a new port every launch, an app would find all of them empty.
//
// The port comes from the app's identifier, below the ranges the OS hands out for outgoing
// connections (Linux from 32768, macOS and Windows from 49152). Taken by something else, the next
// candidate: nothing is saved, so a port that's only busy for one launch costs that launch alone.
const FIRST_PORT = 10000;
const PORTS = 22000;
const CANDIDATES = 8;

/** The ports this app tries, in order. Always the same for an identifier. */
export function appPorts(identifier: string): number[] {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(identifier)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return Array.from({ length: CANDIDATES }, (_, i) => FIRST_PORT + ((hash + i * 7919) % PORTS));
}

/** Starts on the first free port of this app. All taken: any free port, for this launch. */
export function listenOnAppPort<T>(identifier: string, start: (port: number) => T): T {
  const ports = appPorts(identifier);
  for (const [i, port] of ports.entries()) {
    try {
      const started = start(port);
      if (i > 0) console.warn(`[shell] port ${ports[0]} is taken: serving on ${port}. Local storage is kept per port, so this launch doesn't see what's stored on the other one.`);
      return started;
    } catch (err) {
      if ((err as { code?: string }).code !== "EADDRINUSE") throw err;
    }
  }
  console.warn(`[shell] ports ${ports.join(", ")} are all taken: serving on a free port. Local storage starts empty for this launch.`);
  return start(0);
}
