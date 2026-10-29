import type PgBoss from 'pg-boss';

/**
 * Adaptive pg-boss poller.
 *
 * Replaces `boss.work()` so the database can scale to zero (Neon suspends a compute
 * after ~5 minutes without queries). pg-boss' built-in worker polls every queue on a
 * fixed interval (default 2s) and waits that interval even after finding jobs, so a
 * long interval would also slow down draining a busy queue.
 *
 * Behaviour:
 *   - Jobs found     → process them and poll again immediately.
 *   - Recently busy  → poll every `activeIntervalMs`.
 *   - Idle           → after `idleAfterMs` without jobs, run maintenance once, call
 *                      `onIdle` (e.g. close DB connections) and poll every `idleIntervalMs`.
 *   - Any queue finding work wakes the other (sleeping) queue loops, so follow-up jobs
 *     (discover → crawl → personalize) are picked up without waiting for the idle interval.
 *
 * Maintenance (`boss.maintain()`: expire stuck jobs, archive, purge) runs on startup,
 * when going idle, and at most every `maintenanceIntervalMs` otherwise — pg-boss'
 * own `supervise` loop must be disabled, or it keeps the database awake.
 */

export type PollerBoss = Pick<PgBoss, 'fetch' | 'complete' | 'fail' | 'maintain'>;

export interface PollerQueue<T = any> {
  name: string;
  batchSize: number;
  handler: (job: PgBoss.JobWithMetadata<T>) => Promise<void>;
}

export interface PollerTimings {
  /** Gap between polls while there was recent work. */
  activeIntervalMs: number;
  /** Gap between polls once idle. Keep above Neon's suspend timeout (5 min) so it can sleep. */
  idleIntervalMs: number;
  /** Time without any job before switching to idle polling. */
  idleAfterMs: number;
  /** Max gap between maintenance runs while not idle. */
  maintenanceIntervalMs: number;
}

export interface PollerHooks {
  /** Called once each time the poller goes idle (no jobs running, none found for `idleAfterMs`). */
  onIdle?: () => Promise<void>;
  log?: (msg: string) => void;
  logError?: (msg: string, err: unknown) => void;
}

const DEFAULT_JOB_TIMEOUT_SECONDS = 15 * 60; // pg-boss default expire_in

export class QueuePoller {
  private stopped = false;
  private idle = false;
  private inFlight = 0;
  private lastActivityAt = Date.now();
  private lastMaintenanceAt = 0;
  private maintaining: Promise<void> | null = null;
  private readonly sleepers = new Set<() => void>();
  private loops: Promise<void>[] = [];
  private readonly log: (msg: string) => void;
  private readonly logError: (msg: string, err: unknown) => void;

  constructor(
    private readonly boss: PollerBoss,
    private readonly queues: PollerQueue[],
    private readonly timings: PollerTimings,
    private readonly hooks: PollerHooks = {},
  ) {
    this.log = hooks.log ?? ((msg) => console.log(msg));
    this.logError = hooks.logError ?? ((msg, err) => console.error(msg, err));
  }

  async start(): Promise<void> {
    // Recover jobs left `active` by a previous crash / shutdown before polling.
    await this.maintain();
    this.lastActivityAt = Date.now();
    this.loops = this.queues.map((q) => this.runLoop(q));
  }

  /** Stops polling and waits up to `timeoutMs` for in-flight jobs to finish. */
  async stop(timeoutMs = 30_000): Promise<void> {
    this.stopped = true;
    this.wakeAll();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(this.loops),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
    clearTimeout(timer);
  }

  isIdle(): boolean {
    return this.idle;
  }

  private async runLoop(queue: PollerQueue): Promise<void> {
    while (!this.stopped) {
      let jobs: PgBoss.JobWithMetadata[] = [];
      try {
        jobs = await this.boss.fetch<object>(queue.name, { batchSize: queue.batchSize, includeMetadata: true });
      } catch (err) {
        this.logError(`[poller] fetch failed for "${queue.name}":`, err);
      }

      if (jobs.length > 0) {
        this.markActive();
        this.inFlight++;
        try {
          for (const job of jobs) await this.runJob(queue, job);
        } finally {
          this.inFlight--;
          this.lastActivityAt = Date.now();
        }
        await this.maintainIfDue();
        continue; // more jobs may be waiting — poll again right away
      }

      if (this.shouldGoIdle()) {
        await this.enterIdle();
      } else {
        await this.maintainIfDue();
      }

      await this.sleep(this.idle ? this.timings.idleIntervalMs : this.timings.activeIntervalMs);
    }
  }

  private async runJob(queue: PollerQueue, job: PgBoss.JobWithMetadata): Promise<void> {
    try {
      await withTimeout(queue.handler(job), jobTimeoutMs(job), `job ${job.id} on "${queue.name}"`);
      await this.boss.complete(queue.name, job.id);
    } catch (err) {
      try {
        await this.boss.fail(queue.name, job.id, serializeError(err));
      } catch (failErr) {
        this.logError(`[poller] could not mark job ${job.id} failed on "${queue.name}":`, failErr);
      }
    }
  }

  private markActive(): void {
    this.lastActivityAt = Date.now();
    if (this.idle) {
      this.idle = false;
      this.log('[poller] work found — switching to active polling');
      this.wakeAll();
    }
  }

  private shouldGoIdle(): boolean {
    return !this.idle && this.inFlight === 0 && Date.now() - this.lastActivityAt >= this.timings.idleAfterMs;
  }

  private async enterIdle(): Promise<void> {
    // Set synchronously so concurrent queue loops only run this once.
    this.idle = true;
    await this.maintain();
    if (!this.idle) return; // another loop found work meanwhile
    try {
      await this.hooks.onIdle?.();
    } catch (err) {
      this.logError('[poller] onIdle hook failed:', err);
    }
    this.log(`[poller] idle — polling every ${Math.round(this.timings.idleIntervalMs / 1000)}s`);
  }

  private async maintainIfDue(): Promise<void> {
    if (Date.now() - this.lastMaintenanceAt >= this.timings.maintenanceIntervalMs) {
      await this.maintain();
    }
  }

  private maintain(): Promise<void> {
    if (!this.maintaining) {
      this.maintaining = (async () => {
        try {
          await this.boss.maintain();
        } catch (err) {
          this.logError('[poller] maintenance failed:', err);
        } finally {
          this.lastMaintenanceAt = Date.now();
          this.maintaining = null;
        }
      })();
    }
    return this.maintaining;
  }

  private sleep(ms: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.sleepers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.sleepers.add(done);
    });
  }

  private wakeAll(): void {
    for (const wake of [...this.sleepers]) wake();
  }
}

function jobTimeoutMs(job: PgBoss.JobWithMetadata): number {
  const seconds = Number(job.expireInSeconds);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_JOB_TIMEOUT_SECONDS) * 1000;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function serializeError(err: unknown): object {
  if (err instanceof Error) return { message: err.message, stack: err.stack };
  return { message: String(err) };
}
