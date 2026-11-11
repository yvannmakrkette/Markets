import http from 'node:http';
import { env } from './config/env';
import { createLogger } from './lib/logger';
import { connectMongo, disconnectMongo } from './db/mongo';
import { bootstrap } from './bootstrap';
import { createApp, corsOrigins } from './app';
import { initSockets } from './realtime/socket';
import { marketHub } from './market/market-hub';
import { startSettlementWorker } from './trading/trade.service';
import { startSentimentWorker } from './trading/sentiment';
import { startPendingWorker } from './trading/pending.service';
import { startCfdWorker } from './trading/cfd.service';
import { startDepositReconciler } from './finance/deposit.service';
import { startSignalEngine } from './signals/signal.engine';
import { startTournamentWorker } from './tournaments/tournament.service';
import { registerCopyTrading } from './social/copy.service';
import { startWalletDepositWorker } from './wallet/deposit.worker';
import { closeEvmProviders } from './wallet/chains/evm.adapter';

const log = createLogger('server');

async function main() {
  await connectMongo();
  await bootstrap();

  const app = createApp();
  const server = http.createServer(app);
  initSockets(server, corsOrigins);

  await marketHub.start();
  registerCopyTrading();
  startSettlementWorker();
  startSentimentWorker();
  startPendingWorker();
  startCfdWorker();
  startDepositReconciler();
  startSignalEngine();
  startTournamentWorker();
  startWalletDepositWorker();

  server.listen(env.PORT, () => log.info(`API ready on http://localhost:${env.PORT}  (env: ${env.NODE_ENV})`));

  const shutdown = async (signal: string) => {
    log.info(`${signal} received, shutting down`);
    server.close();
    await marketHub.stop().catch(() => undefined);
    await closeEvmProviders().catch(() => undefined);
    await disconnectMongo().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  log.error('fatal startup error', e);
  process.exit(1);
});
