import { Types } from 'mongoose';
import { WalletNetworkT } from '../../models/wallet';

export interface NormalizedChainDeposit {
  txHash: string;
  actionSeqOrLogIndex: string;
  from: string;
  toAccountOrAddress: string;
  memo?: string;
  amount: string;
  blockNum: number;
  confirmations: number;
  irreversible: boolean;
}

export interface DepositScanResult {
  deposits: NormalizedChainDeposit[];
  nextCursor: string;
}

export interface ChainAdapter {
  readonly implemented?: boolean;
  validateAddress(address: string, memo?: string): boolean;
  getDepositInstructions(userId: Types.ObjectId, network: WalletNetworkT): Promise<{ address?: string; memo?: string }>;
  scanDeposits(network: WalletNetworkT, sinceCursor: string): Promise<DepositScanResult>;
  getConfirmations(txHash: string, network?: WalletNetworkT): Promise<number>;
  explorerTxUrl(txHash: string, network: WalletNetworkT): string;
}
