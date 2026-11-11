import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { QRCodeComponent } from 'angularx-qrcode';
import { ApiError } from '../../core/models';
import { ToastService } from '../../core/toast.service';
import { WalletAssetOption, WalletDepositInstructions, WalletService } from '../../core/wallet.service';
import { IconComponent } from '../../shared/icon.component';

@Component({
  selector: 'app-wallet-deposit',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, QRCodeComponent, IconComponent],
  templateUrl: './wallet-deposit.component.html',
  styleUrl: './wallet-deposit.component.scss',
})
export class WalletDepositComponent {
  private wallet = inject(WalletService);
  private toast = inject(ToastService);
  private destroyRef = inject(DestroyRef);
  private route = inject(ActivatedRoute);

  protected assetControl = new FormControl('', { nonNullable: true });
  protected networkControl = new FormControl('', { nonNullable: true });
  protected assets = signal<WalletAssetOption[]>([]);
  protected instructions = signal<WalletDepositInstructions | null>(null);
  protected loadingAssets = signal(true);
  protected loadingInstructions = signal(false);
  protected error = signal<string | null>(null);
  protected selectedAsset = signal<WalletAssetOption | null>(null);
  protected networks = () => this.selectedAsset()?.networks ?? [];

  constructor() {
    this.assetControl.valueChanges.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((symbol) => {
      const asset = this.assets().find((item) => item.symbol === symbol) ?? null;
      this.selectedAsset.set(asset);
      const network = asset?.networks[0];
      this.instructions.set(null);
      this.networkControl.setValue(network?.code ?? '');
    });
    this.networkControl.valueChanges.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((code) => {
      const symbol = this.assetControl.value;
      if (symbol && code) void this.loadInstructions(symbol, code);
    });
    void this.loadAssets();
  }

  private async loadAssets() {
    this.loadingAssets.set(true);
    this.error.set(null);
    try {
      const assets = await this.wallet.assets();
      this.assets.set(assets);
      const requested = this.route.snapshot.queryParamMap.get('asset')?.toUpperCase();
      const selected = assets.find((asset) => asset.symbol === requested && asset.networks.length > 0)
        ?? assets.find((asset) => asset.networks.length > 0);
      if (selected) this.assetControl.setValue(selected.symbol);
    } catch (error) {
      this.error.set((error as ApiError)?.message ?? 'Could not load wallet assets. Try again.');
    } finally {
      this.loadingAssets.set(false);
    }
  }

  private async loadInstructions(symbol: string, networkCode: string) {
    this.loadingInstructions.set(true);
    this.error.set(null);
    this.instructions.set(null);
    try {
      this.instructions.set(await this.wallet.depositInstructions(symbol, networkCode));
    } catch (error) {
      this.error.set((error as ApiError)?.message ?? 'Could not load deposit instructions. Try again.');
    } finally {
      this.loadingInstructions.set(false);
    }
  }

  protected retry() {
    if (this.assets().length) void this.loadInstructions(this.assetControl.value, this.networkControl.value);
    else void this.loadAssets();
  }

  protected async copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      this.toast.success(`${label} copied`);
    } catch {
      this.toast.error('Clipboard access is unavailable in this browser.');
    }
  }
}
