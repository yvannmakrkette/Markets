import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ApiError } from '../../core/models';
import { WalletActivity, WalletLedgerEntry, WalletService } from '../../core/wallet.service';

type HistoryTab = 'activity' | 'ledger';
type ActivityFilter = 'all' | 'deposit' | 'withdrawal' | 'conversion';

@Component({
  selector: 'app-wallet-history',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink],
  templateUrl: './wallet-history.component.html',
  styleUrl: './wallet-history.component.scss',
})
export class WalletHistoryComponent {
  private wallet = inject(WalletService);
  protected tab = signal<HistoryTab>('activity');
  protected filter = signal<ActivityFilter>('all');
  protected activity = signal<WalletActivity[]>([]);
  protected ledger = signal<WalletLedgerEntry[]>([]);
  protected loading = signal(true);
  protected error = signal<string | null>(null);
  protected total = signal(0);
  protected page = signal(1);
  private readonly pageSize = 50;
  protected filteredActivity = () => this.activity();

  constructor() { void this.load(); }

  protected async selectTab(tab: HistoryTab) {
    if (this.tab() === tab) return;
    this.tab.set(tab);
    this.page.set(1);
    await this.load(1);
  }

  protected async load(page = this.page(), append = false) {
    this.loading.set(true);
    this.error.set(null);
    try {
      if (this.tab() === 'activity') {
        const filter = this.filter();
        const result = await this.wallet.history(page, this.pageSize, filter === 'all' ? undefined : filter);
        this.activity.set(append ? [...this.activity(), ...result.items] : result.items);
        this.total.set(result.total);
      } else {
        const result = await this.wallet.ledger(page, this.pageSize);
        this.ledger.set(append ? [...this.ledger(), ...result.items] : result.items);
        this.total.set(result.total);
      }
      this.page.set(page);
    } catch (error) { this.error.set((error as ApiError)?.message ?? 'Could not load wallet history. Try again.'); }
    finally { this.loading.set(false); }
  }

  protected loadMore() { void this.load(this.page() + 1, true); }

  protected label(kind: WalletActivity['kind']) {
    return kind.charAt(0).toUpperCase() + kind.slice(1);
  }

  protected selectFilter(filter: ActivityFilter) {
    this.filter.set(filter);
    this.activity.set([]);
    this.page.set(1);
    void this.load(1);
  }
}
