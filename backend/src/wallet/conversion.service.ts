import mongoose from 'mongoose';
import { AppError, badRequest, conflict, notFound } from '../lib/errors';
import { WalletAsset, WalletBalance, WalletConversion, WalletLedgerEntry, WalletQuote } from '../models/wallet';
import { env } from '../config/env';
import { fromAtomic, toAtomic } from './money';
import { inWalletTxn } from './deposit.service';
import { priceProvider } from './price.service';

const RATE_DECIMALS = 18;
const RATE_SCALE = 10n ** BigInt(RATE_DECIMALS);
const RATE_INPUT_SCALE = 10n ** 12n;
const pow10 = (n: number) => 10n ** BigInt(n);

function priceToRateUnits(value: string) {
  return toAtomic(value, 30) / RATE_INPUT_SCALE;
}

function canonicalPositiveAmount(value: string, decimals: number) {
  const amount = toAtomic(value, decimals);
  if (amount <= 0n) throw badRequest('Amount must be greater than zero', 'INVALID_AMOUNT');
  return amount;
}

export async function createWalletQuote(userId: string, fromInput: string, toInput: string, amountInput: string) {
  const fromAsset = fromInput.toUpperCase();
  const toAsset = toInput.toUpperCase();
  if (fromAsset === toAsset) throw badRequest('Choose two different assets');
  const [from, to] = await Promise.all([
    WalletAsset.findOne({ symbol: fromAsset, enabled: true }).lean(),
    WalletAsset.findOne({ symbol: toAsset, enabled: true }).lean(),
  ]);
  if (!from || !to) throw notFound('One or both assets are unavailable for conversion');
  const fromAmountAtomic = canonicalPositiveAmount(amountInput, from.decimals);
  const rates = await priceProvider.usdRates([fromAsset, toAsset]);
  const fromUsd = rates.get(fromAsset);
  const toUsd = rates.get(toAsset);
  if (!fromUsd || !toUsd) throw new AppError(503, 'PRICE_UNAVAILABLE', 'No live or configured fallback price is available for one or both assets');
  const fromUsdAtomic = priceToRateUnits(fromUsd);
  const toUsdAtomic = priceToRateUnits(toUsd);
  if (fromUsdAtomic <= 0n || toUsdAtomic <= 0n) throw new AppError(503, 'PRICE_UNAVAILABLE', 'Price source returned an invalid rate');
  const rateAtomic = (fromUsdAtomic * RATE_SCALE) / toUsdAtomic;
  if (rateAtomic <= 0n) throw new AppError(503, 'PRICE_UNAVAILABLE', 'Calculated conversion rate is below supported precision');
  const grossToAtomic = (fromAmountAtomic * rateAtomic * pow10(to.decimals)) / (pow10(from.decimals) * RATE_SCALE);
  const spreadBps = env.CONVERT_SPREAD_BPS;
  const toAtomicAmount = (grossToAtomic * BigInt(10_000 - spreadBps)) / 10_000n;
  const feeAtomic = grossToAtomic - toAtomicAmount;
  if (toAtomicAmount <= 0n) throw badRequest('Amount is too small for this conversion', 'INVALID_AMOUNT');
  const fromDecimal = fromAtomic(fromAmountAtomic, from.decimals);
  const toDecimal = fromAtomic(toAtomicAmount, to.decimals);
  const quoteRate = fromAtomic(rateAtomic, RATE_DECIMALS);
  const expiresAt = new Date(Date.now() + env.QUOTE_TTL_SECONDS * 1000);
  const balance = await WalletBalance.findOne({ userId: new mongoose.Types.ObjectId(userId), assetSymbol: fromAsset }).lean();
  if (!balance || toAtomic(balance.available.toString(), from.decimals) < fromAmountAtomic) throw badRequest(`Insufficient available ${fromAsset} balance`, 'INSUFFICIENT_BALANCE');

  const quote = await WalletQuote.create({
    userId: new mongoose.Types.ObjectId(userId), fromAsset, toAsset,
    fromAmount: mongoose.Types.Decimal128.fromString(fromDecimal),
    toAmount: mongoose.Types.Decimal128.fromString(toDecimal),
    rate: mongoose.Types.Decimal128.fromString(quoteRate),
    expiresAt, used: false,
    feeAmount: mongoose.Types.Decimal128.fromString(fromAtomic(feeAtomic, to.decimals)),
    spreadBps,
  });
  return {
    quoteId: String(quote._id), fromAsset, toAsset, fromAmount: fromDecimal, toAmount: toDecimal,
    rate: quoteRate, feeAmount: fromAtomic(feeAtomic, to.decimals),
    spreadBps, expiresAt,
  };
}

export async function executeWalletConversion(userId: string, quoteId: string) {
  const userObjectId = new mongoose.Types.ObjectId(userId);
  return inWalletTxn(async (session) => {
    const now = new Date();
    const quote = await WalletQuote.findOneAndUpdate(
      { _id: quoteId, userId: userObjectId, used: false, expiresAt: { $gt: now } },
      { $set: { used: true } }, { new: true, session },
    );
    if (!quote) throw conflict('Quote is expired, already used, or unavailable', 'QUOTE_UNAVAILABLE');
    const [from, to] = await Promise.all([
      WalletAsset.findOne({ symbol: quote.fromAsset }).lean().session(session),
      WalletAsset.findOne({ symbol: quote.toAsset }).lean().session(session),
    ]);
    if (!from || !to) throw notFound('Conversion asset is no longer available');
    const fromAmount = quote.fromAmount.toString();
    const toAmount = quote.toAmount.toString();
    const debited = await WalletBalance.findOneAndUpdate(
      { userId: userObjectId, assetSymbol: quote.fromAsset, available: { $gte: mongoose.Types.Decimal128.fromString(fromAmount) } },
      { $inc: { available: mongoose.Types.Decimal128.fromString(`-${fromAmount}`) } },
      { new: true, session },
    );
    if (!debited) throw badRequest(`Insufficient available ${quote.fromAsset} balance`, 'INSUFFICIENT_BALANCE');
    await WalletBalance.updateOne(
      { userId: userObjectId, assetSymbol: quote.toAsset },
      { $setOnInsert: { userId: userObjectId, assetSymbol: quote.toAsset, locked: mongoose.Types.Decimal128.fromString('0') }, $inc: { available: mongoose.Types.Decimal128.fromString(toAmount) } },
      { upsert: true, session },
    );
    const credited = await WalletBalance.findOne({ userId: userObjectId, assetSymbol: quote.toAsset }).session(session);
    if (!credited) throw new Error('Converted balance could not be updated');
    const conversion = await WalletConversion.create([{
      userId: userObjectId, fromAsset: quote.fromAsset, toAsset: quote.toAsset,
      fromAmount: quote.fromAmount, toAmount: quote.toAmount, rate: quote.rate,
      spreadBps: quote.spreadBps ?? 0, feeAmount: quote.feeAmount ?? mongoose.Types.Decimal128.fromString('0'), quoteId: quote._id, status: 'completed',
    }], { session, ordered: true });
    await WalletLedgerEntry.create([
      { userId: userObjectId, assetSymbol: quote.fromAsset, amount: mongoose.Types.Decimal128.fromString(`-${fromAmount}`), type: 'convert_out', refType: 'conversion', refId: conversion[0]!._id, balanceAfter: debited.available },
      { userId: userObjectId, assetSymbol: quote.toAsset, amount: mongoose.Types.Decimal128.fromString(toAmount), type: 'convert_in', refType: 'conversion', refId: conversion[0]!._id, balanceAfter: credited.available },
    ], { session, ordered: true });
    return { id: String(conversion[0]!._id), fromAsset: quote.fromAsset, toAsset: quote.toAsset, fromAmount, toAmount, status: 'completed' };
  });
}
