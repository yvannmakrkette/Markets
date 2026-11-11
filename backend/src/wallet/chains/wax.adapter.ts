import { randomInt } from 'node:crypto';
import { Types } from 'mongoose';
import { env } from '../../config/env';
import { WalletNetworkT, UserDepositInstructions } from '../../models/wallet';
import { ChainAdapter, DepositScanResult, NormalizedChainDeposit } from './adapter';

const WAX_ACCOUNT = /^[a-z1-5.]{1,12}$/;
const MAX_PAGES_PER_SCAN = 20;
const PAGE_SIZE = 100;
const HYPERION_MAX_SEQUENCE = '999999999999999999';

type HyperionAction = {
  act?: { account?: string; name?: string; data?: Record<string, unknown> };
  account?: string;
  name?: string;
  data?: Record<string, unknown>;
  block_num?: number;
  trx_id?: string;
  global_sequence?: number | string;
  irreversible?: boolean;
};

function validWaxAccount(value: string) {
  return WAX_ACCOUNT.test(value) && !value.endsWith('.');
}

export function generateWaxMemo() {
  return String(randomInt(1_000_000_000_000, 9_999_999_999_999));
}

function decimalQuantity(value: unknown) {
  if (typeof value !== 'string') return null;
  const match = /^(\d+)\.(\d{8}) WAX$/.exec(value.trim());
  if (!match) return null;
  // Keep decimal text; monetary values are never converted to a JS float.
  return `${BigInt(match[1]!).toString()}.${match[2]}`;
}

async function hyperionJson<T>(path: string, init?: RequestInit): Promise<T> {
  const base = env.WAX_HISTORY_API_URL.replace(/\/+$/, '');
  const response = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`WAX Hyperion request failed (${response.status})`);
  return (await response.json()) as T;
}

async function getIrreversibleBlock() {
  const info = await hyperionJson<{ last_irreversible_block_num?: number }>('/v1/chain/get_info', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (!Number.isSafeInteger(info.last_irreversible_block_num) || !info.last_irreversible_block_num) {
    throw new Error('WAX Hyperion response did not include last_irreversible_block_num');
  }
  return info.last_irreversible_block_num;
}

export class WaxAdapter implements ChainAdapter {
  readonly implemented = true;
  validateAddress(address: string, memo?: string) {
    return validWaxAccount(address) && (!memo || /^\d+$/.test(memo));
  }

  async getDepositInstructions(userId: Types.ObjectId, network: WalletNetworkT) {
    const account = network.depositAccountOrXpub ?? '';
    if (!validWaxAccount(account)) throw new Error('WAX deposit account is not configured with a valid account name');
    const existing = await UserDepositInstructions.findOne({ userId, networkId: network._id }).lean();
    if (existing) return { address: account, memo: existing.memo ?? undefined };

    // Random, non-sequential numeric memo; the unique DB index is the final collision guard.
    for (let attempt = 0; attempt < 5; attempt++) {
      const memo = generateWaxMemo();
      try {
        await UserDepositInstructions.create({ userId, networkId: network._id, address: account, memo });
        return { address: account, memo };
      } catch (error) {
        const duplicate = (error as { code?: number }).code === 11000;
        if (!duplicate) throw error;
        const raced = await UserDepositInstructions.findOne({ userId, networkId: network._id }).lean();
        if (raced) return { address: account, memo: raced.memo ?? undefined };
      }
    }
    throw new Error('Could not allocate a unique WAX deposit memo');
  }

  async scanDeposits(network: WalletNetworkT, sinceCursor: string): Promise<DepositScanResult> {
    const account = network.depositAccountOrXpub ?? '';
    if (!validWaxAccount(account)) throw new Error('WAX deposit account is not configured');
    const lib = await getIrreversibleBlock();
    let cursor = BigInt(sinceCursor || '0');
    const deposits: NormalizedChainDeposit[] = [];

    // A bounded global-sequence range supports ascending pagination in Hyperion.
    for (let page = 0; page < MAX_PAGES_PER_SCAN; page++) {
      const params = new URLSearchParams({
        account,
        filter: `${network.contractOrToken}:transfer`,
        transfer_to: account,
        global_sequence: `${cursor + 1n}-${HYPERION_MAX_SEQUENCE}`,
        sort: 'asc',
        limit: String(PAGE_SIZE),
        simple: 'true',
        checkLib: 'true',
        noBinary: 'true',
      });
      const result = await hyperionJson<{ actions?: HyperionAction[] }>(`/v2/history/get_actions?${params}`);
      const actions = result.actions ?? [];
      if (actions.length === 0) break;
      for (const row of actions) {
        const act = row.act ?? row;
        const data = act.data ?? row.data ?? {};
        const seqValue = row.global_sequence;
        if (seqValue === undefined || seqValue === null) continue;
        const sequence = BigInt(String(seqValue));
        if (sequence > cursor) cursor = sequence;
        const amount = decimalQuantity(data['quantity']);
        const blockNum = Number(row.block_num);
        const irreversible = row.irreversible === true || (Number.isSafeInteger(blockNum) && blockNum <= lib);
        if (
          act.account !== network.contractOrToken ||
          act.name !== 'transfer' ||
          data['to'] !== account ||
          typeof row.trx_id !== 'string' ||
          !Number.isSafeInteger(blockNum) ||
          !amount
        ) continue;
        deposits.push({
          txHash: row.trx_id,
          actionSeqOrLogIndex: String(seqValue),
          from: typeof data['from'] === 'string' ? data['from'] : '',
          toAccountOrAddress: account,
          memo: typeof data['memo'] === 'string' ? data['memo'] : '',
          amount,
          blockNum,
          confirmations: irreversible ? Math.max(1, lib - blockNum + 1) : 0,
          irreversible,
        });
      }
      if (actions.length < PAGE_SIZE) break;
    }
    return { deposits, nextCursor: cursor.toString() };
  }

  async getConfirmations(txHash: string) {
    const tx = await hyperionJson<{
      traces?: Array<{ block_num?: number }>;
      actions?: Array<{ block_num?: number }>;
      block_num?: number;
    }>(`/v2/history/get_transaction?id=${encodeURIComponent(txHash)}`);
    const blockNum = [...(tx.actions ?? []), ...(tx.traces ?? [])]
      .map((action) => Number(action.block_num))
      .find(Number.isSafeInteger) ?? Number(tx.block_num);
    if (!blockNum) return 0;
    const lib = await getIrreversibleBlock();
    return blockNum <= lib ? Math.max(1, lib - blockNum + 1) : 0;
  }

  explorerTxUrl(txHash: string, network: WalletNetworkT) {
    return network.explorerTxUrlTemplate.replace('{txHash}', encodeURIComponent(txHash));
  }
}

export const waxAdapter = new WaxAdapter();
