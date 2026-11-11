import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiError } from '../../core/models';
import { WalletAssetOption, WalletQuote, WalletService } from '../../core/wallet.service';

@Component({
  selector: 'app-wallet-convert', changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink], templateUrl: './wallet-convert.component.html', styleUrl: './wallet-convert.component.scss',
})
export class WalletConvertComponent {
  private wallet = inject(WalletService);
  private destroyRef = inject(DestroyRef);
  protected assets = signal<WalletAssetOption[]>([]);
  protected heldAssets = signal<WalletAssetOption[]>([]);
  protected quote = signal<WalletQuote | null>(null);
  protected loading = signal(false);
  protected error = signal<string | null>(null);
  protected success = signal<string | null>(null);
  protected tick = signal(Date.now());
  protected fromAsset = new FormControl('', { nonNullable: true });
  protected toAsset = new FormControl('', { nonNullable: true });
  protected amount = new FormControl('', { nonNullable: true });
  protected toOptions = () => this.assets().filter((asset) => asset.symbol !== this.fromAsset.value);
  protected countdown = () => Math.max(0, Math.ceil((new Date(this.quote()?.expiresAt ?? 0).getTime() - this.tick()) / 1000));

  constructor() {
    const timer = setInterval(() => this.tick.set(Date.now()), 500);
    this.destroyRef.onDestroy(() => clearInterval(timer));
    void this.loadAssets();
  }

  protected async loadAssets() {
    this.loading.set(true);
    try {
      const balances = await this.wallet.balances();
      const assets = await this.wallet.assets();
      this.assets.set(assets);
      this.heldAssets.set(assets.filter((asset) => balances.some((balance) => balance.assetSymbol === asset.symbol && balance.enabled && BigInt(balance.available.replace('.', '') || '0') > 0n)));
      this.fromAsset.setValue(this.heldAssets()[0]?.symbol ?? '');
      this.toAsset.setValue(this.assets().find((asset) => asset.symbol !== this.fromAsset.value)?.symbol ?? '');
    } catch (error) { this.error.set((error as ApiError)?.message ?? 'Could not load conversion assets.'); }
    finally { this.loading.set(false); }
  }

  protected async getQuote() {
    this.quote.set(null); this.error.set(null); this.success.set(null); this.loading.set(true);
    try { this.quote.set(await this.wallet.quote(this.fromAsset.value, this.toAsset.value, this.amount.value.trim())); }
    catch (error) { this.error.set((error as ApiError)?.message ?? 'Could not get a conversion quote.'); }
    finally { this.loading.set(false); }
  }

  protected async confirm() {
    const quote = this.quote();
    if (!quote || !this.countdown()) return;
    this.loading.set(true); this.error.set(null);
    try {
      const result = await this.wallet.convert(quote.quoteId);
      this.success.set(`Converted ${result.fromAmount} ${result.fromAsset} to ${result.toAmount} ${result.toAsset}.`);
      this.quote.set(null);
      this.amount.setValue('');
    } catch (error) { this.error.set((error as ApiError)?.message ?? 'Conversion could not be completed.'); this.quote.set(null); }
    finally { this.loading.set(false); }
  }
}
