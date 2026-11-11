import { WalletNetworkT } from '../models/wallet';
import { ChainAdapter } from './chains/adapter';
import { waxAdapter } from './chains/wax.adapter';
import { evmAdapter } from './chains/evm.adapter';
import { TodoChainAdapter } from './chains/todo.adapter';

const todoAdapters = new Map(['tron', 'btc', 'xrp', 'stellar', 'ton'].map((chain) => [chain, new TodoChainAdapter(chain)]));

export function adapterForNetwork(network: WalletNetworkT): ChainAdapter | null {
  if (network.chainType === 'eosio') return waxAdapter;
  if (network.chainType === 'evm') return evmAdapter;
  return todoAdapters.get(network.chainType) ?? null;
}
