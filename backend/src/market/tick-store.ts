import { Types } from 'mongoose';
import { Tick } from '../models/market';
import { createLogger } from '../lib/logger';
import { env } from '../config/env';

const log = createLogger('ticks');

export interface StoredTick {
  id: Types.ObjectId;
  symbol: string;
  price: number;
  ts: number; // ms epoch, strictly increasing per symbol
  vol: number;
  persisted?: boolean;
  queued?: boolean;
  required?: boolean;
}

const MEMORY_MS = 20 * 60_000;
const MAX_PENDING_TICKS = 10_000;

/**
 * In-memory ring buffer of recent ticks per symbol + batched persistence to the time-series collection.
 * Tick ids are assigned here, before the DB write, so trades can reference the exact tick they used.
 */
export class TickStore {
  private buffers = new Map<string, StoredTick[]>();
  private queue: StoredTick[] = [];
  private lastPersistedAt = new Map<string, number>();
  private flushing = false;
  private timer: NodeJS.Timeout | null = null;
  private lastQueueWarningAt = 0;

  add(symbol: string, price: number, ts: number, vol = 0, persist = true): StoredTick {
    let buf = this.buffers.get(symbol);
    if (!buf) this.buffers.set(symbol, (buf = []));
    const last = buf[buf.length - 1];
    if (last && ts <= last.ts) ts = last.ts + 1;
    const t: StoredTick = { id: new Types.ObjectId(), symbol, price, ts, vol };
    buf.push(t);
    // trim old ticks (amortised: only when clearly over)
    if (buf.length > 64 && buf[0]!.ts < ts - MEMORY_MS - 60_000) {
      const cut = lowerBound(buf, ts - MEMORY_MS);
      buf.splice(0, cut);
    }
    const lastPersisted = this.lastPersistedAt.get(symbol);
    if (persist && (lastPersisted === undefined || ts - lastPersisted >= env.TICK_PERSIST_INTERVAL_MS)) {
      this.lastPersistedAt.set(symbol, ts);
      this.enqueue(t, false);
    }
    return t;
  }

  /** Ensure a tick referenced by a financial record is persisted even between sampled history points. */
  persistReference(tick: StoredTick) {
    if (tick.persisted) return;
    if (tick.queued) {
      tick.required = true;
      return;
    }
    this.enqueue(tick, true);
  }

  private enqueue(tick: StoredTick, required: boolean) {
    if (tick.persisted) return;
    if (tick.queued) {
      if (required) tick.required = true;
      return;
    }
    if (required && this.queue.length >= MAX_PENDING_TICKS) {
      const discardAt = this.queue.findIndex((queued) => !queued.required);
      if (discardAt >= 0) {
        const [discarded] = this.queue.splice(discardAt, 1);
        if (discarded) discarded.queued = false;
      }
    }
    if (!required && this.queue.length >= MAX_PENDING_TICKS) {
      const now = Date.now();
      if (now - this.lastQueueWarningAt >= 30_000) {
        this.lastQueueWarningAt = now;
        log.warn(`tick write queue reached ${MAX_PENDING_TICKS}; dropping sampled history ticks until MongoDB recovers`);
      }
      return;
    }
    tick.queued = true;
    tick.required = required;
    this.queue.push(tick);
  }

  /** Loads already-persisted ticks into memory (startup warm-up). */
  preload(symbol: string, ticks: StoredTick[]) {
    const buf = this.buffers.get(symbol) ?? [];
    this.buffers.set(symbol, [...ticks.map((tick) => ({ ...tick, persisted: true })), ...buf].sort((a, b) => a.ts - b.ts));
  }

  latest(symbol: string): StoredTick | undefined {
    const b = this.buffers.get(symbol);
    return b?.[b.length - 1];
  }

  memoryStart(symbol: string): number | undefined {
    return this.buffers.get(symbol)?.[0]?.ts;
  }

  /** Last tick with ts <= at, from memory if covered, otherwise from the database. */
  async atOrBefore(symbol: string, at: number): Promise<StoredTick | undefined> {
    const b = this.buffers.get(symbol);
    if (b?.length && b[0]!.ts <= at) {
      const i = upperBound(b, at) - 1;
      if (i >= 0) return b[i];
    }
    const doc = await Tick.findOne({ symbol, ts: { $lte: new Date(at) } })
      .sort({ ts: -1 })
      .lean();
    return doc ? { id: doc._id, symbol, price: doc.price, ts: doc.ts.getTime(), vol: doc.vol ?? 0, persisted: true } : undefined;
  }

  range(symbol: string, from: number, to: number): StoredTick[] {
    const b = this.buffers.get(symbol);
    if (!b?.length) return [];
    return b.slice(lowerBound(b, from), upperBound(b, to));
  }

  async rangeDb(symbol: string, from: number, to: number, limit = 20_000): Promise<StoredTick[]> {
    const docs = await Tick.find({ symbol, ts: { $gte: new Date(from), $lte: new Date(to) } })
      .sort({ ts: 1 })
      .limit(limit)
      .lean();
    return docs.map((d) => ({ id: d._id, symbol, price: d.price, ts: d.ts.getTime(), vol: d.vol ?? 0, persisted: true }));
  }

  /** Memory first; falls back to DB for anything older than the buffer. */
  async rangeAny(symbol: string, from: number, to: number): Promise<StoredTick[]> {
    const start = this.memoryStart(symbol);
    if (start !== undefined && start <= from) return this.range(symbol, from, to);
    const older = await this.rangeDb(symbol, from, Math.min(to, (start ?? to + 1) - 1));
    return start !== undefined ? [...older, ...this.range(symbol, start, to)] : older;
  }

  startFlusher(intervalMs = 1000) {
    this.timer = setInterval(() => void this.flush(), intervalMs);
  }

  async flush(): Promise<boolean> {
    if (this.flushing || !this.queue.length) return true;
    this.flushing = true;
    const batch = this.queue.splice(0, 5000);
    try {
      await Tick.insertMany(
        batch.map((t) => ({ _id: t.id, ts: new Date(t.ts), symbol: t.symbol, price: t.price, vol: t.vol })),
        { ordered: false, lean: true },
      );
      for (const tick of batch) {
        tick.queued = false;
        tick.persisted = true;
        tick.required = false;
      }
      return true;
    } catch (e) {
      log.error(`failed to persist ${batch.length} ticks, re-queueing`, (e as Error).message);
      this.queue.unshift(...batch);
      return false;
    } finally {
      this.flushing = false;
    }
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    for (let attempts = 0; this.queue.length && attempts < 3; attempts++) {
      if (!(await this.flush())) break;
    }
    if (this.queue.length) log.warn(`leaving ${this.queue.length} queued ticks after MongoDB write failures during shutdown`);
  }
}

function lowerBound(a: StoredTick[], ts: number) {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m]!.ts < ts) lo = m + 1;
    else hi = m;
  }
  return lo;
}
function upperBound(a: StoredTick[], ts: number) {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m]!.ts <= ts) lo = m + 1;
    else hi = m;
  }
  return lo;
}

export const tickStore = new TickStore();
