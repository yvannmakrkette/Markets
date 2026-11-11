import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { AppError, notFound } from '../lib/errors';
import { createLogger } from '../lib/logger';
import { env } from '../config/env';
import { User } from '../models/user';
import { WalletAsset, WalletAuditLog, WalletBalance, WalletConversion, WalletDeposit, WalletLedgerEntry, WalletNetwork, WalletNetworkT, WalletScanCursor, WalletWithdrawal, UserDepositInstructions } from '../models/wallet';
import { NormalizedChainDeposit } from './chains/adapter';
import { adapterForNetwork } from './chain.registry';
import { formatTokenAmount, fromAtomic, toAtomic } from './money';

const walletLog = createLogger('wallet-deposits');

function isReplicaSetError(error: unknown) {
  const e = error as { code?: number; message?: string };
  return e?.code === 20 || /transaction numbers are only allowed|replica set/i.test(e?.message ?? '');
}

export async function inWalletTxn<T>(fn: (session: mongoose.ClientSession) => Promise<T>) {
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => { result = await fn(session); }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    return result;
  } catch (error) {
    if (isReplicaSetError(error)) {
      throw new AppError(503, 'REPLICA_SET_REQUIRED', 'Wallet deposits require MongoDB transactions. Configure MONGO_URI to use a replica set.');
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

async function storeDetected(networkId: mongoose.Types.ObjectId, event: NormalizedChainDeposit) {
  const filter = { networkId, txHash: event.txHash, actionSeqOrLogIndex: event.actionSeqOrLogIndex };
  await WalletDeposit.updateOne(
    filter,
    {
      $setOnInsert: {
        ...filter,
        from: event.from,
        toAccountOrAddress: event.toAccountOrAddress,
        memo: event.memo,
        amount: mongoose.Types.Decimal128.fromString(event.amount),
        status: 'detected',
        detectedAt: new Date(),
        blockNum: event.blockNum,
      },
      $set: { confirmations: event.confirmations },
    },
    { upsert: true },
  );
}

async function markUnmatched(id: mongoose.Types.ObjectId, userId?: mongoose.Types.ObjectId) {
  await WalletDeposit.updateOne(
    { _id: id, status: { $in: ['detected', 'confirming'] } },
    { $set: { status: 'unmatched', ...(userId ? { userId } : {}) } },
  );
}

export async function creditDepositOnce(id: mongoose.Types.ObjectId, userId: mongoose.Types.ObjectId, assetSymbol: string, amount: string, decimals: number) {
  const canonicalAmount = fromAtomic(toAtomic(amount, decimals), decimals);
  const credited = await inWalletTxn(async (session) => {
    const claimed = await WalletDeposit.findOneAndUpdate(
      { _id: id, status: { $in: ['detected', 'confirming'] } },
      { $set: { status: 'credited', userId, creditedAt: new Date() } },
      { new: true, session },
    );
    if (!claimed) return false;
    const balanceAmount = mongoose.Types.Decimal128.fromString(canonicalAmount);
    await WalletBalance.updateOne(
      { userId, assetSymbol },
      { $setOnInsert: { userId, assetSymbol, available: mongoose.Types.Decimal128.fromString('0'), locked: mongoose.Types.Decimal128.fromString('0') } },
      { upsert: true, session },
    );
    const balance = await WalletBalance.findOneAndUpdate(
      { userId, assetSymbol },
      { $inc: { available: balanceAmount } },
      { new: true, session },
    );
    if (!balance) throw new Error('Wallet balance could not be updated');
    await WalletLedgerEntry.create(
      [{ userId, assetSymbol, amount: balanceAmount, type: 'deposit', refType: 'deposit', refId: claimed._id, balanceAfter: balance.available }],
      { session },
    );
    return true;
  });
  return credited;
}

async function processDeposit(network: WalletNetworkT, event: NormalizedChainDeposit) {
  const doc = await WalletDeposit.findOne({ networkId: network._id, txHash: event.txHash, actionSeqOrLogIndex: event.actionSeqOrLogIndex });
  if (!doc || doc.status === 'credited' || doc.status === 'rejected' || doc.status === 'unmatched') return;
  if (!event.irreversible || event.confirmations < network.confirmationsRequired) {
    await WalletDeposit.updateOne({ _id: doc._id, status: 'detected' }, { $set: { status: 'confirming' } });
    return;
  }
  const instruction = network.depositModel === 'memo'
    ? await UserDepositInstructions.findOne({ networkId: network._id, memo: event.memo }).lean()
    : await UserDepositInstructions.findOne({ networkId: network._id, address: event.toAccountOrAddress }).lean();
  if (!instruction) {
    await markUnmatched(doc._id);
    return;
  }
  const asset = await WalletAsset.findOne({ symbol: network.assetSymbol }).lean();
  if (!asset || !asset.enabled) {
    await markUnmatched(doc._id, instruction.userId);
    return;
  }
  if (toAtomic(event.amount, asset.decimals) < toAtomic(network.minDeposit.toString(), asset.decimals)) {
    await markUnmatched(doc._id, instruction.userId);
    return;
  }
  await creditDepositOnce(doc._id, instruction.userId, asset.symbol, event.amount, asset.decimals);
}

/** Scan enabled supported networks, persist idempotently, and credit only confirmed known instructions. */
export async function scanWalletDepositsOnce() {
  const networks = await WalletNetwork.find({ enabled: true }).lean();
  for (const network of networks) {
    try {
    const adapter = adapterForNetwork(network);
    if (!adapter || adapter.implemented === false) continue;
    const cursorDoc = await WalletScanCursor.findOne({ networkId: network._id }).lean();
    const scan = await adapter.scanDeposits(network, cursorDoc?.cursor ?? '');
    for (const event of scan.deposits) {
      await storeDetected(network._id, event);
      await processDeposit(network, event);
    }
    const confirming = await WalletDeposit.find({ networkId: network._id, status: 'confirming' }).limit(500);
    for (const deposit of confirming) {
      const confirmations = await adapter.getConfirmations(deposit.txHash, network);
      const event: NormalizedChainDeposit = {
        txHash: deposit.txHash,
        actionSeqOrLogIndex: deposit.actionSeqOrLogIndex,
        from: deposit.from ?? '',
        toAccountOrAddress: deposit.toAccountOrAddress,
        memo: deposit.memo ?? '',
        amount: deposit.amount.toString(),
        blockNum: deposit.blockNum ?? 0,
        confirmations,
        irreversible: confirmations > 0,
      };
      await WalletDeposit.updateOne({ _id: deposit._id, status: 'confirming' }, { $set: { confirmations } });
      await processDeposit(network, event);
    }
    if (scan.nextCursor !== (cursorDoc?.cursor ?? '')) {
      await WalletScanCursor.updateOne(
        { networkId: network._id },
        { $set: { cursor: scan.nextCursor }, $setOnInsert: { networkId: network._id } },
        { upsert: true },
      );
    }
    } catch (error) {
      walletLog.error(`network scan failed for ${network.assetSymbol}/${network.networkCode}`, error);
    }
  }
}

export async function listEnabledWalletAssets() {
  const assets = await WalletAsset.find({ enabled: true }).sort({ symbol: 1 }).lean();
  const networks = await WalletNetwork.find({ enabled: true, assetSymbol: { $in: assets.map((asset) => asset.symbol) } }).sort({ networkCode: 1 }).lean();
  return assets.map((asset) => ({
    symbol: asset.symbol,
    name: asset.name,
    decimals: asset.decimals,
    iconUrl: asset.iconUrl ?? null,
    networks: networks.filter((network) => network.assetSymbol === asset.symbol).map((network) => ({ id: String(network._id), assetSymbol: network.assetSymbol, code: network.networkCode, memoRequired: network.memoRequired, minWithdraw: formatTokenAmount(network.minWithdraw.toString(), asset.decimals), withdrawFee: formatTokenAmount(network.withdrawFee.toString(), asset.decimals) })),
  }));
}

export async function getWalletBalances(userId: string) {
  const userObjectId = new mongoose.Types.ObjectId(userId);
  const [assets, balances, networks] = await Promise.all([
    WalletAsset.find({}).sort({ symbol: 1 }).lean(),
    WalletBalance.find({ userId: userObjectId }).lean(),
    WalletNetwork.find({ enabled: true }).lean(),
  ]);
  const balanceBySymbol = new Map(balances.map((balance) => [balance.assetSymbol, balance]));
  return assets
    .filter((asset) => asset.enabled || balanceBySymbol.has(asset.symbol))
    .map((asset) => {
      const balance = balanceBySymbol.get(asset.symbol);
      return {
        assetSymbol: asset.symbol,
        name: asset.name,
        decimals: asset.decimals,
        iconUrl: asset.iconUrl ?? null,
        enabled: asset.enabled,
        available: formatTokenAmount(balance?.available.toString() ?? '0', asset.decimals),
        locked: formatTokenAmount(balance?.locked.toString() ?? '0', asset.decimals),
        networks: asset.enabled ? networks.filter((network) => network.assetSymbol === asset.symbol).map((network) => ({ id: String(network._id), assetSymbol: network.assetSymbol, code: network.networkCode, memoRequired: network.memoRequired, minWithdraw: formatTokenAmount(network.minWithdraw.toString(), asset.decimals), withdrawFee: formatTokenAmount(network.withdrawFee.toString(), asset.decimals) })) : [],
      };
    });
}

type WalletPaging = { page: number; limit: number };

async function walletAssetsBySymbol() {
  return new Map((await WalletAsset.find({}).lean()).map((asset) => [asset.symbol, asset]));
}

export async function getWalletDeposits(userId: string, { page, limit }: WalletPaging) {
  const filter = { userId: new mongoose.Types.ObjectId(userId) };
  const [deposits, total, networks] = await Promise.all([
    WalletDeposit.find(filter).sort({ detectedAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    WalletDeposit.countDocuments(filter),
    WalletNetwork.find({}).lean(),
  ]);
  const networkById = new Map(networks.map((network) => [String(network._id), network]));
  const assets = await walletAssetsBySymbol();
  return {
    page,
    limit,
    total,
    items: deposits.map((deposit) => {
      const network = networkById.get(String(deposit.networkId));
      const asset = network ? assets.get(network.assetSymbol) : undefined;
      const amount = asset ? formatTokenAmount(deposit.amount.toString(), asset.decimals) : deposit.amount.toString();
      return {
        id: String(deposit._id),
        assetSymbol: network?.assetSymbol ?? '',
        networkCode: network?.networkCode ?? '',
        amount,
        status: deposit.status,
        txHash: deposit.txHash,
        explorerTxUrl: network?.explorerTxUrlTemplate.replace('{txHash}', encodeURIComponent(deposit.txHash)) ?? null,
        confirmations: deposit.confirmations,
        detectedAt: deposit.detectedAt,
        creditedAt: deposit.creditedAt ?? null,
      };
    }),
  };
}

export async function getWalletLedger(userId: string, { page, limit }: WalletPaging) {
  const filter = { userId: new mongoose.Types.ObjectId(userId) };
  const [entries, total, assets] = await Promise.all([
    WalletLedgerEntry.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    WalletLedgerEntry.countDocuments(filter),
    walletAssetsBySymbol(),
  ]);
  return {
    page,
    limit,
    total,
    items: entries.map((entry) => {
      const decimals = assets.get(entry.assetSymbol)?.decimals ?? 8;
      const amount = formatTokenAmount(entry.amount.toString().replace(/^-/, ''), decimals);
      const balanceAfter = formatTokenAmount(entry.balanceAfter.toString(), decimals);
      return { id: String(entry._id), assetSymbol: entry.assetSymbol, type: entry.type, amount: entry.amount.toString().startsWith('-') ? `-${amount}` : amount, balanceAfter, refType: entry.refType, refId: String(entry.refId), createdAt: entry.createdAt };
    }),
  };
}

export async function getWalletHistory(userId: string, { page, limit }: WalletPaging, kind?: 'deposit' | 'withdrawal' | 'conversion' | 'adjustment') {
  const filter = { userId: new mongoose.Types.ObjectId(userId) };
  const take = page * limit;
  const [deposits, withdrawals, conversions, adjustments, depositCount, withdrawalCount, conversionCount, adjustmentCount, assets, networks] = await Promise.all([
    WalletDeposit.find(filter).sort({ detectedAt: -1, _id: -1 }).limit(take).lean(),
    WalletWithdrawal.find(filter).sort({ createdAt: -1, _id: -1 }).limit(take).lean(),
    WalletConversion.find(filter).sort({ createdAt: -1, _id: -1 }).limit(take).lean(),
    WalletLedgerEntry.find({ ...filter, type: 'adjustment' }).sort({ createdAt: -1, _id: -1 }).limit(take).lean(),
    WalletDeposit.countDocuments(filter),
    WalletWithdrawal.countDocuments(filter),
    WalletConversion.countDocuments(filter),
    WalletLedgerEntry.countDocuments({ ...filter, type: 'adjustment' }),
    walletAssetsBySymbol(),
    WalletNetwork.find({}).lean(),
  ]);
  const networkById = new Map(networks.map((network) => [String(network._id), network]));
  const rows = [
    ...deposits.map((deposit) => {
      const network = networkById.get(String(deposit.networkId));
      const asset = network ? assets.get(network.assetSymbol) : undefined;
      return {
        id: String(deposit._id), kind: 'deposit' as const, assetSymbol: network?.assetSymbol ?? '', networkCode: network?.networkCode ?? '',
        amount: asset ? formatTokenAmount(deposit.amount.toString(), asset.decimals) : deposit.amount.toString(),
        detail: null, status: deposit.status, reference: deposit.txHash, explorerTxUrl: network?.explorerTxUrlTemplate.replace('{txHash}', encodeURIComponent(deposit.txHash)) ?? null,
        createdAt: deposit.detectedAt,
      };
    }),
    ...withdrawals.map((withdrawal) => {
      const network = networkById.get(String(withdrawal.networkId));
      const asset = network ? assets.get(network.assetSymbol) : undefined;
      const amount = asset ? formatTokenAmount(withdrawal.amount.toString(), asset.decimals) : withdrawal.amount.toString();
      return {
        id: String(withdrawal._id), kind: 'withdrawal' as const, assetSymbol: network?.assetSymbol ?? '', networkCode: network?.networkCode ?? '',
        amount: `-${amount}`, detail: `Sent ${formatTokenAmount(withdrawal.netAmount.toString(), asset?.decimals ?? 8)} ${network?.assetSymbol ?? ''}; fee ${formatTokenAmount(withdrawal.fee.toString(), asset?.decimals ?? 8)}`, status: withdrawal.status, reference: withdrawal.txHash ?? String(withdrawal._id),
        explorerTxUrl: withdrawal.txHash ? network?.explorerTxUrlTemplate.replace('{txHash}', encodeURIComponent(withdrawal.txHash)) ?? null : null, createdAt: withdrawal.createdAt,
      };
    }),
    ...conversions.map((conversion) => ({
      id: String(conversion._id), kind: 'conversion' as const, assetSymbol: `${conversion.fromAsset} → ${conversion.toAsset}`, networkCode: '',
      amount: formatTokenAmount(conversion.fromAmount.toString(), assets.get(conversion.fromAsset)?.decimals ?? 8),
      detail: `Received ${formatTokenAmount(conversion.toAmount.toString(), assets.get(conversion.toAsset)?.decimals ?? 8)} ${conversion.toAsset}`,
      status: conversion.status, reference: String(conversion._id), explorerTxUrl: null, createdAt: conversion.createdAt,
    })),
    ...adjustments.map((entry) => ({
      id: String(entry._id), kind: 'adjustment' as const, assetSymbol: entry.assetSymbol, networkCode: '',
      amount: `${entry.amount.toString().startsWith('-') ? '-' : '+'}${formatTokenAmount(entry.amount.toString().replace(/^-/, ''), assets.get(entry.assetSymbol)?.decimals ?? 8)}`,
      detail: null, status: 'completed', reference: String(entry.refId), explorerTxUrl: null, createdAt: entry.createdAt,
    })),
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() || b.id.localeCompare(a.id));
  const counts = { deposit: depositCount, withdrawal: withdrawalCount, conversion: conversionCount, adjustment: adjustmentCount };
  const filteredRows = kind ? rows.filter((row) => row.kind === kind) : rows;
  const total = kind ? counts[kind] : depositCount + withdrawalCount + conversionCount + adjustmentCount;
  return { page, limit, total, items: filteredRows.slice((page - 1) * limit, page * limit) };
}

export async function listUnmatchedWalletDeposits({ page, limit }: WalletPaging) {
  const filter = { status: 'unmatched' };
  const [rows, total, networks] = await Promise.all([
    WalletDeposit.find(filter).sort({ detectedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    WalletDeposit.countDocuments(filter), WalletNetwork.find({}).lean(),
  ]);
  const networkMap = new Map(networks.map((network) => [String(network._id), network]));
  const assets = await walletAssetsBySymbol();
  return { page, limit, total, items: rows.map((row) => {
    const network = networkMap.get(String(row.networkId));
    const asset = network ? assets.get(network.assetSymbol) : undefined;
    return { id: String(row._id), userId: row.userId ? String(row.userId) : null, networkId: String(row.networkId), assetSymbol: network?.assetSymbol ?? '', networkCode: network?.networkCode ?? '', txHash: row.txHash, from: row.from ?? '', toAccountOrAddress: row.toAccountOrAddress, memo: row.memo ?? '', amount: asset ? formatTokenAmount(row.amount.toString(), asset.decimals) : row.amount.toString(), confirmations: row.confirmations, detectedAt: row.detectedAt };
  }) };
}

export async function assignUnmatchedWalletDeposit(adminId: string, depositId: string, userId: string, ip?: string) {
  const adminObjectId = new mongoose.Types.ObjectId(adminId);
  const userObjectId = new mongoose.Types.ObjectId(userId);
  return inWalletTxn(async (session) => {
    const [deposit, user] = await Promise.all([WalletDeposit.findOne({ _id: depositId, status: 'unmatched' }).session(session), User.findById(userObjectId).session(session).lean()]);
    if (!deposit) throw notFound('Unmatched deposit not found');
    if (!user) throw notFound('User not found');
    const network = await WalletNetwork.findById(deposit.networkId).session(session).lean();
    const asset = network ? await WalletAsset.findOne({ symbol: network.assetSymbol }).session(session).lean() : null;
    if (!network || !asset) throw notFound('Deposit network or asset not found');
    const priorUserId = deposit.userId ?? null;
    deposit.status = 'credited';
    deposit.userId = userObjectId;
    deposit.creditedAt = new Date();
    await deposit.save({ session });
    await WalletBalance.updateOne({ userId: userObjectId, assetSymbol: asset.symbol }, { $setOnInsert: { userId: userObjectId, assetSymbol: asset.symbol, available: mongoose.Types.Decimal128.fromString('0'), locked: mongoose.Types.Decimal128.fromString('0') } }, { upsert: true, session });
    const balance = await WalletBalance.findOneAndUpdate({ userId: userObjectId, assetSymbol: asset.symbol }, { $inc: { available: deposit.amount } }, { new: true, session });
    if (!balance) throw new Error('Wallet balance could not be updated');
    await WalletLedgerEntry.create([{ userId: userObjectId, assetSymbol: asset.symbol, amount: deposit.amount, type: 'deposit', refType: 'deposit', refId: deposit._id, balanceAfter: balance.available }], { session });
    await WalletAuditLog.create([{ actorId: adminObjectId, role: 'admin', action: 'deposit.manually_assigned', entityType: 'deposit', entityId: deposit._id, before: { status: 'unmatched', userId: priorUserId }, after: { status: 'credited', userId: userObjectId }, ip }], { session });
    return { id: String(deposit._id), status: deposit.status, userId: String(userObjectId), amount: formatTokenAmount(deposit.amount.toString(), asset.decimals), assetSymbol: asset.symbol };
  });
}

export async function rejectUnmatchedWalletDeposit(adminId: string, depositId: string, note: string, ip?: string) {
  return inWalletTxn(async (session) => {
    const deposit = await WalletDeposit.findOne({ _id: depositId, status: 'unmatched' }).session(session);
    if (!deposit) throw notFound('Unmatched deposit not found');
    deposit.status = 'rejected';
    await deposit.save({ session });
    await WalletAuditLog.create([{ actorId: new mongoose.Types.ObjectId(adminId), role: 'admin', action: 'deposit.manually_rejected', entityType: 'deposit', entityId: deposit._id, before: { status: 'unmatched' }, after: { status: 'rejected', note }, ip }], { session });
    return { id: String(deposit._id), status: deposit.status };
  });
}

export async function getDepositInstructions(userId: string, assetSymbol: string, networkCode: string) {
  const asset = await WalletAsset.findOne({ symbol: assetSymbol.toUpperCase(), enabled: true }).lean();
  if (!asset) throw notFound('Asset is not available for wallet deposits');
  const network = await WalletNetwork.findOne({ assetSymbol: asset.symbol, networkCode: networkCode.toUpperCase(), enabled: true });
  if (!network) throw notFound('Network is not available for wallet deposits');
  const userObjectId = new mongoose.Types.ObjectId(userId);
  const adapter = adapterForNetwork(network.toObject());
  if (!adapter) throw notFound('Deposit adapter is not available for this network');
  const instructions = await adapter.getDepositInstructions(userObjectId, network.toObject());
  const minimumDeposit = fromAtomic(toAtomic(network.minDeposit.toString(), asset.decimals), asset.decimals);
  return {
    asset: { symbol: asset.symbol, name: asset.name, decimals: asset.decimals },
    network: { code: network.networkCode, confirmationsRequired: network.confirmationsRequired, explorerTxUrlTemplate: network.explorerTxUrlTemplate },
    address: instructions.address ?? null,
    memo: instructions.memo ?? null,
    memoRequired: network.memoRequired,
    minimumDeposit,
    warnings: network.memoRequired ? [`Send only ${asset.symbol} on the ${network.networkCode} network. The memo is REQUIRED or the deposit cannot be credited.`] : [`Send only ${asset.symbol} on the ${network.networkCode} network.`],
    qrPayload: instructions.address ?? '',
  };
}

/** Development-only helper used by scripts/dev-wallet-deposit.ts; memo is looked up server-side. */
export async function simulateWaxDeposit(email: string, amount: string) {
  if (env.NODE_ENV === 'production') throw new AppError(404, 'NOT_FOUND', 'Not found');
  if (!/^\d+(?:\.\d{1,8})?$/.test(amount)) throw new AppError(400, 'INVALID_AMOUNT', 'Amount must be a positive decimal with at most 8 places');
  const user = await User.findOne({ email: email.toLowerCase() }, { _id: 1 }).lean();
  if (!user) throw notFound('User not found');
  const network = await WalletNetwork.findOne({ assetSymbol: 'WAXP', networkCode: 'WAX', enabled: true });
  if (!network) throw notFound('Enabled WAXP/WAX network not found');
  const instruction = await UserDepositInstructions.findOne({ userId: user._id, networkId: network._id }).lean();
  if (!instruction?.memo) throw notFound('Create WAX deposit instructions for this user before simulating a deposit');
  const txHash = `dev-${randomUUID()}`;
  const event: NormalizedChainDeposit = {
    txHash,
    actionSeqOrLogIndex: '0',
    from: 'dev.simulator',
    toAccountOrAddress: network.depositAccountOrXpub ?? '',
    memo: instruction.memo,
    amount,
    blockNum: 1,
    confirmations: 1,
    irreversible: true,
  };
  await storeDetected(network._id, event);
  const stored = await WalletDeposit.findOne({ networkId: network._id, txHash }).lean();
  if (!stored) throw new Error('Could not create simulated deposit record');
  await processDeposit(network.toObject(), event);
  return { txHash, status: (await WalletDeposit.findById(stored._id).lean())?.status ?? 'unknown' };
}
