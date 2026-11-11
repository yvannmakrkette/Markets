import { Types } from 'mongoose';
import { CfdOrder, CfdOrderT, CfdPosition, CfdT } from '../models/trade';
import { Account, AccountT } from '../models/account';
import { marketHub } from '../market/market-hub';
import type { StoredTick } from '../market/tick-store';
import { tickStore } from '../market/tick-store';
import { emitAccounts, postEntry, withTxn } from '../services/ledger.service';
import { AppError, badRequest, notFound } from '../lib/errors';
import { toUser } from '../realtime/io';
import { createLogger } from '../lib/logger';

const log = createLogger('cfd');
const STOP_OUT = 0.95; // close when loss reaches 95% of margin

export const bidAsk = (price: number, spread: number) => ({ bid: price - spread / 2, ask: price + spread / 2 });

/** Unrealised P/L in cents at the given mid price. Buy closes at bid, sell closes at ask. */
export function cfdPnl(p: Pick<CfdT, 'side' | 'openPrice' | 'lots' | 'contractSize' | 'spread'>, mid: number) {
  const { bid, ask } = bidAsk(mid, p.spread);
  const exit = p.side === 'buy' ? bid : ask;
  const diff = p.side === 'buy' ? exit - p.openPrice : p.openPrice - exit;
  return { exit, pnl: Math.round(diff * p.lots * p.contractSize * 100) };
}

export const publicCfd = (p: CfdT) => ({
  id: String(p._id),
  accountId: String(p.accountId),
  symbol: p.symbol,
  side: p.side,
  lots: p.lots,
  contractSize: p.contractSize,
  leverage: p.leverage,
  spread: p.spread,
  openPrice: p.openPrice,
  margin: p.margin,
  sl: p.sl ?? null,
  tp: p.tp ?? null,
  status: p.status,
  closePrice: p.closePrice ?? null,
  pnl: p.pnl,
  closeReason: p.closeReason ?? null,
  openedAt: p.openedAt,
  closedAt: p.closedAt ?? null,
});

export async function openCfd(userId: string, accountId: string, inp: { symbol: string; side: 'buy' | 'sell'; lots: number; sl?: number | null; tp?: number | null }) {
  const asset = marketHub.getAsset(inp.symbol);
  if (!asset?.enabled || !asset.cfd?.enabled) throw badRequest('CFD trading is not available for this asset', 'ASSET_UNAVAILABLE');
  if (!(inp.lots >= 0.01 && inp.lots <= 100)) throw badRequest('Volume must be between 0.01 and 100 lots');
  const acc = await Account.findOne({ _id: accountId, userId }).lean<AccountT>();
  if (!acc) throw notFound('Account not found');
  if (acc.type === 'tournament') throw badRequest('CFD positions are not available on tournament accounts');
  const tick = marketHub.latest(inp.symbol);
  if (!tick || !marketHub.isFresh(inp.symbol)) throw badRequest('Market is not quoting right now', 'MARKET_STALE');
  tickStore.persistReference(tick);

  const { spread = 0, leverage = 100, contractSize = 1 } = asset.cfd;
  const { bid, ask } = bidAsk(tick.price, spread);
  const openPrice = inp.side === 'buy' ? ask : bid;
  const margin = Math.ceil(((openPrice * inp.lots * contractSize) / leverage) * 100);
  if (inp.sl != null && (inp.side === 'buy' ? inp.sl >= openPrice : inp.sl <= openPrice)) throw badRequest('Stop loss is on the wrong side of the price');
  if (inp.tp != null && (inp.side === 'buy' ? inp.tp <= openPrice : inp.tp >= openPrice)) throw badRequest('Take profit is on the wrong side of the price');

  const id = new Types.ObjectId();
  const pos = await withTxn(async (session) => {
    try {
      await postEntry(session, { accountId: acc._id, type: 'cfd_margin', bucket: 'cash', amount: -margin, refKind: 'cfd', refId: id });
    } catch (e) {
      if (e instanceof AppError && e.code === 'INSUFFICIENT_FUNDS') throw new AppError(400, 'INSUFFICIENT_FUNDS', 'Not enough free margin');
      throw e;
    }
    const [p] = await CfdPosition.create(
      [{ _id: id, userId, accountId: acc._id, symbol: inp.symbol, side: inp.side, lots: inp.lots, contractSize, leverage, spread, openPrice, openTickId: tick.id, margin, sl: inp.sl ?? null, tp: inp.tp ?? null }],
      { session },
    );
    return p!.toObject() as CfdT;
  });
  openCache.set(String(pos._id), pos);
  toUser(userId, 'cfd:update', publicCfd(pos));
  void emitAccounts(userId);
  return pos;
}

export async function closeCfd(positionId: string, reason: CfdT['closeReason'], userId?: string) {
  const pos = await CfdPosition.findOne({ _id: positionId, status: 'open', ...(userId ? { userId } : {}) }).lean<CfdT>();
  if (!pos) throw notFound('Position not found or already closed');
  const tick = marketHub.latest(pos.symbol);
  if (!tick) throw badRequest('No price available', 'MARKET_STALE');
  tickStore.persistReference(tick);
  const { exit, pnl: raw } = cfdPnl(pos, tick.price);
  const pnl = Math.max(-pos.margin, raw); // loss can never exceed the posted margin
  const closed = await withTxn(async (session) => {
    const c = await CfdPosition.findOneAndUpdate(
      { _id: pos._id, status: 'open' },
      { $set: { status: 'closed', closePrice: exit, closeTickId: tick.id, pnl, closeReason: reason, closedAt: new Date() } },
      { new: true, session },
    ).lean<CfdT>();
    if (!c) return null;
    const credit = pos.margin + pnl;
    if (credit > 0) await postEntry(session, { accountId: pos.accountId, type: 'cfd_close', bucket: 'cash', amount: credit, refKind: 'cfd', refId: pos._id });
    return c;
  });
  openCache.delete(positionId);
  if (closed) {
    toUser(pos.userId, 'cfd:update', publicCfd(closed));
    void emitAccounts(pos.userId);
  }
  return closed;
}

export async function updateCfdLevels(userId: string, positionId: string, sl: number | null, tp: number | null) {
  const p = await CfdPosition.findOneAndUpdate({ _id: positionId, userId, status: 'open' }, { $set: { sl, tp } }, { new: true }).lean<CfdT>();
  if (!p) throw notFound('Position not found');
  openCache.set(positionId, p);
  toUser(userId, 'cfd:update', publicCfd(p));
  return p;
}

// ---------------- By-price (limit) orders ----------------
export const publicCfdOrder = (o: CfdOrderT) => ({
  id: String(o._id),
  accountId: String(o.accountId),
  symbol: o.symbol,
  side: o.side,
  lots: o.lots,
  limitPrice: o.limitPrice,
  sl: o.sl ?? null,
  tp: o.tp ?? null,
  status: o.status,
  failReason: o.failReason ?? null,
  createdAt: (o as unknown as { createdAt: Date }).createdAt,
});

const orderCache = new Map<string, CfdOrderT>();

export async function placeCfdOrder(userId: string, accountId: string, inp: { symbol: string; side: 'buy' | 'sell'; lots: number; limitPrice: number; sl?: number | null; tp?: number | null }) {
  const asset = marketHub.getAsset(inp.symbol);
  if (!asset?.enabled || !asset.cfd?.enabled) throw badRequest('CFD trading is not available for this asset', 'ASSET_UNAVAILABLE');
  if (!(inp.lots >= 0.01 && inp.lots <= 100)) throw badRequest('Volume must be between 0.01 and 100 lots');
  if (!(inp.limitPrice > 0)) throw badRequest('Enter a valid price');
  const acc = await Account.findOne({ _id: accountId, userId }).lean<AccountT>();
  if (!acc || acc.type === 'tournament') throw notFound('Account not found');
  if ((await CfdOrder.countDocuments({ userId, status: 'waiting' })) >= 20) throw badRequest('You can have at most 20 open orders');
  const o = (await CfdOrder.create({ userId, accountId: acc._id, ...inp, sl: inp.sl ?? null, tp: inp.tp ?? null })).toObject() as CfdOrderT;
  orderCache.set(String(o._id), o);
  toUser(userId, 'cfd:order', publicCfdOrder(o));
  return o;
}

export async function cancelCfdOrder(userId: string, id: string) {
  const o = await CfdOrder.findOneAndUpdate({ _id: id, userId, status: 'waiting' }, { $set: { status: 'cancelled' } }, { new: true }).lean<CfdOrderT>();
  if (!o) throw notFound('Order not found');
  orderCache.delete(id);
  toUser(userId, 'cfd:order', publicCfdOrder(o));
  return o;
}

async function fillOrder(o: CfdOrderT) {
  const id = String(o._id);
  orderCache.delete(id);
  const claimed = await CfdOrder.findOneAndUpdate({ _id: o._id, status: 'waiting' }, { $set: { status: 'filled' } }, { new: true }).lean<CfdOrderT>();
  if (!claimed) return;
  try {
    const pos = await openCfd(String(o.userId), String(o.accountId), { symbol: o.symbol, side: o.side as 'buy' | 'sell', lots: o.lots, sl: o.sl, tp: o.tp });
    await CfdOrder.updateOne({ _id: o._id }, { $set: { positionId: pos._id } });
    toUser(o.userId, 'toast', { kind: 'success', text: `Limit order filled: ${o.side.toUpperCase()} ${o.lots} ${o.symbol}` });
  } catch (e) {
    await CfdOrder.updateOne({ _id: o._id }, { $set: { status: 'failed', failReason: (e as Error).message } });
    toUser(o.userId, 'toast', { kind: 'error', text: `Limit order failed: ${(e as Error).message}` });
  }
  const fresh = await CfdOrder.findById(o._id).lean<CfdOrderT>();
  if (fresh) toUser(o.userId, 'cfd:order', publicCfdOrder(fresh));
}

/** In-memory index of open positions for SL / TP / stop-out checks on every tick. */
const openCache = new Map<string, CfdT>();
const closing = new Set<string>();

export function startCfdWorker() {
  const reload = async () => {
    const all = await CfdPosition.find({ status: 'open' }).lean<CfdT[]>();
    openCache.clear();
    for (const p of all) openCache.set(String(p._id), p);
    const orders = await CfdOrder.find({ status: 'waiting' }).lean<CfdOrderT[]>();
    orderCache.clear();
    for (const o of orders) orderCache.set(String(o._id), o);
  };
  void reload();
  setInterval(() => void reload().catch((e) => log.error('reload failed', e)), 10_000);
  marketHub.on('tick', (t: StoredTick) => {
    for (const o of orderCache.values()) {
      if (o.symbol !== t.symbol) continue;
      const { bid, ask } = bidAsk(t.price, marketHub.getAsset(o.symbol)?.cfd?.spread ?? 0);
      if (o.side === 'buy' ? ask <= o.limitPrice : bid >= o.limitPrice) void fillOrder(o);
    }
    for (const [id, p] of openCache) {
      if (p.symbol !== t.symbol || closing.has(id)) continue;
      const { bid, ask } = bidAsk(t.price, p.spread);
      const exit = p.side === 'buy' ? bid : ask;
      let reason: CfdT['closeReason'] | null = null;
      if (p.sl != null && (p.side === 'buy' ? exit <= p.sl : exit >= p.sl)) reason = 'sl';
      else if (p.tp != null && (p.side === 'buy' ? exit >= p.tp : exit <= p.tp)) reason = 'tp';
      else if (cfdPnl(p, t.price).pnl <= -p.margin * STOP_OUT) reason = 'stopout';
      if (!reason) continue;
      closing.add(id);
      closeCfd(id, reason)
        .catch((e) => log.warn(`auto-close ${id} failed: ${(e as Error).message}`))
        .finally(() => closing.delete(id));
    }
  });
}
