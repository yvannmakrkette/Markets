import { Routes } from '@angular/router';
import { adminGuard, authGuard } from './core/guards';

export const routes: Routes = [
  { path: '', pathMatch: 'full', loadComponent: () => import('./features/landing/landing.component').then((m) => m.LandingComponent), title: 'Y2 Markets: Where Ambition Meets Opportunity' },
  { path: 'legal/:doc', loadComponent: () => import('./features/landing/legal.component').then((m) => m.LegalComponent), title: 'Legal · Y2 Markets' },
  { path: 'verify-email', loadComponent: () => import('./features/landing/verify-email.component').then((m) => m.VerifyEmailComponent), title: 'Verify e-mail · Y2 Markets' },
  {
    path: 'app',
    canActivate: [authGuard],
    loadComponent: () => import('./features/terminal/shell.component').then((m) => m.ShellComponent),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'trading' },
      { path: 'trading', loadComponent: () => import('./features/trading/trading.component').then((m) => m.TradingComponent), title: 'Trading · Y2 Markets' },
      { path: 'cfd', loadComponent: () => import('./features/trading/cfd.component').then((m) => m.CfdComponent), title: 'CFD Trading · Y2 Markets' },
      { path: 'finance', loadChildren: () => import('./features/finance/finance.routes').then((m) => m.FINANCE_ROUTES) },
      { path: 'wallet', loadChildren: () => import('./features/wallet/wallet.routes').then((m) => m.WALLET_ROUTES) },
      { path: 'profile', loadComponent: () => import('./features/profile/profile.component').then((m) => m.ProfileComponent), title: 'Profile · Y2 Markets' },
      { path: 'referrals', loadComponent: () => import('./features/referrals/referrals.component').then((m) => m.ReferralsComponent), title: 'Referrals · Y2 Markets' },
      { path: 'tournaments', loadComponent: () => import('./features/tournaments/tournaments.component').then((m) => m.TournamentsComponent), title: 'Tournaments · Y2 Markets' },
      { path: 'history', loadComponent: () => import('./features/history/history.component').then((m) => m.HistoryComponent), title: 'History · Y2 Markets' },
      { path: 'help', loadComponent: () => import('./features/help/help.component').then((m) => m.HelpComponent), title: 'Help · Y2 Markets' },
    ],
  },
  { path: 'wallet/deposit', pathMatch: 'full', redirectTo: 'app/wallet/deposit' },
  { path: 'wallet/:page', pathMatch: 'full', redirectTo: 'app/wallet/:page' },
  { path: 'wallet', pathMatch: 'full', redirectTo: 'app/wallet' },
  { path: 'admin/wallet', canActivate: [adminGuard], loadComponent: () => import('./features/admin/admin-wallet.component').then((m) => m.AdminWalletComponent), title: 'Wallet operations · Y2 Markets' },
  {
    path: 'admin',
    canActivate: [adminGuard],
    loadComponent: () => import('./features/admin/admin.component').then((m) => m.AdminComponent),
    title: 'Admin · Y2 Markets',
  },
  { path: '**', redirectTo: '' },
];
