import type { ApplicationLogger } from './ports';

export interface PollingLoopOptions {
  /** Names the loop in error logs. */
  readonly name: string;
  /** Pause after a round that found nothing to do, or failed. */
  readonly pollIntervalMs: number;
  readonly logger: ApplicationLogger;
  /** One round of work; resolves to whether it found any, in which case the next starts at once. */
  readonly round: () => Promise<boolean>;
}

/**
 * Runs rounds of background work until stopped (outbox relay, retry worker). A failed round is
 * logged and retried after the poll interval; `stop()` waits for the round in progress.
 */
export class PollingLoop {
  private stopping = false;
  private running: Promise<void> | undefined;

  constructor(private readonly options: PollingLoopOptions) {}

  start(): void {
    if (this.running !== undefined) return;
    this.stopping = false;
    this.running = this.run();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.running;
    this.running = undefined;
  }

  private async run(): Promise<void> {
    while (!this.isStopping()) {
      try {
        if (!(await this.options.round())) await Bun.sleep(this.options.pollIntervalMs);
      } catch (error) {
        this.options.logger.error(`${this.options.name} round failed`, {
          error: error instanceof Error ? error.message : String(error),
        });
        await Bun.sleep(this.options.pollIntervalMs);
      }
    }
  }

  /** Read through a method: `stopping` changes while this instance awaits, which narrowing ignores. */
  private isStopping(): boolean {
    return this.stopping;
  }
}
