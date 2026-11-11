import { EventEmitter } from 'node:events';
import { Asset, AssetT, Tick } from '../models/market';
import { env } from '../config/env';
import { createLogger } from '../lib/logger';
import { toRoom, toSymbol } from '../realtime/io';
import { OtcGenerator } from './otc-generator';
import { BinanceFeed, fetchKlines } from './binance-feed';
import { StoredTick, tickStore } from './tick-store';
import { aggregateCandles, bucketTicks, Candle, mergeCandles } from './candles';

const log = createLogger('market');
const STALE_MS = 5000;
const KLINE_INTERVALS: Record<number, string> = { 1: '1s', 60: '1m', 180: '3m', 300: '5m', 900: '15m', 3600: '1h' };

export interface SummaryRow {
  symbol: string;
  price: number;
  changePct: number;
  fresh: boolean;
}

/**
 * Orchestrates price sources -> tick store -> socket rooms.
 * Emits 'tick' (StoredTick) for in-process consumers (settlement, pending orders, CFD, signals).
 */
class MarketHub extends EventEmitter {
  readonly otc = new OtcGenerator(env.OTC_SEED, 1000);
  private binance: BinanceFeed | null = null;
  private assets = new Map<string, AssetT>();
  private dayOpen = new Map<string, { day: number; price: number }>();
  private summaryTimer: NodeJS.Timeout | null = null;
  private klineCache = new Map<string, { at: number; data: Candle[] }>();

  async start() {
    const assets = await Asset.find().lean<AssetT[]>();
    for (const a of assets) this.assets.set(a.symbol, a);

    await Promise.all(assets.map((a) => this.warmUp(a)));

    this.otc.on('tick', (t: { symbol: string; price: number; ts: number }) => this.ingest(t.symbol, t.price, t.ts, 0));
    this.otc.start();

    const real = assets.filter((a) => a.source === 'binance' && a.enabled && a.binanceSymbol);
    if (env.BINANCE_ENABLED && real.length) {
      this.binance = new BinanceFeed(
        env.BINANCE_WS_URL,
        real.map((a) => ({ symbol: a.symbol, binanceSymbol: a.binanceSymbol! })),
        env.BINANCE_REST_URL,
      );
      this.binance.on('tick', (t: { symbol: string; price: number; ts: number; vol: number }) => this.ingest(t.symbol, t.price, t.ts, t.vol));
      this.binance.start();
    }

    tickStore.startFlusher();
    this.summaryTimer = setInterval(() => toRoom('summary', 'market:summary', this.summary()), 2000);
    log.info(`started: ${this.otc.symbols().length} OTC, ${real.length} live`);
  }

  async stop() {
    this.otc.stop();
    this.binance?.stop();
    if (this.summaryTimer) clearInterval(this.summaryTimer);
    await tickStore.stop();
  }

  /** Load recent history into memory; for new OTC instruments, backfill one hour so charts aren't empty. */
  private async warmUp(a: AssetT) {
    const now = Date.now();
    const recent = await tickStore.rangeDb(a.symbol, now - 20 * 60_000, now, 6000);
    if (recent.length) tickStore.preload(a.symbol, recent);

    const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
    const first = await Tick.findOne({ symbol: a.symbol, ts: { $gte: new Date(dayStart) } }).sort({ ts: 1 }).lean();
    if (first) this.dayOpen.set(a.symbol, { day: dayStart, price: first.price });

    if (a.source === 'otc' && a.otc?.basePrice) {
      const last = recent[recent.length - 1] ?? (await tickStore.atOrBefore(a.symbol, now));
      this.otc.upsert(
        { symbol: a.symbol, basePrice: a.otc.basePrice, volatility: a.otc.volatility ?? 0.0001, meanReversion: a.otc.meanReversion ?? 0.0004, precision: a.precision },
        last?.price,
      );
      if (!last) {
        const hist = this.otc.backfill(a.symbol, now - 60 * 60_000, now - 1000, 1000);
        const stored = hist.map((h) => tickStore.add(h.symbol, h.price, h.ts));
        if (stored[0]) this.dayOpen.set(a.symbol, { day: dayStart, price: stored[0].price });
        log.info(`backfilled ${stored.length} ticks for ${a.symbol}`);
      }
      if (!a.enabled) this.otc.remove(a.symbol);
    }
  }

  private ingest(symbol: string, price: number, ts: number, vol: number) {
    const t = tickStore.add(symbol, price, ts, vol);
    const day = Math.floor(t.ts / 86_400_000) * 86_400_000;
    const d = this.dayOpen.get(symbol);
    if (!d || d.day !== day) this.dayOpen.set(symbol, { day, price });
    toSymbol(symbol, 'tick', { s: symbol, p: price, t: t.ts });
    this.emit('tick', t);
  }

  getAsset(symbol: string) {
    return this.assets.get(symbol);
  }

  listAssets() {
    return [...this.assets.values()].sort((a, b) => a.sort - b.sort);
  }

  /** Called after an admin edits an asset. */
  async reloadAsset(symbol: string) {
    const a = await Asset.findOne({ symbol }).lean<AssetT>();
    if (!a) return;
    this.assets.set(symbol, a);
    if (a.source === 'otc' && a.otc?.basePrice) {
      if (a.enabled) {
        this.otc.upsert(
          { symbol, basePrice: a.otc.basePrice, volatility: a.otc.volatility ?? 0.0001, meanReversion: a.otc.meanReversion ?? 0.0004, precision: a.precision },
          tickStore.latest(symbol)?.price,
        );
      } else this.otc.remove(symbol);
    }
    if (a.source === 'binance' && this.binance) {
      const real = this.listAssets().filter((x) => x.source === 'binance' && x.enabled && x.binanceSymbol);
      this.binance.setSymbols(real.map((x) => ({ symbol: x.symbol, binanceSymbol: x.binanceSymbol! })));
    }
  }

  latest(symbol: string): StoredTick | undefined {
    return tickStore.latest(symbol);
  }

  isFresh(symbol: string) {
    const t = tickStore.latest(symbol);
    return !!t && Date.now() - t.ts < STALE_MS;
  }

  summary(): SummaryRow[] {
    return this.listAssets()
      .filter((a) => a.enabled)
      .map((a) => {
        const t = tickStore.latest(a.symbol);
        const open = this.dayOpen.get(a.symbol)?.price ?? t?.price ?? 0;
        return {
          symbol: a.symbol,
          price: t?.price ?? 0,
          changePct: t && open ? ((t.price - open) / open) * 100 : 0,
          fresh: this.isFresh(a.symbol),
        };
      });
  }

  /** OHLC candles for charts: memory -> DB aggregation -> Binance klines (real symbols only). */
  async candles(symbol: string, tf: number, limit: number): Promise<Candle[]> {
    const a = this.assets.get(symbol);
    if (!a) return [];
    const now = Date.now();
    const from = now - tf * 1000 * limit;
    const memStart = tickStore.memoryStart(symbol) ?? now;
    const mem = bucketTicks(tickStore.range(symbol, Math.max(from, memStart), now), tf);
    let older: Candle[] = [];
    if (from < memStart) older = await aggregateCandles(symbol, tf, from, memStart - 1);
    let merged = mergeCandles(older, mem);

    if (a.source === 'binance' && a.binanceSymbol && merged.length < limit * 0.8 && KLINE_INTERVALS[tf]) {
      const key = `${symbol}:${tf}:${limit}`;
      const cached = this.klineCache.get(key);
      let k: Candle[] = [];
      if (cached && now - cached.at < 30_000) k = cached.data;
      else {
        try {
          k = await fetchKlines(env.BINANCE_REST_URL, a.binanceSymbol, KLINE_INTERVALS[tf]!, Math.min(1000, limit));
          this.klineCache.set(key, { at: now, data: k });
        } catch (e) {
          log.warn(`kline backfill failed for ${symbol}: ${(e as Error).message}`);
        }
      }
      merged = mergeCandles(k, merged);
    }

    if (merged.length === 0 && a.source === 'otc' && a.otc?.basePrice) {
      if (!this.otc.symbols().includes(symbol)) {
        this.otc.upsert({ symbol, basePrice: a.otc.basePrice, volatility: a.otc.volatility ?? 0.0001, meanReversion: a.otc.meanReversion ?? 0.0004, precision: a.precision });
      }
      const hist = this.otc.backfill(symbol, from, now, Math.min(tf * 1000, 5000));
      merged = bucketTicks(hist.map((h) => ({ ...h, vol: 0 })), tf);
    }

    return merged.slice(-limit);
  }
}

export const marketHub = new MarketHub();
