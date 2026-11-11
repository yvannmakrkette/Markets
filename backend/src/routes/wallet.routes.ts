import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { ah, param, parse } from '../lib/http';
import { requireAuth, uid } from '../middleware/auth';
import { isTest } from '../config/env';
import { getDepositInstructions, getWalletBalances, getWalletDeposits, getWalletHistory, getWalletLedger, listEnabledWalletAssets } from '../wallet/deposit.service';
import { createWalletQuote, executeWalletConversion } from '../wallet/conversion.service';
import { createWalletWithdrawal, listWalletWithdrawals } from '../wallet/withdrawal.service';

export const walletRouter = Router();
const walletLimiter = rateLimit({ windowMs: 60_000, limit: 90, standardHeaders: 'draft-7', legacyHeaders: false, skip: () => isTest });
walletRouter.use(requireAuth, walletLimiter);

walletRouter.get('/assets', ah(async (_req, res) => {
  res.json(await listEnabledWalletAssets());
}));

const pageQuery = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(50) });

walletRouter.get('/balances', ah(async (req, res) => {
  res.json(await getWalletBalances(uid(req)));
}));

walletRouter.get('/deposits', ah(async (req, res) => {
  const paging = parse(pageQuery, req.query);
  res.json(await getWalletDeposits(uid(req), paging));
}));

walletRouter.get('/ledger', ah(async (req, res) => {
  const paging = parse(pageQuery, req.query);
  res.json(await getWalletLedger(uid(req), paging));
}));

walletRouter.get('/history', ah(async (req, res) => {
  const input = parse(pageQuery.extend({ kind: z.enum(['deposit', 'withdrawal', 'conversion', 'adjustment']).optional() }), req.query);
  res.json(await getWalletHistory(uid(req), input, input.kind));
}));

walletRouter.post('/quote', ah(async (req, res) => {
  const input = parse(z.object({ fromAsset: z.string().trim().regex(/^[A-Za-z0-9]{2,12}$/), toAsset: z.string().trim().regex(/^[A-Za-z0-9]{2,12}$/), amount: z.string().trim().regex(/^\d+(?:\.\d+)?$/).max(80) }), req.body);
  res.json(await createWalletQuote(uid(req), input.fromAsset, input.toAsset, input.amount));
}));

walletRouter.post('/convert', ah(async (req, res) => {
  const input = parse(z.object({ quoteId: z.string().regex(/^[a-f\d]{24}$/i) }), req.body);
  res.json(await executeWalletConversion(uid(req), input.quoteId));
}));

walletRouter.post('/withdrawals', ah(async (req, res) => {
  const input = parse(z.object({ networkId: z.string().regex(/^[a-f\d]{24}$/i), amount: z.string().trim().regex(/^\d+(?:\.\d+)?$/).max(80), toAddress: z.string().trim().min(1).max(200), memo: z.string().trim().max(200).optional(), twoFactorCode: z.string().trim().regex(/^\d{6}$/).optional() }), req.body);
  res.status(201).json(await createWalletWithdrawal(uid(req), input, req.ip));
}));

walletRouter.get('/withdrawals', ah(async (req, res) => {
  const paging = parse(pageQuery, req.query);
  res.json(await listWalletWithdrawals(uid(req), paging));
}));

walletRouter.get(
  '/deposit/:assetSymbol/:networkCode',
  ah(async (req, res) => {
    const input = parse(z.object({
      assetSymbol: z.string().trim().regex(/^[A-Za-z0-9]{2,12}$/),
      networkCode: z.string().trim().regex(/^[A-Za-z0-9_-]{2,20}$/),
    }), { assetSymbol: param(req, 'assetSymbol'), networkCode: param(req, 'networkCode') });
    res.json(await getDepositInstructions(uid(req), input.assetSymbol, input.networkCode));
  }),
);
