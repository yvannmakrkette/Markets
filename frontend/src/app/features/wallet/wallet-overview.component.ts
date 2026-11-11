import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiError } from '../../core/models';
import { WalletBalance, WalletService } from '../../core/wallet.service';

@Component({
  selector: 'app-wallet-overview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './wallet-overview.component.html',
  styleUrl: './wallet-overview.component.scss',
})
export class WalletOverviewComponent {
  private wallet = inject(WalletService);
  protected balances = signal<WalletBalance[]>([]);
  protected loading = signal(true);
  protected error = signal<string | null>(null);

  constructor() { void this.load(); }

  protected async load() {
    this.loading.set(true);
    this.error.set(null);
    try { this.balances.set(await this.wallet.balances()); }
    catch (error) { this.error.set((error as ApiError)?.message ?? 'Could not load wallet balances. Try again.'); }
    finally { this.loading.set(false); }
  }
}
