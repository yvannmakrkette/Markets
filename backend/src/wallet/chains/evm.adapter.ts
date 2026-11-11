import { HDNodeWallet, JsonRpcProvider, getAddress, id } from 'ethers';
import { Types } from 'mongoose';
import { env } from '../../config/env';
import { WalletAsset, WalletNetwork, WalletNetworkT, UserDepositInstructions } from '../../models/wallet';
import { ChainAdapter, DepositScanResult, NormalizedChainDeposit } from './adapter';
import { fromAtomic } from '../money';

const TRANSFER_TOPIC = id('Transfer(address,address,uint256)');
const MAX_BLOCKS_PER_SCAN = 2000;
const ADDRESSES_PER_QUERY = 100;
const providers = new Map<string, JsonRpcProvider>();

export function evmRpcUrl(network: WalletNetworkT) {
  if (network.rpcConfigKey && network.rpcConfigKey !== 'EVM_RPC_URL') throw new Error(`Unsupported EVM RPC config key: ${network.rpcConfigKey}`);
  if (!env.EVM_RPC_URL) throw new Error('EVM_RPC_URL is required to scan EVM networks');
  return env.EVM_RPC_URL;
}

function providerFor(network: WalletNetworkT) {
  const url = evmRpcUrl(network);
  let provider = providers.get(url);
  if (!provider) { provider = new JsonRpcProvider(url); providers.set(url, provider); }
  return provider;
}

export async function closeEvmProviders() {
  await Promise.all([...providers.values()].map((provider) => provider.destroy()));
  providers.clear();
}

export class EvmAdapter implements ChainAdapter {
  readonly implemented = true;
  validateAddress(address: string) {
    try { getAddress(address); return true; } catch { return false; }
  }

  async getDepositInstructions(userId: Types.ObjectId, network: WalletNetworkT) {
    const existing = await UserDepositInstructions.findOne({ userId, networkId: network._id }).lean();
    if (existing) return { address: existing.address ?? undefined };
    const xpub = network.depositAccountOrXpub ?? '';
    if (!/^(xpub|ypub|zpub|tpub|upub|vpub)/.test(xpub)) throw new Error('EVM network requires a public extended key (xpub); private extended keys are not accepted');
    const root = HDNodeWallet.fromExtendedKey(xpub);
    if ('privateKey' in root) throw new Error('EVM deposit derivation accepts public keys only');
    for (let attempt = 0; attempt < 5; attempt++) {
      const allocation = await WalletNetwork.findOneAndUpdate({ _id: network._id, enabled: true }, { $inc: { nextDerivationIndex: 1 } }, { new: false });
      if (!allocation) throw new Error('EVM network was disabled during address allocation');
      const index = allocation.nextDerivationIndex ?? 0;
      const address = root.deriveChild(index).address;
      try {
        await UserDepositInstructions.create({ userId, networkId: network._id, address, derivationIndex: index });
        return { address };
      } catch (error) {
        if ((error as { code?: number }).code !== 11000) throw error;
        const raced = await UserDepositInstructions.findOne({ userId, networkId: network._id }).lean();
        if (raced) return { address: raced.address ?? undefined };
      }
    }
    throw new Error('Could not allocate a unique EVM deposit address');
  }

  async scanDeposits(network: WalletNetworkT, sinceCursor: string): Promise<DepositScanResult> {
    const provider = providerFor(network);
    const asset = await WalletAsset.findOne({ symbol: network.assetSymbol }).lean();
    if (!asset) throw new Error(`Unknown EVM asset ${network.assetSymbol}`);
    const tokenAddress = getAddress(network.contractOrToken);
    const addresses = (await UserDepositInstructions.find({ networkId: network._id, address: { $exists: true } }, { address: 1 }).lean())
      .map((row) => getAddress(row.address ?? ''));
    if (!addresses.length) return { deposits: [], nextCursor: sinceCursor || String(network.depositStartBlock ?? env.EVM_START_BLOCK) };
    const latest = await provider.getBlockNumber();
    const finalBlock = latest - Math.max(1, network.confirmationsRequired) + 1;
    const fromBlock = sinceCursor ? Number(BigInt(sinceCursor) + 1n) : (network.depositStartBlock ?? env.EVM_START_BLOCK);
    if (!Number.isSafeInteger(fromBlock)) throw new Error('Invalid EVM deposit cursor');
    const toBlock = Math.min(finalBlock, fromBlock + MAX_BLOCKS_PER_SCAN - 1);
    if (toBlock < fromBlock) return { deposits: [], nextCursor: sinceCursor || String(fromBlock - 1) };
    const logs = [];
    for (let i = 0; i < addresses.length; i += ADDRESSES_PER_QUERY) {
      const chunk = addresses.slice(i, i + ADDRESSES_PER_QUERY).map((address) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`);
      logs.push(...await provider.getLogs({ address: tokenAddress, fromBlock, toBlock, topics: [TRANSFER_TOPIC, null, chunk] }));
    }
    const addressSet = new Set(addresses.map((address) => address.toLowerCase()));
    const deposits: NormalizedChainDeposit[] = logs.map((log) => {
      const from = getAddress(`0x${log.topics[1]!.slice(-40)}`);
      const to = getAddress(`0x${log.topics[2]!.slice(-40)}`);
      return {
        txHash: log.transactionHash,
        actionSeqOrLogIndex: String(log.index),
        from,
        toAccountOrAddress: to,
        amount: fromAtomic(BigInt(log.data), asset.decimals),
        blockNum: log.blockNumber,
        confirmations: Math.max(0, latest - log.blockNumber + 1),
        irreversible: addressSet.has(to.toLowerCase()) && latest - log.blockNumber + 1 >= network.confirmationsRequired,
      };
    }).filter((deposit) => addressSet.has(deposit.toAccountOrAddress.toLowerCase()));
    return { deposits, nextCursor: String(toBlock) };
  }

  async getConfirmations(txHash: string, network?: WalletNetworkT) {
    if (!network) throw new Error('EVM network configuration is required to check confirmations');
    const provider = providerFor(network);
    const [receipt, latest] = await Promise.all([provider.getTransactionReceipt(txHash), provider.getBlockNumber()]);
    return receipt ? Math.max(0, latest - receipt.blockNumber + 1) : 0;
  }

  explorerTxUrl(txHash: string, network: WalletNetworkT) {
    return network.explorerTxUrlTemplate.replace('{txHash}', encodeURIComponent(txHash));
  }
}

export const evmAdapter = new EvmAdapter();
