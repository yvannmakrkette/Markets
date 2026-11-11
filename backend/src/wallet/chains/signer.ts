import { WalletNetworkT } from '../../models/wallet';

export interface WalletSigner {
  /** Implementations live outside this server. The app must never load private keys or seed phrases. */
  broadcast(input: { network: WalletNetworkT; toAddress: string; memo?: string; amount: string }): Promise<{ txHash: string }>;
}

/** Deliberately unimplemented: admin operators submit transactions from a secured wallet and record the hash. */
export class ExternalWalletSigner implements WalletSigner {
  async broadcast(): Promise<{ txHash: string }> {
    throw new Error('Automated signing is not configured; send from an external secured wallet and record the transaction hash.');
  }
}
