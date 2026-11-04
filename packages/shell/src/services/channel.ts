// Both directions acknowledge consumption. One in flight, with a bounded waiting
// queue, avoids moving an unbounded stream into Bun's IPC buffer.
export interface Packet { t: 'data' | 'ack'; id: number; value?: unknown }
export function jsonValue(value: unknown, limit: number): unknown {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('service messages must be JSON-serializable');
  if (Buffer.byteLength(json) > limit) throw new Error('service message exceeds maxMessageBytes');
  return JSON.parse(json);
}
export function channel(write: (packet: Packet) => void, capacity: number, maxBytes: number, receive: (value: unknown) => void | Promise<void>, fail: (error: Error) => void) {
  let seq = 0, active = false;
  let closed: Error | undefined;
  const queue: Array<{ id: number; value: unknown; resolve(): void; reject(error: Error): void }> = [];
  function pump() {
    if (active || !queue.length || closed) return;
    active = true;
    try { write({ t: 'data', id: queue[0]!.id, value: queue[0]!.value }); }
    catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
  }
  return {
    send(value: unknown): Promise<void> {
      if (closed) return Promise.reject(closed);
      if (queue.length >= capacity) return Promise.reject(new Error('service queue full'));
      try { value = jsonValue(value, maxBytes); } catch (error) { return Promise.reject(error); }
      const result = new Promise<void>((resolve, reject) => queue.push({ id: ++seq, value, resolve, reject }));
      pump();
      return result;
    },
    async receive(packet: Packet) {
      if (closed) return;
      if (packet.t === 'ack') {
        if (queue[0]?.id !== packet.id) return;
        queue.shift()!.resolve(); active = false; pump();
      } else if (packet.t === 'data') {
        try {
          await receive(packet.value);
          if (!closed) write({ t: 'ack', id: packet.id });
        } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
      }
    },
    close(error: Error) {
      closed = error;
      for (const item of queue.splice(0)) item.reject(error);
    },
  };
}
export function limits(options: { capacity?: number; maxMessageBytes?: number }) {
  const capacity = options.capacity ?? 64, maxMessageBytes = options.maxMessageBytes ?? 1024 * 1024;
  for (const n of [capacity, maxMessageBytes]) if (!Number.isSafeInteger(n) || n < 1) throw new Error('service limits must be positive integers');
  return { capacity, maxMessageBytes };
}
