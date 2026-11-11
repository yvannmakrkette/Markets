import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { isAddress } from 'ethers';
import { ah, param, parse } from '../lib/http';
import { badRequest, conflict, notFound } from '../lib/errors';
import { requireAdmin, uid } from '../middleware/auth';
import { User } from '../models/user';
import { env } from '../config/env';
import { UserDepositInstructions, WalletAsset, WalletAuditLog, WalletBalance, WalletConversion, WalletDeposit, WalletLedgerEntry, WalletNetwork, WalletPriceRate, WalletQuote, WalletWithdrawal } from '../models/wallet';
import { inWalletTxn, assignUnmatchedWalletDeposit, listUnmatchedWalletDeposits, rejectUnmatchedWalletDeposit } from '../wallet/deposit.service';
import { completeWalletWithdrawal, listWalletAdminWithdrawals, reviewWalletWithdrawal, setWalletWithdrawalBroadcast } from '../wallet/withdrawal.service';
import { fromAtomic, toAtomic } from '../wallet/money';

export const adminWalletRouter = Router();
adminWalletRouter.use(requireAdmin);

const id = z.string().regex(/^[a-f\d]{24}$/i);
const pageQuery = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(50) });
const amountText = z.string().trim().regex(/^\d+(?:\.\d+)?$/).max(80);
const routeId = (req: import('express').Request, name = 'id') => parse(id, param(req, name));
const auditAdmin = (req: import('express').Request, action: string, entityType: string, entityId: mongoose.Types.ObjectId, before?: unknown, after?: unknown) =>
  WalletAuditLog.create({ actorId: new mongoose.Types.ObjectId(uid(req)), role: 'admin', action, entityType, entityId, before, after, ip: req.ip });

adminWalletRouter.get('/assets', ah(async (_req, res) => res.json(await WalletAsset.find({}).sort({ symbol: 1 }).lean())));
adminWalletRouter.post('/assets', ah(async (req, res) => {
  const b = parse(z.object({ symbol: z.string().trim().regex(/^[A-Za-z0-9]{2,12}$/), name: z.string().trim().min(1).max(60), decimals: z.number().int().min(0).max(30), iconUrl: z.string().url().optional().or(z.literal('')), priceFeedId: z.string().trim().max(80).optional(), enabled: z.boolean().default(false) }), req.body);
  const asset = await WalletAsset.create({ ...b, symbol: b.symbol.toUpperCase() });
  await auditAdmin(req, 'asset.created', 'wallet_asset', asset._id, null, { symbol: asset.symbol, enabled: asset.enabled });
  res.status(201).json(asset.toObject());
}));
adminWalletRouter.patch('/assets/:symbol', ah(async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(1).max(60).optional(), iconUrl: z.string().url().optional().or(z.literal('')), priceFeedId: z.string().trim().max(80).optional(), enabled: z.boolean().optional() }), req.body);
  const before = await WalletAsset.findOne({ symbol: String(req.params['symbol']).toUpperCase() }).lean();
  const asset = await WalletAsset.findOneAndUpdate({ symbol: String(req.params['symbol']).toUpperCase() }, { $set: b }, { new: true, runValidators: true }).lean();
  if (!asset) throw notFound('Wallet asset not found');
  await auditAdmin(req, 'asset.updated', 'wallet_asset', asset._id, before, asset);
  res.json(asset);
}));
adminWalletRouter.delete('/assets/:symbol', ah(async (req, res) => {
  const symbol = String(req.params['symbol']).toUpperCase();
  if (await WalletNetwork.exists({ assetSymbol: symbol }) || await WalletBalance.exists({ assetSymbol: symbol }) || await WalletConversion.exists({ $or: [{ fromAsset: symbol }, { toAsset: symbol }] }) || await WalletQuote.exists({ $or: [{ fromAsset: symbol }, { toAsset: symbol }] }) || await WalletLedgerEntry.exists({ assetSymbol: symbol })) throw conflict('Asset has networks or wallet records and cannot be deleted; disable it instead');
  const asset = await WalletAsset.findOneAndDelete({ symbol });
  if (asset) await auditAdmin(req, 'asset.deleted', 'wallet_asset', asset._id, asset.toObject(), null);
  res.json({ ok: true });
}));

const networkShape = z.object({
  assetSymbol: z.string().trim().regex(/^[A-Za-z0-9]{2,12}$/), networkCode: z.string().trim().regex(/^[A-Za-z0-9_-]{2,20}$/),
  chainType: z.enum(['eosio', 'evm', 'tron', 'btc', 'xrp', 'stellar', 'ton']), contractOrToken: z.string().trim().min(1).max(160),
  depositModel: z.enum(['memo', 'address']), depositAccountOrXpub: z.string().trim().max(300).optional(), memoRequired: z.boolean().default(false),
  minDeposit: amountText, minWithdraw: amountText, withdrawFee: amountText, confirmationsRequired: z.number().int().min(0).max(10_000),
  explorerTxUrlTemplate: z.string().url().refine((url) => url.includes('{txHash}')), rpcConfigKey: z.string().trim().max(80).optional(),
  depositStartBlock: z.number().int().nonnegative().optional(), enabled: z.boolean().default(false),
});
adminWalletRouter.get('/networks', ah(async (_req, res) => res.json(await WalletNetwork.find({}).sort({ assetSymbol: 1, networkCode: 1 }).lean())));
adminWalletRouter.post('/networks', ah(async (req, res) => {
  const b = parse(networkShape, req.body);
  const asset = await WalletAsset.findOne({ symbol: b.assetSymbol.toUpperCase() }).lean();
  if (!asset) throw notFound('Create the wallet asset before its network');
  if (b.enabled && !['eosio', 'evm'].includes(b.chainType)) throw badRequest('This chain adapter is not implemented yet; keep this network disabled');
  if ((b.chainType === 'eosio' && b.depositModel !== 'memo') || (b.chainType === 'evm' && b.depositModel !== 'address')) throw badRequest('Deposit model does not match the selected chain adapter');
  if (b.enabled && b.chainType === 'evm' && !env.EVM_RPC_URL) throw badRequest('Set EVM_RPC_URL before enabling an EVM network');
  for (const key of ['minDeposit', 'minWithdraw', 'withdrawFee'] as const) toAtomic(b[key], asset.decimals);
  if (b.chainType === 'evm') {
    if (!isAddress(b.contractOrToken)) throw badRequest('EVM token contract must be a valid address');
    if (!b.depositAccountOrXpub || !/^(xpub|tpub)/.test(b.depositAccountOrXpub)) throw badRequest('EVM deposits require a public xpub/tpub');
  }
  const network = await WalletNetwork.create({ ...b, assetSymbol: b.assetSymbol.toUpperCase(), networkCode: b.networkCode.toUpperCase() });
  await auditAdmin(req, 'network.created', 'wallet_network', network._id, null, { assetSymbol: network.assetSymbol, networkCode: network.networkCode, enabled: network.enabled });
  res.status(201).json(network.toObject());
}));
adminWalletRouter.patch('/networks/:id', ah(async (req, res) => {
  const b = parse(networkShape.partial(), req.body);
  const networkId = routeId(req);
  const before = await WalletNetwork.findById(networkId).lean();
  if (!before) throw notFound('Wallet network not found');
  const identityFields = ['assetSymbol', 'networkCode', 'chainType', 'contractOrToken', 'depositModel', 'depositAccountOrXpub', 'memoRequired'] as const;
  if (identityFields.some((key) => b[key] !== undefined) && (await WalletDeposit.exists({ networkId: before._id }) || await UserDepositInstructions.exists({ networkId: before._id }) || await WalletWithdrawal.exists({ networkId: before._id }))) {
    throw conflict('Network identity cannot change after deposit instructions or transaction records exist');
  }
  const asset = await WalletAsset.findOne({ symbol: (b.assetSymbol ?? before.assetSymbol).toUpperCase() }).lean();
  if (!asset) throw notFound('Wallet asset not found');
  const chainType = b.chainType ?? before.chainType;
  const depositModel = b.depositModel ?? before.depositModel;
  if ((b.enabled ?? before.enabled) && !['eosio', 'evm'].includes(chainType)) throw badRequest('This chain adapter is not implemented yet; keep this network disabled');
  if ((chainType === 'eosio' && depositModel !== 'memo') || (chainType === 'evm' && depositModel !== 'address')) throw badRequest('Deposit model does not match the selected chain adapter');
  if ((b.enabled ?? before.enabled) && chainType === 'evm' && !env.EVM_RPC_URL) throw badRequest('Set EVM_RPC_URL before enabling an EVM network');
  for (const key of ['minDeposit', 'minWithdraw', 'withdrawFee'] as const) if (b[key]) toAtomic(b[key], asset.decimals);
  if (chainType === 'evm') {
    const contract = b.contractOrToken ?? before.contractOrToken;
    const xpub = b.depositAccountOrXpub ?? before.depositAccountOrXpub ?? '';
    if (!isAddress(contract)) throw badRequest('EVM token contract must be a valid address');
    if (!/^(xpub|tpub)/.test(xpub)) throw badRequest('EVM deposits require a public xpub/tpub');
  }
  const network = await WalletNetwork.findByIdAndUpdate(networkId, { $set: { ...b, ...(b.assetSymbol ? { assetSymbol: b.assetSymbol.toUpperCase() } : {}), ...(b.networkCode ? { networkCode: b.networkCode.toUpperCase() } : {}) } }, { new: true, runValidators: true }).lean();
  if (!network) throw notFound('Wallet network not found');
  await auditAdmin(req, 'network.updated', 'wallet_network', network._id, before, network);
  res.json(network);
}));
adminWalletRouter.delete('/networks/:id', ah(async (req, res) => {
  const networkId = routeId(req);
  if (await WalletDeposit.exists({ networkId }) || await WalletWithdrawal.exists({ networkId }) || await UserDepositInstructions.exists({ networkId })) throw conflict('Network has deposit instructions or transaction records and cannot be deleted; disable it instead');
  const network = await WalletNetwork.findByIdAndDelete(networkId);
  if (network) await auditAdmin(req, 'network.deleted', 'wallet_network', network._id, network.toObject(), null);
  res.json({ ok: true });
}));

adminWalletRouter.get('/rates', ah(async (_req, res) => res.json(await WalletPriceRate.find({}).sort({ assetSymbol: 1 }).lean())));
adminWalletRouter.put('/rates/:symbol', ah(async (req, res) => {
  const b = parse(z.object({ usdPrice: amountText }), req.body);
  if (toAtomic(b.usdPrice, 18) <= 0n) throw badRequest('USD price must be greater than zero');
  const symbol = String(req.params['symbol']).toUpperCase();
  if (!await WalletAsset.exists({ symbol })) throw notFound('Wallet asset not found');
  const rate = await WalletPriceRate.findOneAndUpdate({ assetSymbol: symbol }, { $set: { usdPrice: mongoose.Types.Decimal128.fromString(b.usdPrice), updatedBy: new mongoose.Types.ObjectId(uid(req)) } }, { new: true, upsert: true, runValidators: true }).lean();
  await WalletAuditLog.create({ actorId: new mongoose.Types.ObjectId(uid(req)), role: 'admin', action: 'price_rate.updated', entityType: 'price_rate', entityId: rate!._id, after: { assetSymbol: symbol, usdPrice: b.usdPrice }, ip: req.ip });
  res.json(rate);
}));
adminWalletRouter.delete('/rates/:symbol', ah(async (req, res) => {
  const symbol = String(req.params['symbol']).toUpperCase();
  const rate = await WalletPriceRate.findOneAndDelete({ assetSymbol: symbol });
  if (rate) await WalletAuditLog.create({ actorId: new mongoose.Types.ObjectId(uid(req)), role: 'admin', action: 'price_rate.deleted', entityType: 'price_rate', entityId: rate._id, before: { assetSymbol: symbol, usdPrice: rate.usdPrice.toString() }, ip: req.ip });
  res.json({ ok: true });
}));

adminWalletRouter.get('/deposits/unmatched', ah(async (req, res) => res.json(await listUnmatchedWalletDeposits(parse(pageQuery, req.query)))));
adminWalletRouter.post('/deposits/:id/assign', ah(async (req, res) => {
  const b = parse(z.object({ userId: id }), req.body);
  res.json(await assignUnmatchedWalletDeposit(uid(req), routeId(req), b.userId, req.ip));
}));
adminWalletRouter.post('/deposits/:id/reject', ah(async (req, res) => {
  const b = parse(z.object({ note: z.string().trim().min(3).max(300) }), req.body);
  res.json(await rejectUnmatchedWalletDeposit(uid(req), routeId(req), b.note, req.ip));
}));

adminWalletRouter.get('/withdrawals', ah(async (req, res) => res.json(await listWalletAdminWithdrawals(req.query['status'] ? String(req.query['status']) : undefined))));
adminWalletRouter.post('/withdrawals/:id/approve', ah(async (req, res) => res.json(await reviewWalletWithdrawal(uid(req), routeId(req), 'approve', { ip: req.ip }))));
adminWalletRouter.post('/withdrawals/:id/reject', ah(async (req, res) => {
  const b = parse(z.object({ note: z.string().trim().min(3).max(300) }), req.body);
  res.json(await reviewWalletWithdrawal(uid(req), routeId(req), 'reject', { note: b.note, ip: req.ip }));
}));
adminWalletRouter.post('/withdrawals/:id/broadcast', ah(async (req, res) => {
  const b = parse(z.object({ txHash: z.string().trim().min(8).max(160) }), req.body);
  res.json(await setWalletWithdrawalBroadcast(uid(req), routeId(req), b.txHash, req.ip));
}));
adminWalletRouter.post('/withdrawals/:id/complete', ah(async (req, res) => {
  const b = parse(z.object({ txHash: z.string().trim().min(8).max(160) }), req.body);
  res.json(await completeWalletWithdrawal(uid(req), routeId(req), b.txHash, req.ip));
}));

adminWalletRouter.get('/audit', ah(async (req, res) => {
  const { page, limit } = parse(pageQuery, req.query);
  const [rows, total] = await Promise.all([WalletAuditLog.find({}).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), WalletAuditLog.countDocuments()]);
  const admins = await User.find({ _id: { $in: rows.map((row) => row.actorId) } }, { username: 1, email: 1 }).lean();
  const adminMap = new Map(admins.map((user) => [String(user._id), user]));
  res.json({ page, limit, total, items: rows.map((row) => ({ id: String(row._id), actorId: String(row.actorId), actor: adminMap.get(String(row.actorId))?.username ?? 'User', role: row.role, action: row.action, entityType: row.entityType, entityId: String(row.entityId), before: row.before ?? null, after: row.after ?? null, ip: row.ip ?? null, createdAt: row.createdAt })) });
}));

adminWalletRouter.post('/balances/adjust', ah(async (req, res) => {
  const b = parse(z.object({ userId: id, assetSymbol: z.string().trim().regex(/^[A-Za-z0-9]{2,12}$/), amount: z.string().trim().regex(/^-?\d+(?:\.\d+)?$/).max(80), note: z.string().trim().min(3).max(300) }), req.body);
  const userId = new mongoose.Types.ObjectId(b.userId);
  const symbol = b.assetSymbol.toUpperCase();
  const [user, asset] = await Promise.all([User.findById(userId).lean(), WalletAsset.findOne({ symbol }).lean()]);
  if (!user || !asset) throw notFound('User or wallet asset not found');
  const negative = b.amount.startsWith('-');
  const absText = negative ? b.amount.slice(1) : b.amount;
  const units = toAtomic(absText, asset.decimals) * (negative ? -1n : 1n);
  if (units === 0n) throw badRequest('Adjustment amount cannot be zero');
  const amount = fromAtomic(units < 0n ? -units : units, asset.decimals);
  const signed = units < 0n ? `-${amount}` : amount;
  const refId = new mongoose.Types.ObjectId();
  const result = await inWalletTxn(async (session) => {
    if (!negative) await WalletBalance.updateOne({ userId, assetSymbol: symbol }, { $setOnInsert: { userId, assetSymbol: symbol, available: mongoose.Types.Decimal128.fromString('0'), locked: mongoose.Types.Decimal128.fromString('0') } }, { upsert: true, session });
    const balance = await WalletBalance.findOneAndUpdate({ userId, assetSymbol: symbol, ...(negative ? { available: { $gte: mongoose.Types.Decimal128.fromString(amount) } } : {}) }, { $inc: { available: mongoose.Types.Decimal128.fromString(signed) } }, { new: true, session });
    if (!balance) throw badRequest('Adjustment would make available balance negative');
    await WalletLedgerEntry.create([{ userId, assetSymbol: symbol, amount: mongoose.Types.Decimal128.fromString(signed), type: 'adjustment', refType: 'admin_adjustment', refId, balanceAfter: balance.available }], { session });
    await WalletAuditLog.create([{ actorId: new mongoose.Types.ObjectId(uid(req)), role: 'admin', action: 'balance.adjusted', entityType: 'balance', entityId: refId, before: { userId, assetSymbol: symbol }, after: { amount: signed, note: b.note, available: balance.available.toString() }, ip: req.ip }], { session });
    return { userId: b.userId, assetSymbol: symbol, amount: signed, available: balance.available.toString() };
  });
  res.json(result);
}));
