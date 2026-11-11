import { Injectable, inject } from '@angular/core';
import { ApiService } from './api.service';

export interface WalletNetworkOption {
  id?: string;
  assetSymbol?: string;
  code: string;
  memoRequired: boolean;
  minWithdraw?: string;
  withdrawFee?: string;
}

export interface WalletAssetOption {
  symbol: string;
  name: string;
  decimals: number;
  iconUrl: string | null;
  networks: WalletNetworkOption[];
}

export interface WalletBalance {
  assetSymbol: string;
  name: string;
  decimals: number;
  iconUrl: string | null;
  enabled: boolean;
  available: string;
  locked: string;
  networks: WalletNetworkOption[];
}

export type WalletActivityKind = 'deposit' | 'withdrawal' | 'conversion' | 'adjustment';

export interface WalletActivity {
  id: string;
  kind: WalletActivityKind;
  assetSymbol: string;
  networkCode: string;
  amount: string;
  detail: string | null;
  status: string;
  reference: string;
  explorerTxUrl: string | null;
  createdAt: string;
}

export interface WalletPage<T> {
  page: number;
  limit: number;
  total: number;
  items: T[];
}

export interface WalletLedgerEntry {
  id: string;
  assetSymbol: string;
  type: string;
  amount: string;
  balanceAfter: string;
  refType: string;
  refId: string;
  createdAt: string;
}

export interface WalletDepositInstructions {
  asset: { symbol: string; name: string; decimals: number };
  network: { code: string; confirmationsRequired: number; explorerTxUrlTemplate: string };
  address: string | null;
  memo: string | null;
  memoRequired: boolean;
  minimumDeposit: string;
  warnings: string[];
  qrPayload: string;
}

export interface WalletWithdrawalRecord {
  id: string;
  assetSymbol: string;
  networkCode: string;
  toAddress: string;
  amount: string;
  fee: string;
  netAmount: string;
  status: string;
  txHash: string | null;
  rejectReason: string | null;
  createdAt: string;
}

export interface WalletQuote {
  quoteId: string;
  fromAsset: string;
  toAsset: string;
  fromAmount: string;
  toAmount: string;
  rate: string;
  feeAmount: string;
  spreadBps: number;
  expiresAt: string;
}

@Injectable({ providedIn: 'root' })
export class WalletService {
  private api = inject(ApiService);

  assets() {
    return this.api.get<WalletAssetOption[]>('/wallet/assets');
  }

  balances() {
    return this.api.get<WalletBalance[]>('/wallet/balances');
  }

  history(page = 1, limit = 50, kind?: WalletActivityKind) {
    return this.api.get<WalletPage<WalletActivity>>(`/wallet/history?page=${page}&limit=${limit}${kind ? `&kind=${kind}` : ''}`);
  }

  ledger(page = 1, limit = 50) {
    return this.api.get<WalletPage<WalletLedgerEntry>>(`/wallet/ledger?page=${page}&limit=${limit}`);
  }

  deposits(page = 1, limit = 50) {
    return this.api.get<WalletPage<WalletDepositRecord>>(`/wallet/deposits?page=${page}&limit=${limit}`);
  }

  quote(fromAsset: string, toAsset: string, amount: string) {
    return this.api.post<WalletQuote>('/wallet/quote', { fromAsset, toAsset, amount });
  }

  convert(quoteId: string) {
    return this.api.post<{ id: string; fromAsset: string; toAsset: string; fromAmount: string; toAmount: string; status: string }>('/wallet/convert', { quoteId });
  }

  withdrawals(page = 1, limit = 50) {
    return this.api.get<WalletPage<WalletWithdrawalRecord>>(`/wallet/withdrawals?page=${page}&limit=${limit}`);
  }

  requestWithdrawal(input: { networkId: string; amount: string; toAddress: string; memo?: string; twoFactorCode?: string }) {
    return this.api.post<WalletWithdrawalRecord>('/wallet/withdrawals', input);
  }

  depositInstructions(assetSymbol: string, networkCode: string) {
    return this.api.get<WalletDepositInstructions>(`/wallet/deposit/${encodeURIComponent(assetSymbol)}/${encodeURIComponent(networkCode)}`);
  }
}

export interface WalletDepositRecord {
  id: string;
  assetSymbol: string;
  networkCode: string;
  amount: string;
  status: string;
  txHash: string;
  explorerTxUrl: string | null;
  confirmations: number;
  detectedAt: string;
  creditedAt: string | null;
}
