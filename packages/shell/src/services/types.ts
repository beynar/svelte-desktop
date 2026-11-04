export interface ServiceOptions {
  /** Maximum unacknowledged messages and pending requests. Default 64. */
  capacity?: number;
  /** Maximum JSON message size. Default 1 MiB. */
  maxMessageBytes?: number;
  /** Startup handshake timeout. Default 10 s. */
  startupTimeoutMs?: number;
  /** Unexpected exits restart at most this many times; messages are never replayed. */
  restart?: { maxRestarts: number; delayMs?: number };
}
export interface ServiceExit { code: number; signal: string | number | null; restarting: boolean }
export interface ServiceHandle {
  readonly name: string;
  readonly pid: number | undefined;
  readonly state: 'running' | 'restarting' | 'stopped';
  /** Resolves when the child consumes the message. Rejects on backpressure or exit. */
  send(data: unknown): Promise<void>;
  request<T = unknown>(data: unknown, options?: { timeoutMs?: number }): Promise<T>;
  on(event: 'message', fn: (data: unknown) => void): () => void;
  on(event: 'exit', fn: (exit: ServiceExit) => void): () => void;
  /** Abort the child, then force-kill after 500 ms. Never restarts. */
  stop(): Promise<void>;
}
export interface ServicePort {
  readonly signal: AbortSignal;
  postMessage(data: unknown): Promise<void>;
  on(event: 'message', fn: (data: unknown) => void | Promise<void>): () => void;
  onRequest(fn: (data: unknown) => unknown | Promise<unknown>): void;
}
export type ServiceFunction<A = unknown> = (args: A, port: ServicePort) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
