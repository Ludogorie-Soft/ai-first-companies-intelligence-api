import { QueuePoller, PollerBoss, PollerTimings } from '../queuePoller';

type FakeJob = { id: string; name: string; data: object; expireInSeconds: number };

/** In-memory stand-in for pg-boss: per-queue job lists plus call counters. */
function fakeBoss() {
  const pending: Record<string, FakeJob[]> = {};
  const completed: string[] = [];
  const failed: string[] = [];
  const fetches: Record<string, number> = {};
  let maintenanceRuns = 0;

  const boss = {
    fetch: async (name: string, opts: { batchSize?: number }) => {
      fetches[name] = (fetches[name] ?? 0) + 1;
      return (pending[name] ?? []).splice(0, opts.batchSize ?? 1);
    },
    complete: async (_name: string, id: string) => { completed.push(id); },
    fail: async (_name: string, id: string) => { failed.push(id); },
    maintain: async () => { maintenanceRuns++; },
  } as unknown as PollerBoss;

  let seq = 0;
  const enqueue = (name: string, count = 1) => {
    for (let i = 0; i < count; i++) {
      (pending[name] ??= []).push({ id: `${name}-${++seq}`, name, data: {}, expireInSeconds: 60 });
    }
  };

  return { boss, enqueue, completed, failed, fetches, maintenanceRuns: () => maintenanceRuns };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const silent = { log: () => {}, logError: () => {} };

const FAST: PollerTimings = {
  activeIntervalMs: 10,
  idleIntervalMs: 60_000,
  idleAfterMs: 50,
  maintenanceIntervalMs: 60_000,
};

describe('QueuePoller', () => {
  let poller: QueuePoller | undefined;
  afterEach(async () => { await poller?.stop(1000); poller = undefined; });

  it('drains a busy queue without waiting between batches', async () => {
    const f = fakeBoss();
    f.enqueue('a', 6);
    const handled: string[] = [];
    poller = new QueuePoller(
      f.boss,
      [{ name: 'a', batchSize: 2, handler: async (job) => { handled.push(job.id); } }],
      { ...FAST, activeIntervalMs: 60_000 }, // would stall if it slept between batches
      silent,
    );
    await poller.start();
    await wait(30);
    expect(handled).toHaveLength(6);
    expect(f.completed).toHaveLength(6);
  });

  it('fails only the job that threw, not its batch siblings', async () => {
    const f = fakeBoss();
    f.enqueue('a', 3);
    poller = new QueuePoller(
      f.boss,
      [{ name: 'a', batchSize: 3, handler: async (job) => { if (job.id === 'a-2') throw new Error('boom'); } }],
      FAST,
      silent,
    );
    await poller.start();
    await wait(30);
    expect(f.failed).toEqual(['a-2']);
    expect(f.completed).toEqual(['a-1', 'a-3']);
  });

  it('goes idle, runs maintenance + onIdle once, and stops polling at the active rate', async () => {
    const f = fakeBoss();
    let idleCalls = 0;
    poller = new QueuePoller(
      f.boss,
      [{ name: 'a', batchSize: 1, handler: async () => {} }, { name: 'b', batchSize: 1, handler: async () => {} }],
      FAST,
      { ...silent, onIdle: async () => { idleCalls++; } },
    );
    await poller.start(); // startup maintenance
    await wait(120);
    expect(poller.isIdle()).toBe(true);
    expect(idleCalls).toBe(1);
    expect(f.maintenanceRuns()).toBe(2); // startup + going idle

    const fetchesWhenIdle = f.fetches.a;
    await wait(100);
    expect(f.fetches.a).toBe(fetchesWhenIdle); // idle interval (60s) — no more polls
  });

  it('wakes all queues when one finds work after being idle', async () => {
    const f = fakeBoss();
    const handled: string[] = [];
    poller = new QueuePoller(
      f.boss,
      [
        // A job on "a" enqueues follow-up work on "b", like crawl → personalize.
        { name: 'a', batchSize: 1, handler: async (job) => { handled.push(job.id); f.enqueue('b'); } },
        { name: 'b', batchSize: 1, handler: async (job) => { handled.push(job.id); } },
      ],
      { ...FAST, idleIntervalMs: 200 },
      silent,
    );
    await poller.start();
    await wait(80);
    expect(poller.isIdle()).toBe(true);

    f.enqueue('a');
    await wait(350); // "a" picks it up on its next idle poll (≤200ms); "b" must then be woken, not wait another 200ms
    expect(handled).toEqual(['a-1', 'b-2']);
  });

  it('times out a hung job and fails it', async () => {
    const f = fakeBoss();
    f.enqueue('a');
    poller = new QueuePoller(
      f.boss,
      [{ name: 'a', batchSize: 1, handler: () => new Promise(() => {}) }],
      FAST,
      silent,
    );
    // Shrink the job's own expiry so the test is fast.
    const fetch = f.boss.fetch.bind(f.boss) as unknown as (...args: unknown[]) => Promise<FakeJob[]>;
    (f.boss as unknown as { fetch: unknown }).fetch = async (...args: unknown[]) =>
      (await fetch(...args)).map((j) => ({ ...j, expireInSeconds: 0.05 }));
    await poller.start();
    await wait(120);
    expect(f.failed).toEqual(['a-1']);
  });
});
