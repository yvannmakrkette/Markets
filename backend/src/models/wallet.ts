import mongoose, { Schema, model, InferSchemaType, Types } from 'mongoose';

const decimal = (value = '0') => mongoose.Types.Decimal128.fromString(value);

const assetSchema = new Schema(
  {
    symbol: { type: String, required: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    decimals: { type: Number, required: true, min: 0, max: 30 },
    iconUrl: String,
    priceFeedId: { type: String, trim: true, lowercase: true },
    enabled: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);
assetSchema.index({ symbol: 1 }, { unique: true });
export type WalletAssetT = InferSchemaType<typeof assetSchema> & { _id: Types.ObjectId };
export const WalletAsset = model('WalletAsset', assetSchema, 'walletAssets');

const networkSchema = new Schema(
  {
    assetSymbol: { type: String, required: true, uppercase: true, trim: true, index: true },
    networkCode: { type: String, required: true, uppercase: true, trim: true },
    chainType: { type: String, enum: ['eosio', 'evm', 'tron', 'btc', 'xrp', 'stellar', 'ton'], required: true },
    contractOrToken: { type: String, required: true, trim: true },
    depositModel: { type: String, enum: ['memo', 'address'], required: true },
    depositAccountOrXpub: { type: String, trim: true },
    memoRequired: { type: Boolean, default: false },
    minDeposit: { type: Schema.Types.Decimal128, required: true },
    minWithdraw: { type: Schema.Types.Decimal128, required: true },
    withdrawFee: { type: Schema.Types.Decimal128, required: true },
    confirmationsRequired: { type: Number, required: true, min: 0 },
    explorerTxUrlTemplate: { type: String, required: true },
    rpcConfigKey: String,
    depositStartBlock: { type: Number, min: 0 },
    nextDerivationIndex: { type: Number, min: 0, default: 0 },
    enabled: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);
networkSchema.index({ assetSymbol: 1, networkCode: 1 }, { unique: true });
export type WalletNetworkT = InferSchemaType<typeof networkSchema> & { _id: Types.ObjectId };
export const WalletNetwork = model('WalletNetwork', networkSchema, 'walletNetworks');

const depositInstructionsSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    networkId: { type: Schema.Types.ObjectId, ref: 'WalletNetwork', required: true },
    address: String,
    memo: String,
    derivationIndex: { type: Number, min: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
depositInstructionsSchema.index({ userId: 1, networkId: 1 }, { unique: true });
depositInstructionsSchema.index({ networkId: 1, memo: 1 }, { unique: true, partialFilterExpression: { memo: { $exists: true } } });
depositInstructionsSchema.index({ networkId: 1, address: 1 }, { unique: true, partialFilterExpression: { address: { $exists: true } } });
depositInstructionsSchema.index({ networkId: 1, derivationIndex: 1 }, { unique: true, partialFilterExpression: { derivationIndex: { $exists: true } } });
export type UserDepositInstructionsT = InferSchemaType<typeof depositInstructionsSchema> & { _id: Types.ObjectId };
export const UserDepositInstructions = model('UserDepositInstructions', depositInstructionsSchema, 'userDepositInstructions');

const balanceSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    assetSymbol: { type: String, required: true, uppercase: true, trim: true },
    available: { type: Schema.Types.Decimal128, required: true, default: () => decimal() },
    locked: { type: Schema.Types.Decimal128, required: true, default: () => decimal() },
  },
  { timestamps: true },
);
balanceSchema.index({ userId: 1, assetSymbol: 1 }, { unique: true });
export type WalletBalanceT = InferSchemaType<typeof balanceSchema> & { _id: Types.ObjectId };
export const WalletBalance = model('WalletBalance', balanceSchema, 'walletBalances');

const ledgerEntrySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    assetSymbol: { type: String, required: true, uppercase: true, immutable: true },
    amount: { type: Schema.Types.Decimal128, required: true, immutable: true },
    type: { type: String, enum: ['deposit', 'withdrawal', 'withdrawal_fee', 'convert_out', 'convert_in', 'adjustment'], required: true, immutable: true },
    refType: { type: String, required: true, immutable: true },
    refId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    balanceAfter: { type: Schema.Types.Decimal128, required: true, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
ledgerEntrySchema.index({ userId: 1, createdAt: -1 });
ledgerEntrySchema.index({ refType: 1, refId: 1 });
export type WalletLedgerEntryT = InferSchemaType<typeof ledgerEntrySchema> & { _id: Types.ObjectId };
export const WalletLedgerEntry = model('WalletLedgerEntry', ledgerEntrySchema, 'walletLedgerEntries');

const depositSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    networkId: { type: Schema.Types.ObjectId, ref: 'WalletNetwork', required: true },
    txHash: { type: String, required: true },
    actionSeqOrLogIndex: { type: String, required: true },
    from: String,
    toAccountOrAddress: { type: String, required: true },
    memo: String,
    amount: { type: Schema.Types.Decimal128, required: true },
    status: { type: String, enum: ['detected', 'confirming', 'credited', 'unmatched', 'rejected'], default: 'detected', index: true },
    confirmations: { type: Number, default: 0, min: 0 },
    blockNum: Number,
    detectedAt: { type: Date, default: Date.now },
    creditedAt: Date,
  },
  { timestamps: true },
);
depositSchema.index({ networkId: 1, txHash: 1, actionSeqOrLogIndex: 1 }, { unique: true });
depositSchema.index({ userId: 1, detectedAt: -1 });
export type WalletDepositT = InferSchemaType<typeof depositSchema> & { _id: Types.ObjectId };
export const WalletDeposit = model('WalletDeposit', depositSchema, 'walletDeposits');

const conversionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    fromAsset: { type: String, required: true, uppercase: true },
    toAsset: { type: String, required: true, uppercase: true },
    fromAmount: { type: Schema.Types.Decimal128, required: true },
    toAmount: { type: Schema.Types.Decimal128, required: true },
    rate: { type: Schema.Types.Decimal128, required: true },
    spreadBps: { type: Number, required: true, min: 0 },
    feeAmount: { type: Schema.Types.Decimal128, required: true },
    quoteId: { type: Schema.Types.ObjectId, ref: 'WalletQuote', required: true },
    status: { type: String, enum: ['completed', 'failed'], default: 'completed' },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
conversionSchema.index({ userId: 1, createdAt: -1 });
export type WalletConversionT = InferSchemaType<typeof conversionSchema> & { _id: Types.ObjectId };
export const WalletConversion = model('WalletConversion', conversionSchema, 'walletConversions');

const quoteSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    fromAsset: { type: String, required: true, uppercase: true },
    toAsset: { type: String, required: true, uppercase: true },
    fromAmount: { type: Schema.Types.Decimal128, required: true },
    toAmount: { type: Schema.Types.Decimal128, required: true },
    rate: { type: Schema.Types.Decimal128, required: true },
    expiresAt: { type: Date, required: true },
    used: { type: Boolean, default: false },
    feeAmount: { type: Schema.Types.Decimal128, required: true, default: () => decimal() },
    spreadBps: { type: Number, min: 0, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
quoteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
quoteSchema.index({ userId: 1, used: 1, expiresAt: 1 });
export type WalletQuoteT = InferSchemaType<typeof quoteSchema> & { _id: Types.ObjectId };
export const WalletQuote = model('WalletQuote', quoteSchema, 'walletQuotes');

const priceRateSchema = new Schema({
  assetSymbol: { type: String, required: true, uppercase: true, trim: true },
  usdPrice: { type: Schema.Types.Decimal128, required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });
priceRateSchema.index({ assetSymbol: 1 }, { unique: true });
export const WalletPriceRate = model('WalletPriceRate', priceRateSchema, 'walletPriceRates');

const withdrawalSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    networkId: { type: Schema.Types.ObjectId, ref: 'WalletNetwork', required: true },
    toAddress: { type: String, required: true },
    memo: String,
    amount: { type: Schema.Types.Decimal128, required: true },
    fee: { type: Schema.Types.Decimal128, required: true },
    netAmount: { type: Schema.Types.Decimal128, required: true },
    status: { type: String, enum: ['pending_review', 'approved', 'broadcast', 'completed', 'rejected', 'failed'], default: 'pending_review', index: true },
    txHash: String,
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    rejectReason: String,
  },
  { timestamps: true },
);
withdrawalSchema.index({ userId: 1, createdAt: -1 });
export type WalletWithdrawalT = InferSchemaType<typeof withdrawalSchema> & { _id: Types.ObjectId };
export const WalletWithdrawal = model('WalletWithdrawal', withdrawalSchema, 'walletWithdrawals');

const auditLogSchema = new Schema(
  {
    actorId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    role: { type: String, required: true, immutable: true },
    action: { type: String, required: true, immutable: true },
    entityType: { type: String, required: true, immutable: true },
    entityId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    before: { type: Schema.Types.Mixed, immutable: true },
    after: { type: Schema.Types.Mixed, immutable: true },
    ip: { type: String, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
auditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
auditLogSchema.index({ actorId: 1, createdAt: -1 });
export type WalletAuditLogT = InferSchemaType<typeof auditLogSchema> & { _id: Types.ObjectId };
export const WalletAuditLog = model('WalletAuditLog', auditLogSchema, 'walletAuditLogs');

const scanCursorSchema = new Schema(
  {
    networkId: { type: Schema.Types.ObjectId, ref: 'WalletNetwork', required: true, unique: true },
    cursor: { type: String, default: '' },
  },
  { timestamps: true },
);
export const WalletScanCursor = model('WalletScanCursor', scanCursorSchema, 'walletScanCursors');
