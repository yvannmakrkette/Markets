import { env } from '../config/env';
import { createLogger } from '../lib/logger';
import { scanWalletDepositsOnce } from './deposit.service';

const log = createLogger('wallet-deposits');
let running = false;

export function startWalletDepositWorker() {
  const scan = async () => {
    if (running) return;
    running = true;
    try {
      await scanWalletDepositsOnce();
    } catch (error) {
      log.error('deposit scan failed', error);
    } finally {
      running = false;
    }
  };
  void scan();
  setInterval(() => void scan(), env.DEPOSIT_SCAN_INTERVAL_MS).unref();
  log.info(`wallet deposit scanner enabled (interval ${env.DEPOSIT_SCAN_INTERVAL_MS}ms)`);
}
