import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { User } from '../src/models/user';
import { UserDepositInstructions, WalletAsset, WalletAuditLog, WalletBalance, WalletConversion, WalletDeposit, WalletLedgerEntry, WalletNetwork, WalletPriceRate, WalletQuote, WalletWithdrawal } from '../src/models/wallet';
import { creditDepositOnce, getDepositInstructions, getWalletBalances, getWalletDeposits, getWalletHistory, getWalletLedger, simulateWaxDeposit } from '../src/wallet/deposit.service';
import { createWalletQuote, executeWalletConversion } from '../src/wallet/conversion.service';
import { completeWalletWithdrawal, createWalletWithdrawal, reviewWalletWithdrawal, setWalletWithdrawalBroadcast } from '../src/wallet/withdrawal.service';
import { generateWaxMemo } from '../src/wallet/chains/wax.adapter';
import { formatTokenAmount } from '../src/wallet/money';

let repl: MongoMemoryReplSet;

beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1, name: 'wallet-test', storageEngine: 'wiredTiger' } });
  await mongoose.connect(repl.getUri('wallet-tests'));
  await Promise.all([
    User.syncIndexes(), UserDepositInstructions.syncIndexes(), WalletAsset.syncIndexes(), WalletNetwork.syncIndexes(),
    WalletBalance.syncIndexes(), WalletDeposit.syncIndexes(), WalletLedgerEntry.syncIndexes(), WalletQuote.syncIndexes(), WalletConversion.syncIndexes(), WalletPriceRate.syncIndexes(), WalletWithdrawal.syncIndexes(), WalletAuditLog.syncIndexes(),
  ]);
}, 60_000);

beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}), UserDepositInstructions.deleteMany({}), WalletAsset.deleteMany({}), WalletNetwork.deleteMany({}),
    WalletBalance.deleteMany({}), WalletDeposit.deleteMany({}), WalletLedgerEntry.deleteMany({}), WalletQuote.deleteMany({}), WalletConversion.deleteMany({}), WalletPriceRate.deleteMany({}), WalletWithdrawal.deleteMany({}), WalletAuditLog.deleteMany({}),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await repl?.stop();
});

describe('WAX deposit handling', () => {
  it('generates numeric, non-sequential memos with a unique value per allocation', () => {
    const memos = Array.from({ length: 1000 }, generateWaxMemo);
    expect(memos.every((memo) => /^\d{13}$/.test(memo))).toBe(true);
    expect(new Set(memos).size).toBe(memos.length);
  });

  it('credits one irreversible deposit exactly once with a matching ledger entry', async () => {
    const userId = new Types.ObjectId();
    const networkId = new Types.ObjectId();
    const deposit = await WalletDeposit.create({
      userId,
      networkId,
      txHash: 'test-wax-tx',
      actionSeqOrLogIndex: '456',
      toAccountOrAddress: 'y2deposit',
      memo: '1234567890123',
      amount: mongoose.Types.Decimal128.fromString('1.25'),
      status: 'detected',
      confirmations: 1,
    });

    expect(await creditDepositOnce(deposit._id, userId, 'WAXP', '1.25000000', 8)).toBe(true);
    expect(await creditDepositOnce(deposit._id, userId, 'WAXP', '1.25000000', 8)).toBe(false);

    const balance = await WalletBalance.findOne({ userId, assetSymbol: 'WAXP' }).lean();
    const entries = await WalletLedgerEntry.find({ userId, assetSymbol: 'WAXP' }).lean();
    expect(balance?.available.toString()).toBe('1.25');
    expect(balance?.locked.toString()).toBe('0');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.amount.toString()).toBe('1.25');
    expect(entries[0]?.balanceAfter.toString()).toBe('1.25');
    expect((await WalletDeposit.findById(deposit._id).lean())?.status).toBe('credited');
  });

  it('simulates a deposit using the user memo saved by deposit-instructions service', async () => {
    const user = await User.create({ fullName: 'Wallet Tester', username: 'wallet_tester', email: 'wallet@example.com', passwordHash: 'not-used' });
    await WalletAsset.create({ symbol: 'WAXP', name: 'WAX', decimals: 8, enabled: true });
    await WalletNetwork.create({
      assetSymbol: 'WAXP', networkCode: 'WAX', chainType: 'eosio', contractOrToken: 'eosio.token',
      depositModel: 'memo', depositAccountOrXpub: 'y2deposit', memoRequired: true,
      minDeposit: mongoose.Types.Decimal128.fromString('0.00000001'),
      minWithdraw: mongoose.Types.Decimal128.fromString('1'),
      withdrawFee: mongoose.Types.Decimal128.fromString('0.1'),
      confirmationsRequired: 1, explorerTxUrlTemplate: 'https://waxblock.io/transaction/{txHash}', enabled: true,
    });

    const instructions = await getDepositInstructions(String(user._id), 'WAXP', 'WAX');
    const result = await simulateWaxDeposit(user.email, '2.5');

    expect(instructions.address).toBe('y2deposit');
    expect(instructions.memo).toMatch(/^\d{13}$/);
    expect(instructions.minimumDeposit).toBe('0.00000001');
    expect(result.status).toBe('credited');
    expect((await WalletBalance.findOne({ userId: user._id, assetSymbol: 'WAXP' }).lean())?.available.toString()).toBe('2.5');
    expect(await WalletLedgerEntry.countDocuments({ userId: user._id, type: 'deposit' })).toBe(1);
  });

  it('returns exact, user-scoped balances, deposits, history, and ledger values', async () => {
    const userId = new Types.ObjectId();
    const otherUserId = new Types.ObjectId();
    const network = await WalletNetwork.create({
      assetSymbol: 'WAXP', networkCode: 'WAX', chainType: 'eosio', contractOrToken: 'eosio.token', depositModel: 'memo',
      depositAccountOrXpub: 'y2deposit', memoRequired: true, minDeposit: mongoose.Types.Decimal128.fromString('0.00000001'),
      minWithdraw: mongoose.Types.Decimal128.fromString('1'), withdrawFee: mongoose.Types.Decimal128.fromString('0.1'),
      confirmationsRequired: 1, explorerTxUrlTemplate: 'https://waxblock.io/transaction/{txHash}', enabled: true,
    });
    await WalletAsset.create({ symbol: 'WAXP', name: 'WAX', decimals: 8, enabled: true });
    await WalletBalance.create([
      { userId, assetSymbol: 'WAXP', available: mongoose.Types.Decimal128.fromString('0.00000001'), locked: mongoose.Types.Decimal128.fromString('0') },
      { userId: otherUserId, assetSymbol: 'WAXP', available: mongoose.Types.Decimal128.fromString('99'), locked: mongoose.Types.Decimal128.fromString('0') },
    ]);
    await WalletDeposit.create([
      { userId, networkId: network._id, txHash: 'user-tx', actionSeqOrLogIndex: '1', toAccountOrAddress: 'y2deposit', amount: mongoose.Types.Decimal128.fromString('0.00000001'), status: 'credited', confirmations: 1 },
      { userId: otherUserId, networkId: network._id, txHash: 'other-tx', actionSeqOrLogIndex: '2', toAccountOrAddress: 'y2deposit', amount: mongoose.Types.Decimal128.fromString('99'), status: 'credited', confirmations: 1 },
    ]);
    await WalletLedgerEntry.create({ userId, assetSymbol: 'WAXP', amount: mongoose.Types.Decimal128.fromString('0.00000001'), type: 'deposit', refType: 'deposit', refId: new Types.ObjectId(), balanceAfter: mongoose.Types.Decimal128.fromString('0.00000001') });
    await WalletLedgerEntry.create({ userId: otherUserId, assetSymbol: 'WAXP', amount: mongoose.Types.Decimal128.fromString('99'), type: 'deposit', refType: 'deposit', refId: new Types.ObjectId(), balanceAfter: mongoose.Types.Decimal128.fromString('99') });

    expect(await getWalletBalances(String(userId))).toMatchObject([{ assetSymbol: 'WAXP', available: '0.00000001', locked: '0', networks: [{ code: 'WAX' }] }]);
    expect(await getWalletDeposits(String(userId), { page: 1, limit: 50 })).toMatchObject({ total: 1, items: [{ txHash: 'user-tx', amount: '0.00000001' }] });
    expect(await getWalletHistory(String(userId), { page: 1, limit: 50 })).toMatchObject({ total: 1, items: [{ kind: 'deposit', amount: '0.00000001', assetSymbol: 'WAXP' }] });
    expect(await getWalletLedger(String(userId), { page: 1, limit: 50 })).toMatchObject({ total: 1, items: [{ type: 'deposit', amount: '0.00000001', balanceAfter: '0.00000001' }] });
  });

  it('executes a conversion once from an expiring quote and keeps both ledgers in sync', async () => {
    const userId = new Types.ObjectId();
    await WalletAsset.create([{ symbol: 'WAXP', name: 'WAX', decimals: 8, enabled: true }, { symbol: 'USDT', name: 'Tether', decimals: 6, enabled: true }]);
    await WalletPriceRate.create([
      { assetSymbol: 'WAXP', usdPrice: mongoose.Types.Decimal128.fromString('0.04'), updatedBy: userId },
      { assetSymbol: 'USDT', usdPrice: mongoose.Types.Decimal128.fromString('1'), updatedBy: userId },
    ]);
    await WalletBalance.create({ userId, assetSymbol: 'WAXP', available: mongoose.Types.Decimal128.fromString('10'), locked: mongoose.Types.Decimal128.fromString('0') });
    const quote = await createWalletQuote(String(userId), 'WAXP', 'USDT', '10');
    expect(quote.toAmount).toBe('0.398');
    expect(quote.feeAmount).toBe('0.002');
    expect((await executeWalletConversion(String(userId), quote.quoteId)).status).toBe('completed');
    await expect(executeWalletConversion(String(userId), quote.quoteId)).rejects.toMatchObject({ code: 'QUOTE_UNAVAILABLE' });
    expect((await WalletBalance.findOne({ userId, assetSymbol: 'WAXP' }).lean())?.available.toString()).toBe('0');
    expect((await WalletBalance.findOne({ userId, assetSymbol: 'USDT' }).lean())?.available.toString()).toBe('0.398');
    expect(await WalletLedgerEntry.countDocuments({ userId })).toBe(2);

    await WalletBalance.updateOne({ userId, assetSymbol: 'WAXP' }, { $set: { available: mongoose.Types.Decimal128.fromString('1') } });
    const expired = await createWalletQuote(String(userId), 'WAXP', 'USDT', '1');
    await WalletQuote.updateOne({ _id: expired.quoteId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(executeWalletConversion(String(userId), expired.quoteId)).rejects.toMatchObject({ code: 'QUOTE_UNAVAILABLE' });
  });

  it('locks withdrawal funds and releases them with a ledger reversal when rejected', async () => {
    const user = await User.create({ fullName: 'Withdraw Tester', username: 'withdraw_tester', email: 'withdraw@example.com', passwordHash: 'not-used', emailVerified: true });
    const admin = await User.create({ fullName: 'Wallet Admin', username: 'wallet_admin', email: 'wallet-admin@example.com', passwordHash: 'not-used', role: 'admin' });
    await WalletAsset.create({ symbol: 'WAXP', name: 'WAX', decimals: 8, enabled: true });
    const network = await WalletNetwork.create({
      assetSymbol: 'WAXP', networkCode: 'WAX', chainType: 'eosio', contractOrToken: 'eosio.token', depositModel: 'memo', depositAccountOrXpub: 'y2deposit', memoRequired: true,
      minDeposit: mongoose.Types.Decimal128.fromString('0.00000001'), minWithdraw: mongoose.Types.Decimal128.fromString('1'), withdrawFee: mongoose.Types.Decimal128.fromString('0.1'),
      confirmationsRequired: 1, explorerTxUrlTemplate: 'https://waxblock.io/transaction/{txHash}', enabled: true,
    });
    await WalletBalance.create({ userId: user._id, assetSymbol: 'WAXP', available: mongoose.Types.Decimal128.fromString('2.5'), locked: mongoose.Types.Decimal128.fromString('0') });
    const request = await createWalletWithdrawal(String(user._id), { networkId: String(network._id), amount: '2.5', toAddress: 'alice12345', memo: '7788' });
    expect(request.netAmount).toBe('2.4');
    expect(formatTokenAmount((await WalletBalance.findOne({ userId: user._id, assetSymbol: 'WAXP' }).lean())!.available.toString(), 8)).toBe('0');
    expect(formatTokenAmount((await WalletBalance.findOne({ userId: user._id, assetSymbol: 'WAXP' }).lean())!.locked.toString(), 8)).toBe('2.5');
    await reviewWalletWithdrawal(String(admin._id), request.id, 'reject', { note: 'Address could not be verified' });
    const balance = await WalletBalance.findOne({ userId: user._id, assetSymbol: 'WAXP' }).lean();
    expect(formatTokenAmount(balance!.available.toString(), 8)).toBe('2.5');
    expect(formatTokenAmount(balance!.locked.toString(), 8)).toBe('0');
    expect((await WalletWithdrawal.findById(request.id).lean())?.status).toBe('rejected');
    expect((await WalletLedgerEntry.find({ userId: user._id }).sort({ createdAt: 1 }).lean()).map((entry) => entry.amount.toString())).toEqual(['-2.4', '-0.1', '2.5']);
    expect(await WalletAuditLog.countDocuments({ entityId: new Types.ObjectId(request.id) })).toBe(2);
  });

  it('derives a unique EVM deposit address from a public xpub only', async () => {
    const first = await User.create({ fullName: 'EVM One', username: 'evm_one', email: 'evm-one@example.com', passwordHash: 'not-used' });
    const second = await User.create({ fullName: 'EVM Two', username: 'evm_two', email: 'evm-two@example.com', passwordHash: 'not-used' });
    await WalletAsset.create({ symbol: 'USDT', name: 'Tether', decimals: 6, enabled: true });
    await WalletNetwork.create({
      assetSymbol: 'USDT', networkCode: 'ERC20', chainType: 'evm', contractOrToken: '0x0000000000000000000000000000000000000001',
      depositModel: 'address', depositAccountOrXpub: 'xpub6GJwaADoeFMvX8WJvWaNc9SGyGk5WNu1ot6qKxQxEuBpFy2LoHbetz41PgEcEg4n2bk3hWoHYJ69EqkjpoSv9KrinCnZV6y4Xo6VJZ6KHWT',
      memoRequired: false, minDeposit: mongoose.Types.Decimal128.fromString('1'), minWithdraw: mongoose.Types.Decimal128.fromString('1'),
      withdrawFee: mongoose.Types.Decimal128.fromString('1'), confirmationsRequired: 12, explorerTxUrlTemplate: 'https://etherscan.io/tx/{txHash}', enabled: true,
    });
    const [a, b] = await Promise.all([
      getDepositInstructions(String(first._id), 'USDT', 'ERC20'), getDepositInstructions(String(second._id), 'USDT', 'ERC20'),
    ]);
    expect(a.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(b.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(a.address).not.toBe(b.address);
    expect(await getDepositInstructions(String(first._id), 'USDT', 'ERC20')).toMatchObject({ address: a.address });
    expect(await UserDepositInstructions.countDocuments()).toBe(2);
  });

  it('keeps approved funds locked until an administrator records the external payout', async () => {
    const user = await User.create({ fullName: 'Payout User', username: 'payout_user', email: 'payout@example.com', passwordHash: 'not-used', emailVerified: true });
    const admin = await User.create({ fullName: 'Payout Admin', username: 'payout_admin', email: 'payout-admin@example.com', passwordHash: 'not-used', role: 'admin' });
    await WalletAsset.create({ symbol: 'WAXP', name: 'WAX', decimals: 8, enabled: true });
    const network = await WalletNetwork.create({ assetSymbol: 'WAXP', networkCode: 'WAX', chainType: 'eosio', contractOrToken: 'eosio.token', depositModel: 'memo', depositAccountOrXpub: 'y2deposit', memoRequired: true, minDeposit: mongoose.Types.Decimal128.fromString('0.00000001'), minWithdraw: mongoose.Types.Decimal128.fromString('1'), withdrawFee: mongoose.Types.Decimal128.fromString('0.1'), confirmationsRequired: 1, explorerTxUrlTemplate: 'https://waxblock.io/transaction/{txHash}', enabled: true });
    await WalletBalance.create({ userId: user._id, assetSymbol: 'WAXP', available: mongoose.Types.Decimal128.fromString('3'), locked: mongoose.Types.Decimal128.fromString('0') });
    const request = await createWalletWithdrawal(String(user._id), { networkId: String(network._id), amount: '2', toAddress: 'alice12345', memo: '1234' });
    await reviewWalletWithdrawal(String(admin._id), request.id, 'approve');
    expect(formatTokenAmount((await WalletBalance.findOne({ userId: user._id, assetSymbol: 'WAXP' }).lean())!.locked.toString(), 8)).toBe('2');
    await setWalletWithdrawalBroadcast(String(admin._id), request.id, '0x1234567890abcdef');
    await completeWalletWithdrawal(String(admin._id), request.id, '0x1234567890abcdef');
    expect((await WalletWithdrawal.findById(request.id).lean())?.status).toBe('completed');
    const balance = await WalletBalance.findOne({ userId: user._id, assetSymbol: 'WAXP' }).lean();
    expect(formatTokenAmount(balance!.available.toString(), 8)).toBe('1');
    expect(formatTokenAmount(balance!.locked.toString(), 8)).toBe('0');
  });
});
