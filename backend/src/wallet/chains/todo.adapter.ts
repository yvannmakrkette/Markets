import { WalletNetworkT } from '../../models/wallet';
import { AppError } from '../../lib/errors';
import { ChainAdapter, DepositScanResult } from './adapter';
import { Types } from 'mongoose';

/** Explicit placeholder for chains awaiting their own audited adapter implementation. */
export class TodoChainAdapter implements ChainAdapter {
  readonly implemented = false;
  constructor(private chain: string) {}
  validateAddress() { return false; }
  async getDepositInstructions(_userId: Types.ObjectId, _network: WalletNetworkT): Promise<{ address?: string; memo?: string }> {
    throw new AppError(501, 'CHAIN_NOT_IMPLEMENTED', `${this.chain} deposit adapter is a TODO and is not available yet`);
  }
  async scanDeposits(_network: WalletNetworkT, _sinceCursor: string): Promise<DepositScanResult> {
    throw new AppError(501, 'CHAIN_NOT_IMPLEMENTED', `${this.chain} deposit scanner is a TODO and is not available yet`);
  }
  async getConfirmations(_txHash: string, _network?: WalletNetworkT): Promise<number> {
    throw new AppError(501, 'CHAIN_NOT_IMPLEMENTED', `${this.chain} confirmation lookup is a TODO and is not available yet`);
  }
  explorerTxUrl(txHash: string, network: WalletNetworkT) { return network.explorerTxUrlTemplate.replace('{txHash}', encodeURIComponent(txHash)); }
}
