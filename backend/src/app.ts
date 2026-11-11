import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from './config/env';
import { apiLimiter } from './middleware/rate-limit';
import { errorHandler, notFoundHandler } from './middleware/error';
import { authRouter } from './routes/auth.routes';
import { meRouter } from './routes/me.routes';
import { marketRouter } from './routes/market.routes';
import { pendingRouter, tradesRouter } from './routes/trades.routes';
import { cfdRouter } from './routes/cfd.routes';
import { bonusRouter, financeRouter } from './routes/finance.routes';
import { paymentsRouter } from './routes/payments.routes';
import { chatRouter, kycRouter, referralRouter, signalsRouter, socialRouter, tournamentRouter } from './routes/community.routes';
import { adminRouter } from './routes/admin.routes';
import { walletRouter } from './routes/wallet.routes';
import { adminWalletRouter } from './routes/admin-wallet.routes';
import './models/wallet'; // Register wallet collections and indexes with the shared MongoDB bootstrap.

export const corsOrigins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);

export const isAllowedOrigin = (origin: string | undefined): boolean => {
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    if (/^(localhost|127\.|192\.168\.|0\.0\.0\.0)/.test(host)) return true;
    if (host.endsWith('.pages.dev') || host.endsWith('.workers.dev')) return true;
    if (host.endsWith('onrender.com') || host.endsWith('y2markets.site')) return true;
    if (corsOrigins.some((o) => origin === o || origin === o.replace(/\/$/, ''))) return true;
    return true;
  } catch {
    return true;
  }
};

export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // behind nginx / a load balancer
  app.disable('x-powered-by');
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(
    cors({
      origin: (origin, callback) => {
        if (isAllowedOrigin(origin)) callback(null, true);
        else callback(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
      exposedHeaders: ['Set-Cookie'],
    }),
  );
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

  // Payment provider callbacks are not rate limited (Safaricom retries aggressively).
  app.use('/api/payments', paymentsRouter);

  app.use('/api', apiLimiter);
  app.use('/api/auth', authRouter);
  app.use('/api/me', meRouter);
  app.use('/api/market', marketRouter);
  app.use('/api/trades', tradesRouter);
  app.use('/api/pending', pendingRouter);
  app.use('/api/cfd', cfdRouter);
  app.use('/api/finance', financeRouter);
  app.use('/api/wallet', walletRouter);
  app.use('/api/bonuses', bonusRouter);
  app.use('/api/referrals', referralRouter);
  app.use('/api/kyc', kycRouter);
  app.use('/api/chat', chatRouter);
  app.use('/api/tournaments', tournamentRouter);
  app.use('/api/signals', signalsRouter);
  app.use('/api/social', socialRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/admin/wallet', adminWalletRouter);

  app.use('/api', notFoundHandler);
  app.use(errorHandler);
  return app;
}
