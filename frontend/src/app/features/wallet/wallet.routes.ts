import { Routes } from '@angular/router';

export const WALLET_ROUTES: Routes = [
  { path: '', pathMatch: 'full', loadComponent: () => import('./wallet-overview.component').then((m) => m.WalletOverviewComponent), title: 'Crypto wallet · Y2 Markets' },
  { path: 'deposit', loadComponent: () => import('./wallet-deposit.component').then((m) => m.WalletDepositComponent), title: 'Wallet deposits · Y2 Markets' },
  { path: 'convert', loadComponent: () => import('./wallet-convert.component').then((m) => m.WalletConvertComponent), title: 'Convert crypto · Y2 Markets' },
  { path: 'withdraw', loadComponent: () => import('./wallet-withdraw.component').then((m) => m.WalletWithdrawComponent), title: 'Withdraw crypto · Y2 Markets' },
  { path: 'history', loadComponent: () => import('./wallet-history.component').then((m) => m.WalletHistoryComponent), title: 'Wallet activity · Y2 Markets' },
];
