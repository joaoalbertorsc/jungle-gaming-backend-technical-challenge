import type { Subprocess } from 'bun';
import type { HttpResponse } from './http';

/** Environment every spawned role gets on top of the test process environment. */
const FAST_WORKERS: Record<string, string> = {
  NODE_ENV: 'test',
  NO_COLOR: '1',
  DB_POOL_MAX: '5',
  SQS_WAIT_TIME_SECONDS: '1',
  CONSUMER_DRAIN_TIMEOUT_MS: '5000',
  OUTBOX_POLL_INTERVAL_MS: '50',
  REFERENCE_RETRY_POLL_INTERVAL_MS: '50',
};

const READY = /roles \[[^\]]*\] up/;

export interface SpawnOptions {
  readonly env?: Record<string, string>;
  /** Wait for the "roles [...] up" line (default). Off for processes expected to crash at once. */
  readonly waitUntilReady?: boolean;
}

/** One `bun src/main.ts` process: the production entry point, started like a container. */
export class RoleProcess {
  private readonly chunks: string[] = [];
  readonly exited: Promise<number>;

  constructor(
    readonly roles: string,
    private readonly process: Subprocess<'ignore', 'pipe', 'pipe'>,
    readonly baseUrl: string | undefined,
  ) {
    this.exited = process.exited;
    void this.collect(process.stdout);
    void this.collect(process.stderr);
  }

  get pid(): number {
    return this.process.pid;
  }

  /** Everything the process wrote so far (stdout and stderr). */
  output(): string {
    return this.chunks.join('');
  }

  hasExited(): boolean {
    return this.process.exitCode !== null || this.process.signalCode !== null;
  }

  /** SIGKILL: no shutdown hook runs, like a container killed by the orchestrator. */
  async kill(): Promise<void> {
    if (!this.hasExited()) this.process.kill('SIGKILL');
    await this.exited;
  }

  /** SIGTERM: the graceful shutdown path. Resolves with the exit code. */
  async stop(): Promise<number> {
    if (!this.hasExited()) this.process.kill('SIGTERM');
    return this.exited;
  }

  async request(
    method: 'GET' | 'POST',
    path: string,
    options: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<HttpResponse> {
    if (this.baseUrl === undefined) throw new Error(`${this.roles} has no HTTP server`);
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...options.headers },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
    };
  }

  async waitUntilReady(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!READY.test(this.output())) {
      if (this.hasExited()) {
        throw new Error(`${this.roles} exited before it was ready:\n${this.output()}`);
      }
      if (Date.now() > deadline) {
        throw new Error(`${this.roles} not ready after ${String(timeoutMs)} ms:\n${this.output()}`);
      }
      await Bun.sleep(50);
    }
  }

  private async collect(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of stream) this.chunks.push(decoder.decode(chunk));
  }
}

/**
 * Starts application roles as separate OS processes (§13: ≥ 3 instances, crashes, restarts) and
 * makes sure none outlives the test that started it.
 */
export class ProcessGroup {
  private readonly processes: RoleProcess[] = [];

  constructor(private readonly env: Record<string, string>) {}

  async spawn(roles: string, options: SpawnOptions = {}): Promise<RoleProcess> {
    const port = roles.split(',').includes('api') ? freePort() : undefined;
    const child = Bun.spawn([process.execPath, 'src/main.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...FAST_WORKERS,
        ...this.env,
        ...options.env,
        APP_ROLES: roles,
        ...(port === undefined ? {} : { HTTP_PORT: String(port) }),
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const role = new RoleProcess(
      roles,
      child,
      port === undefined ? undefined : `http://127.0.0.1:${String(port)}`,
    );
    this.processes.push(role);
    if (options.waitUntilReady ?? true) await role.waitUntilReady();
    return role;
  }

  /** SIGKILLs whatever is still running. */
  async killAll(): Promise<void> {
    await Promise.all(this.processes.map((role) => role.kill()));
    this.processes.length = 0;
  }
}

function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = server;
  void server.stop(true);
  if (port === undefined) throw new Error('could not reserve a port');
  return port;
}

/** Polls `probe` until it returns a truthy value; fails with `description` after the timeout. */
export async function eventually<T>(
  description: string,
  probe: () => Promise<T | false | undefined | null>,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  for (;;) {
    const value = await probe();
    if (value !== false && value !== undefined && value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await Bun.sleep(options.intervalMs ?? 100);
  }
}
