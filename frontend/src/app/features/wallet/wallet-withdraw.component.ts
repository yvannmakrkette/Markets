import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiError } from '../../core/models';
import { WalletAssetOption, WalletBalance, WalletNetworkOption, WalletService, WalletWithdrawalRecord } from '../../core/wallet.service';

function decimalUnits(value: string, decimals: number): bigint {
  if (!/^(?:\d+)(?:\.\d*)?$/.test(value)) return 0n;
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(`${whole}${fraction}`) * 10n ** BigInt(Math.max(0, decimals - fraction.length)) / 10n ** BigInt(Math.max(0, fraction.length - decimals));
}
function displayUnits(value: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

@Component({
  selector: 'app-wallet-withdraw', changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink], templateUrl: './wallet-withdraw.component.html', styleUrl: './wallet-withdraw.component.scss',
})
export class WalletWithdrawComponent {
  private wallet = inject(WalletService);
  protected assets = signal<WalletAssetOption[]>([]);
  protected balances = signal<WalletBalance[]>([]);
  protected withdrawals = signal<WalletWithdrawalRecord[]>([]);
  protected loading = signal(true);
  protected busy = signal(false);
  protected error = signal<string | null>(null);
  protected stage = signal<'edit' | 'confirm'>('edit');
  protected success = signal<string | null>(null);
  protected assetSymbol = new FormControl('', { nonNullable: true });
  protected networkId = new FormControl('', { nonNullable: true });
  protected amount = new FormControl('', { nonNullable: true });
  protected toAddress = new FormControl('', { nonNullable: true });
  protected memo = new FormControl('', { nonNullable: true });
  protected twoFactorCode = new FormControl('', { nonNullable: true });
  protected networks = computed(() => this.assets().find((asset) => asset.symbol === this.assetSymbol.value)?.networks ?? []);
  protected selectedNetwork = computed(() => this.networks().find((network) => network.id === this.networkId.value) ?? null);
  protected selectedAsset = computed(() => this.assets().find((asset) => asset.symbol === this.assetSymbol.value) ?? null);
  protected balance = computed(() => this.balances().find((entry) => entry.assetSymbol === this.assetSymbol.value));

  constructor() {
    this.assetSymbol.valueChanges.subscribe((symbol) => {
      const networks = this.assets().find((asset) => asset.symbol === symbol)?.networks ?? [];
      this.networkId.setValue(networks[0]?.id ?? '');
      this.stage.set('edit');
    });
    void this.load();
  }

  private async load() {
    this.loading.set(true); this.error.set(null);
    try {
      const [assets, balances, withdrawals] = await Promise.all([this.wallet.assets(), this.wallet.balances(), this.wallet.withdrawals()]);
      this.assets.set(assets.filter((asset) => asset.networks.some((network) => network.id)));
      this.balances.set(balances);
      this.withdrawals.set(withdrawals.items);
      const first = this.assets()[0];
      if (first) this.assetSymbol.setValue(first.symbol);
    } catch (error) { this.error.set((error as ApiError)?.message ?? 'Could not load withdrawal details.'); }
    finally { this.loading.set(false); }
  }

  protected netPreview() {
    const network = this.selectedNetwork(); const asset = this.selectedAsset();
    if (!network || !asset || !network.withdrawFee) return '—';
    const amount = decimalUnits(this.amount.value.trim(), asset.decimals);
    const fee = decimalUnits(network.withdrawFee, asset.decimals);
    return displayUnits(amount > fee ? amount - fee : 0n, asset.decimals);
  }

  protected review() {
    const network = this.selectedNetwork(); const asset = this.selectedAsset();
    if (!network || !asset) return this.error.set('Choose a valid withdrawal network.');
    if (!/^(?:\d+)(?:\.\d+)?$/.test(this.amount.value.trim())) return this.error.set('Enter a valid decimal amount.');
    if (decimalUnits(this.amount.value.trim(), asset.decimals) < decimalUnits(network.minWithdraw ?? '0', asset.decimals)) return this.error.set(`Minimum withdrawal is ${network.minWithdraw} ${asset.symbol}.`);
    if (decimalUnits(this.amount.value.trim(), asset.decimals) <= decimalUnits(network.withdrawFee ?? '0', asset.decimals)) return this.error.set('Amount must be greater than the network fee.');
    if (!this.toAddress.value.trim()) return this.error.set('Enter the destination address.');
    if (network.memoRequired && !this.memo.value.trim()) return this.error.set('A destination memo/tag is required for this network.');
    this.error.set(null); this.stage.set('confirm');
  }

  protected async submit() {
    const network = this.selectedNetwork();
    if (!network?.id) return;
    this.busy.set(true); this.error.set(null); this.success.set(null);
    try {
      await this.wallet.requestWithdrawal({ networkId: network.id, amount: this.amount.value.trim(), toAddress: this.toAddress.value.trim(), memo: this.memo.value.trim() || undefined, twoFactorCode: this.twoFactorCode.value.trim() || undefined });
      this.success.set('Withdrawal requested. Funds are locked while an administrator reviews it.');
      this.stage.set('edit'); this.amount.setValue(''); this.toAddress.setValue(''); this.memo.setValue(''); this.twoFactorCode.setValue('');
      await this.load();
    } catch (error) { this.error.set((error as ApiError)?.message ?? 'Withdrawal could not be requested.'); }
    finally { this.busy.set(false); }
  }
}
