import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { ApiError } from '../../core/models';
import { ToastService } from '../../core/toast.service';

type AdminWalletAsset = { symbol: string; name: string; decimals: number; enabled: boolean; priceFeedId?: string; iconUrl?: string };
type AdminWalletNetwork = { _id: string; assetSymbol: string; networkCode: string; chainType: string; depositModel: string; depositAccountOrXpub?: string; contractOrToken: string; memoRequired: boolean; minDeposit: string; minWithdraw: string; withdrawFee: string; confirmationsRequired: number; explorerTxUrlTemplate: string; depositStartBlock?: number; enabled: boolean };
type AdminWalletWithdrawal = { id: string; userId: string; username?: string; email?: string; assetSymbol: string; networkCode: string; toAddress: string; memo: string | null; amount: string; fee: string; netAmount: string; status: string; txHash: string | null };
type UnmatchedDeposit = { id: string; userId: string | null; assetSymbol: string; networkCode: string; txHash: string; memo: string; amount: string; from: string; detectedAt: string };

@Component({
  selector: 'app-admin-wallet', changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink], templateUrl: './admin-wallet.component.html', styleUrl: './admin-wallet.component.scss',
})
export class AdminWalletComponent {
  private api = inject(ApiService); private toast = inject(ToastService);
  protected tab = signal('assets'); protected busy = signal(false); protected error = signal<string | null>(null);
  protected assets = signal<AdminWalletAsset[]>([]); protected networks = signal<AdminWalletNetwork[]>([]);
  protected assetEdit = signal<string | null>(null); protected networkEdit = signal<string | null>(null);
  protected unmatched = signal<UnmatchedDeposit[]>([]); protected withdrawals = signal<AdminWalletWithdrawal[]>([]);
  protected rates = signal<{ assetSymbol: string; usdPrice: string }[]>([]); protected audit = signal<Record<string, unknown>[]>([]);
  protected adjustForm = new FormGroup({ userId: new FormControl('', { nonNullable: true, validators: [Validators.required] }), assetSymbol: new FormControl('', { nonNullable: true, validators: [Validators.required] }), amount: new FormControl('', { nonNullable: true, validators: [Validators.required] }), note: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.minLength(3)] }) });
  protected assetForm = new FormGroup({ symbol: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.pattern(/^[A-Za-z0-9]{2,12}$/)] }), name: new FormControl('', { nonNullable: true, validators: [Validators.required] }), decimals: new FormControl(8, { nonNullable: true, validators: [Validators.required, Validators.min(0), Validators.max(30)] }), iconUrl: new FormControl('', { nonNullable: true }), priceFeedId: new FormControl('', { nonNullable: true }), enabled: new FormControl(false, { nonNullable: true }) });
  protected networkForm = new FormGroup({ assetSymbol: new FormControl('', { nonNullable: true, validators: [Validators.required] }), networkCode: new FormControl('', { nonNullable: true, validators: [Validators.required] }), chainType: new FormControl('eosio', { nonNullable: true }), contractOrToken: new FormControl('eosio.token', { nonNullable: true, validators: [Validators.required] }), depositModel: new FormControl('memo', { nonNullable: true }), depositAccountOrXpub: new FormControl('', { nonNullable: true }), memoRequired: new FormControl(true, { nonNullable: true }), minDeposit: new FormControl('0.00000001', { nonNullable: true }), minWithdraw: new FormControl('1', { nonNullable: true }), withdrawFee: new FormControl('0.1', { nonNullable: true }), confirmationsRequired: new FormControl(1, { nonNullable: true }), explorerTxUrlTemplate: new FormControl('https://waxblock.io/transaction/{txHash}', { nonNullable: true }), depositStartBlock: new FormControl(0, { nonNullable: true }), enabled: new FormControl(false, { nonNullable: true }) });
  protected rateForm = new FormGroup({ assetSymbol: new FormControl('', { nonNullable: true, validators: [Validators.required] }), usdPrice: new FormControl('', { nonNullable: true, validators: [Validators.required] }) });
  protected assignTo = signal<Record<string, string>>({}); protected notes = signal<Record<string, string>>({}); protected txHashes = signal<Record<string, string>>({});
  protected tabs = [{ id: 'assets', label: 'Assets & networks' }, { id: 'unmatched', label: 'Unmatched deposits' }, { id: 'withdrawals', label: 'Withdrawals' }, { id: 'rates', label: 'Price rates' }, { id: 'adjust', label: 'Balance adjustment' }, { id: 'audit', label: 'Audit log' }];

  constructor() { void this.loadAll(); }

  protected async loadAll() {
    this.busy.set(true); this.error.set(null);
    try {
      const [assets, networks, unmatched, withdrawals, rates, audit] = await Promise.all([
        this.api.get<AdminWalletAsset[]>('/admin/wallet/assets'), this.api.get<AdminWalletNetwork[]>('/admin/wallet/networks'),
        this.api.get<{ items: UnmatchedDeposit[] }>('/admin/wallet/deposits/unmatched'), this.api.get<AdminWalletWithdrawal[]>('/admin/wallet/withdrawals'),
        this.api.get<{ assetSymbol: string; usdPrice: string }[]>('/admin/wallet/rates'), this.api.get<{ items: Record<string, unknown>[] }>('/admin/wallet/audit'),
      ]);
      this.assets.set(assets); this.networks.set(networks); this.unmatched.set(unmatched.items); this.withdrawals.set(withdrawals); this.rates.set(rates); this.audit.set(audit.items);
    } catch (error) { this.error.set((error as ApiError)?.message ?? 'Could not load wallet administration.'); }
    finally { this.busy.set(false); }
  }

  protected async run(fn: () => Promise<unknown>, message: string) {
    this.busy.set(true); this.error.set(null);
    try { await fn(); this.toast.success(message); await this.loadAll(); }
    catch (error) { this.error.set((error as ApiError)?.message ?? 'Wallet admin action failed.'); }
    finally { this.busy.set(false); }
  }

  protected async createAsset() {
    if (this.assetForm.invalid) return this.assetForm.markAllAsTouched();
    const f = this.assetForm.getRawValue();
    if (this.assetEdit()) await this.run(() => this.api.patch(`/admin/wallet/assets/${f.symbol.toUpperCase()}`, { name: f.name, iconUrl: f.iconUrl, priceFeedId: f.priceFeedId, enabled: f.enabled }), 'Wallet asset updated');
    else await this.run(() => this.api.post('/admin/wallet/assets', { ...f, symbol: f.symbol.toUpperCase() }), 'Wallet asset created');
    this.cancelAssetEdit();
  }
  protected editAsset(asset: AdminWalletAsset) { this.assetEdit.set(asset.symbol); this.assetForm.setValue({ symbol: asset.symbol, name: asset.name, decimals: asset.decimals, iconUrl: asset.iconUrl ?? '', priceFeedId: asset.priceFeedId ?? '', enabled: asset.enabled }); }
  protected cancelAssetEdit() { this.assetEdit.set(null); this.assetForm.reset({ symbol: '', name: '', decimals: 8, iconUrl: '', priceFeedId: '', enabled: false }); }
  protected async setAsset(asset: AdminWalletAsset, enabled: boolean) { await this.run(() => this.api.patch(`/admin/wallet/assets/${asset.symbol}`, { enabled }), `${asset.symbol} ${enabled ? 'enabled' : 'disabled'}`); }
  protected async deleteAsset(asset: AdminWalletAsset) { await this.run(() => this.api.delete(`/admin/wallet/assets/${asset.symbol}`), `${asset.symbol} removed`); }
  protected async createNetwork() {
    if (this.networkForm.invalid) return this.networkForm.markAllAsTouched();
    const f = this.networkForm.getRawValue();
    const body = { ...f, assetSymbol: f.assetSymbol.toUpperCase(), networkCode: f.networkCode.toUpperCase(), confirmationsRequired: Number(f.confirmationsRequired), depositStartBlock: Number(f.depositStartBlock) };
    if (this.networkEdit()) await this.run(() => this.api.patch(`/admin/wallet/networks/${this.networkEdit()}`, body), 'Network updated');
    else await this.run(() => this.api.post('/admin/wallet/networks', body), 'Network created');
    this.cancelNetworkEdit();
  }
  protected editNetwork(network: AdminWalletNetwork) { this.networkEdit.set(network._id); this.networkForm.setValue({ assetSymbol: network.assetSymbol, networkCode: network.networkCode, chainType: network.chainType, contractOrToken: network.contractOrToken, depositModel: network.depositModel, depositAccountOrXpub: network.depositAccountOrXpub ?? '', memoRequired: network.memoRequired, minDeposit: network.minDeposit, minWithdraw: network.minWithdraw, withdrawFee: network.withdrawFee, confirmationsRequired: network.confirmationsRequired, explorerTxUrlTemplate: network.explorerTxUrlTemplate, depositStartBlock: network.depositStartBlock ?? 0, enabled: network.enabled }); }
  protected cancelNetworkEdit() { this.networkEdit.set(null); this.networkForm.reset({ assetSymbol: '', networkCode: '', chainType: 'eosio', contractOrToken: 'eosio.token', depositModel: 'memo', depositAccountOrXpub: '', memoRequired: true, minDeposit: '0.00000001', minWithdraw: '1', withdrawFee: '0.1', confirmationsRequired: 1, explorerTxUrlTemplate: 'https://waxblock.io/transaction/{txHash}', depositStartBlock: 0, enabled: false }); }
  protected async setNetwork(network: AdminWalletNetwork, enabled: boolean) { await this.run(() => this.api.patch(`/admin/wallet/networks/${network._id}`, { enabled }), `${network.networkCode} ${enabled ? 'enabled' : 'disabled'}`); }
  protected async deleteNetwork(network: AdminWalletNetwork) { await this.run(() => this.api.delete(`/admin/wallet/networks/${network._id}`), `${network.networkCode} removed`); }
  protected async setRate() {
    if (this.rateForm.invalid) return this.rateForm.markAllAsTouched();
    const f = this.rateForm.getRawValue();
    await this.run(() => this.api.put(`/admin/wallet/rates/${f.assetSymbol.toUpperCase()}`, { usdPrice: f.usdPrice }), 'Fallback price rate saved');
  }
  protected async deleteRate(symbol: string) { await this.run(() => this.api.delete(`/admin/wallet/rates/${symbol}`), `${symbol} fallback rate removed`); }
  protected setAssign(id: string, value: string) { this.assignTo.update((values) => ({ ...values, [id]: value })); }
  protected setNote(id: string, value: string) { this.notes.update((values) => ({ ...values, [id]: value })); }
  protected setTx(id: string, value: string) { this.txHashes.update((values) => ({ ...values, [id]: value })); }
  protected async assign(deposit: UnmatchedDeposit) { const userId = this.assignTo()[deposit.id]?.trim(); if (!userId) return this.toast.error('Enter the user ID to assign this deposit.'); await this.run(() => this.api.post(`/admin/wallet/deposits/${deposit.id}/assign`, { userId }), 'Deposit credited to the selected user'); }
  protected async rejectDeposit(deposit: UnmatchedDeposit) { const note = this.notes()[deposit.id]?.trim(); if (!note) return this.toast.error('Enter a rejection note.'); await this.run(() => this.api.post(`/admin/wallet/deposits/${deposit.id}/reject`, { note }), 'Unmatched deposit rejected'); }
  protected async withdrawalAction(row: AdminWalletWithdrawal, action: 'approve' | 'reject' | 'broadcast' | 'complete') {
    const body = action === 'reject' ? { note: this.notes()[row.id] ?? '' } : ['broadcast', 'complete'].includes(action) ? { txHash: this.txHashes()[row.id] ?? '' } : {};
    await this.run(() => this.api.post(`/admin/wallet/withdrawals/${row.id}/${action}`, body), `Withdrawal ${action} action saved`);
  }
  protected async adjust() { if (this.adjustForm.invalid) return this.adjustForm.markAllAsTouched(); await this.run(() => this.api.post('/admin/wallet/balances/adjust', this.adjustForm.getRawValue()), 'Wallet balance adjustment recorded'); this.adjustForm.reset(); }
  protected fmt(value: unknown) { return JSON.stringify(value, null, 2); }
}
