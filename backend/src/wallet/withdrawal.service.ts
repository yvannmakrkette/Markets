import mongoose from 'mongoose';
import { authenticator } from 'otplib';
import { badRequest, conflict, notFound } from '../lib/errors';
import { env } from '../config/env';
import { User } from '../models/user';
import { WalletAsset, WalletBalance, WalletLedgerEntry, WalletNetwork, WalletWithdrawal, WalletAuditLog, WalletNetworkT } from '../models/wallet';
import { inWalletTxn } from './deposit.service';
import { adapterForNetwork } from './chain.registry';
import { fromAtomic, toAtomic } from './money';

function decimal(value: bigint, decimals: number) { return fromAtomic(value, decimals); }

export async function createWalletWithdrawal(userId: string, input: { networkId: string; amount: string; toAddress: string; memo?: string; twoFactorCode?: string }, ip?: string) {
  const userObjectId = new mongoose.Types.ObjectId(userId);
  const [user, network] = await Promise.all([
    User.findById(userObjectId).lean(),
    WalletNetwork.findOne({ _id: input.networkId, enabled: true }),
  ]);
  if (!user) throw notFound('User not found');
  if (!network) throw notFound('Withdrawal network is unavailable');
  if (!user.emailVerified) throw badRequest('Verify your e-mail before requesting a crypto withdrawal', 'EMAIL_VERIFICATION_REQUIRED');
  if (env.REQUIRE_KYC_FOR_WITHDRAWAL && user.kycStatus !== 'approved') throw badRequest('Identity verification is required before withdrawing', 'KYC_REQUIRED');
  if (user.twoFactor?.enabled) {
    if (!input.twoFactorCode || !user.twoFactor.secret || !authenticator.verify({ token: input.twoFactorCode, secret: user.twoFactor.secret })) {
      throw badRequest('A valid authenticator code is required', 'INVALID_2FA');
    }
  }
  const asset = await WalletAsset.findOne({ symbol: network.assetSymbol, enabled: true }).lean();
  if (!asset) throw notFound('Asset is unavailable for withdrawal');
  const adapter = adapterForNetwork(network.toObject() as WalletNetworkT);
  if (!adapter || !adapter.validateAddress(input.toAddress, input.memo)) throw badRequest('Invalid withdrawal address or memo', 'INVALID_ADDRESS');
  if (network.memoRequired && !input.memo) throw badRequest('A destination memo/tag is required for this network', 'MEMO_REQUIRED');
  const amountAtomic = toAtomic(input.amount, asset.decimals);
  const minAtomic = toAtomic(network.minWithdraw.toString(), asset.decimals);
  const feeAtomic = toAtomic(network.withdrawFee.toString(), asset.decimals);
  if (amountAtomic < minAtomic) throw badRequest(`Minimum withdrawal is ${network.minWithdraw.toString()} ${asset.symbol}`, 'BELOW_MINIMUM');
  if (amountAtomic <= feeAtomic) throw badRequest('Withdrawal amount must exceed the network fee', 'AMOUNT_BELOW_FEE');
  const amount = decimal(amountAtomic, asset.decimals);
  const fee = decimal(feeAtomic, asset.decimals);
  const netAmount = decimal(amountAtomic - feeAtomic, asset.decimals);

  return inWalletTxn(async (session) => {
    const balance = await WalletBalance.findOneAndUpdate(
      { userId: userObjectId, assetSymbol: asset.symbol, available: { $gte: mongoose.Types.Decimal128.fromString(amount) } },
      { $inc: { available: mongoose.Types.Decimal128.fromString(`-${amount}`), locked: mongoose.Types.Decimal128.fromString(amount) } },
      { new: true, session },
    );
    if (!balance) throw badRequest(`Insufficient available ${asset.symbol} balance`, 'INSUFFICIENT_BALANCE');
    const withdrawal = await WalletWithdrawal.create([{
      userId: userObjectId, networkId: network._id, toAddress: input.toAddress, memo: input.memo,
      amount: mongoose.Types.Decimal128.fromString(amount), fee: mongoose.Types.Decimal128.fromString(fee),
      netAmount: mongoose.Types.Decimal128.fromString(netAmount), status: 'pending_review',
    }], { session, ordered: true });
    const refId = withdrawal[0]!._id;
    const afterNet = decimal(toAtomic(balance.available.toString(), asset.decimals) + feeAtomic, asset.decimals);
    await WalletLedgerEntry.create([
      { userId: userObjectId, assetSymbol: asset.symbol, amount: mongoose.Types.Decimal128.fromString(`-${netAmount}`), type: 'withdrawal', refType: 'withdrawal', refId, balanceAfter: mongoose.Types.Decimal128.fromString(afterNet) },
      { userId: userObjectId, assetSymbol: asset.symbol, amount: mongoose.Types.Decimal128.fromString(`-${fee}`), type: 'withdrawal_fee', refType: 'withdrawal', refId, balanceAfter: balance.available },
    ], { session, ordered: true });
    await WalletAuditLog.create([{ actorId: userObjectId, role: 'user', action: 'withdrawal.requested', entityType: 'withdrawal', entityId: refId, after: { status: 'pending_review', amount, fee, toAddress: input.toAddress }, ip }], { session });
    return { id: String(refId), assetSymbol: asset.symbol, networkCode: network.networkCode, amount, fee, netAmount, toAddress: input.toAddress, memo: input.memo ?? null, status: 'pending_review' };
  });
}

export async function listWalletWithdrawals(userId: string, { page, limit }: { page: number; limit: number }) {
  const filter = { userId: new mongoose.Types.ObjectId(userId) };
  const [rows, total, networks, assets] = await Promise.all([
    WalletWithdrawal.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    WalletWithdrawal.countDocuments(filter), WalletNetwork.find({}).lean(), WalletAsset.find({}).lean(),
  ]);
  const networkMap = new Map(networks.map((n) => [String(n._id), n]));
  const assetMap = new Map(assets.map((a) => [a.symbol, a]));
  return { page, limit, total, items: rows.map((row) => {
    const network = networkMap.get(String(row.networkId));
    const decimals = assetMap.get(network?.assetSymbol ?? '')?.decimals ?? 8;
    return { id: String(row._id), assetSymbol: network?.assetSymbol ?? '', networkCode: network?.networkCode ?? '', toAddress: row.toAddress,
      amount: decimal(toAtomic(row.amount.toString(), decimals), decimals), fee: decimal(toAtomic(row.fee.toString(), decimals), decimals),
      netAmount: decimal(toAtomic(row.netAmount.toString(), decimals), decimals), status: row.status, txHash: row.txHash ?? null,
      rejectReason: row.rejectReason ?? null, createdAt: row.createdAt };
  }) };
}

export async function listWalletAdminWithdrawals(status?: string) {
  const filter = status ? { status } : {};
  const rows = await WalletWithdrawal.find(filter).sort({ createdAt: -1 }).limit(200).lean();
  const [users, networks, assets] = await Promise.all([
    User.find({ _id: { $in: rows.map((row) => row.userId) } }, { username: 1, email: 1 }).lean(),
    WalletNetwork.find({ _id: { $in: rows.map((row) => row.networkId) } }).lean(), WalletAsset.find({}).lean(),
  ]);
  const userMap = new Map(users.map((u) => [String(u._id), u]));
  const networkMap = new Map(networks.map((n) => [String(n._id), n]));
  const assetMap = new Map(assets.map((a) => [a.symbol, a]));
  return rows.map((row) => {
    const network = networkMap.get(String(row.networkId));
    const decimals = assetMap.get(network?.assetSymbol ?? '')?.decimals ?? 8;
    return { id: String(row._id), userId: String(row.userId), username: userMap.get(String(row.userId))?.username, email: userMap.get(String(row.userId))?.email,
      assetSymbol: network?.assetSymbol ?? '', networkCode: network?.networkCode ?? '', toAddress: row.toAddress, memo: row.memo ?? null,
      amount: decimal(toAtomic(row.amount.toString(), decimals), decimals), fee: decimal(toAtomic(row.fee.toString(), decimals), decimals), netAmount: decimal(toAtomic(row.netAmount.toString(), decimals), decimals),
      status: row.status, txHash: row.txHash ?? null, rejectReason: row.rejectReason ?? null, createdAt: row.createdAt };
  });
}

export async function reviewWalletWithdrawal(adminId: string, id: string, action: 'approve' | 'reject', opts: { note?: string; ip?: string } = {}) {
  const adminObjectId = new mongoose.Types.ObjectId(adminId);
  return inWalletTxn(async (session) => {
    const withdrawal = await WalletWithdrawal.findById(id).session(session);
    if (!withdrawal || withdrawal.status !== 'pending_review') throw conflict('Withdrawal is no longer awaiting review');
    const before = { status: withdrawal.status };
    if (action === 'approve') {
      withdrawal.status = 'approved';
      withdrawal.reviewedBy = adminObjectId;
      await withdrawal.save({ session });
    } else {
      const network = await WalletNetwork.findById(withdrawal.networkId).session(session).lean();
      if (!network) throw notFound('Withdrawal network not found');
      const asset = await WalletAsset.findOne({ symbol: network.assetSymbol }).session(session).lean();
      if (!asset) throw notFound('Withdrawal asset not found');
      const total = decimal(toAtomic(withdrawal.amount.toString(), asset.decimals), asset.decimals);
      const balance = await WalletBalance.findOneAndUpdate(
        { userId: withdrawal.userId, assetSymbol: asset.symbol, locked: { $gte: mongoose.Types.Decimal128.fromString(total) } },
        { $inc: { available: mongoose.Types.Decimal128.fromString(total), locked: mongoose.Types.Decimal128.fromString(`-${total}`) } },
        { new: true, session },
      );
      if (!balance) throw new Error('Locked funds could not be released');
      await WalletLedgerEntry.create([{ userId: withdrawal.userId, assetSymbol: asset.symbol, amount: mongoose.Types.Decimal128.fromString(total), type: 'adjustment', refType: 'withdrawal_reversal', refId: withdrawal._id, balanceAfter: balance.available }], { session });
      withdrawal.status = 'rejected';
      withdrawal.rejectReason = opts.note;
      withdrawal.reviewedBy = adminObjectId;
      await withdrawal.save({ session });
    }
    await WalletAuditLog.create([{ actorId: adminObjectId, role: 'admin', action: `withdrawal.${action}`, entityType: 'withdrawal', entityId: withdrawal._id, before, after: { status: withdrawal.status, rejectReason: withdrawal.rejectReason }, ip: opts.ip }], { session });
    return { id: String(withdrawal._id), status: withdrawal.status, rejectReason: withdrawal.rejectReason ?? null };
  });
}

export async function setWalletWithdrawalBroadcast(adminId: string, id: string, txHash: string, ip?: string) {
  return transitionWithdrawal(adminId, id, ['approved'], 'broadcast', txHash, ip);
}

export async function completeWalletWithdrawal(adminId: string, id: string, txHash: string, ip?: string) {
  return inWalletTxn(async (session) => {
    const withdrawal = await WalletWithdrawal.findById(id).session(session);
    if (!withdrawal || !['approved', 'broadcast'].includes(withdrawal.status)) throw conflict('Withdrawal is not ready to complete');
    const network = await WalletNetwork.findById(withdrawal.networkId).session(session).lean();
    const asset = network ? await WalletAsset.findOne({ symbol: network.assetSymbol }).session(session).lean() : null;
    if (!network || !asset) throw notFound('Withdrawal network or asset not found');
    const amount = withdrawal.amount.toString();
    const balance = await WalletBalance.findOneAndUpdate(
      { userId: withdrawal.userId, assetSymbol: asset.symbol, locked: { $gte: mongoose.Types.Decimal128.fromString(amount) } },
      { $inc: { locked: mongoose.Types.Decimal128.fromString(`-${amount}`) } }, { new: true, session },
    );
    if (!balance) throw new Error('Locked withdrawal funds could not be settled');
    const before = { status: withdrawal.status };
    withdrawal.status = 'completed';
    withdrawal.txHash = txHash;
    withdrawal.reviewedBy = new mongoose.Types.ObjectId(adminId);
    await withdrawal.save({ session });
    await WalletAuditLog.create([{ actorId: new mongoose.Types.ObjectId(adminId), role: 'admin', action: 'withdrawal.completed', entityType: 'withdrawal', entityId: withdrawal._id, before, after: { status: 'completed', txHash }, ip }], { session });
    return { id: String(withdrawal._id), status: withdrawal.status, txHash };
  });
}

async function transitionWithdrawal(adminId: string, id: string, allowed: string[], status: 'broadcast', txHash: string, ip?: string) {
  return inWalletTxn(async (session) => {
    const withdrawal = await WalletWithdrawal.findById(id).session(session);
    if (!withdrawal || !allowed.includes(withdrawal.status)) throw conflict('Withdrawal is not approved for broadcast');
    const before = { status: withdrawal.status };
    withdrawal.status = status;
    withdrawal.txHash = txHash;
    withdrawal.reviewedBy = new mongoose.Types.ObjectId(adminId);
    await withdrawal.save({ session });
    await WalletAuditLog.create([{ actorId: new mongoose.Types.ObjectId(adminId), role: 'admin', action: 'withdrawal.broadcast', entityType: 'withdrawal', entityId: withdrawal._id, before, after: { status, txHash }, ip }], { session });
    return { id: String(withdrawal._id), status, txHash };
  });
}
