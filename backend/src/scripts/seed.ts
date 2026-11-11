/**
 * Optional demo data: creates a few public traders with trade history so Social Trading,
 * leaderboards and admin screens have something to show.  Run:  npm run seed
 */
import { connectMongo, disconnectMongo } from '../db/mongo';
import { bootstrap } from '../bootstrap';
import { User } from '../models/user';
import { Account } from '../models/account';
import { createUserWithAccounts } from '../services/auth.service';
import { withTxn } from '../services/ledger.service';
import { env } from '../config/env';
import { WalletAsset, WalletNetwork } from '../models/wallet';

const TRADERS = [
  { fullName: 'Amina Wanjiru', username: 'amina_fx', email: 'amina@example.com' },
  { fullName: 'Brian Otieno', username: 'brian_trades', email: 'brian@example.com' },
  { fullName: 'Grace Mutua', username: 'grace_m', email: 'grace@example.com' },
];

async function main() {
  await connectMongo();
  await bootstrap();
  await seedWalletCatalog();
  for (const t of TRADERS) {
    if (await User.exists({ username: t.username })) continue;
    const u = await withTxn((s) => createUserWithAccounts(s, { ...t, password: 'Password123', emailVerified: true }));
    await User.updateOne({ _id: u._id }, { $set: { isPublic: true, 'onboarding.welcomeSeen': true, 'onboarding.goodLuckSeen': true, 'onboarding.tourDone': true } });
    console.log(`created ${t.username} / Password123`);
  }
  console.log(`accounts: ${await Account.countDocuments()}`);
  await disconnectMongo();
}

/** Upserts catalog/config only; no user funds or deposit instructions are created. */
async function seedWalletCatalog() {
  await WalletAsset.updateOne(
    { symbol: 'WAXP' },
    { $set: { name: 'WAX', decimals: 8, enabled: true }, $setOnInsert: { symbol: 'WAXP' } },
    { upsert: true, runValidators: true },
  );
  await WalletNetwork.updateOne(
    { assetSymbol: 'WAXP', networkCode: 'WAX' },
    {
      $set: {
        chainType: 'eosio',
        contractOrToken: 'eosio.token',
        depositModel: 'memo',
        depositAccountOrXpub: env.WAX_DEPOSIT_ACCOUNT,
        memoRequired: true,
        minDeposit: '0.00000001',
        minWithdraw: '1',
        withdrawFee: '0.1',
        confirmationsRequired: 1,
        explorerTxUrlTemplate: 'https://waxblock.io/transaction/{txHash}',
        enabled: !!env.WAX_DEPOSIT_ACCOUNT,
      },
      $setOnInsert: { assetSymbol: 'WAXP', networkCode: 'WAX' },
    },
    { upsert: true, runValidators: true },
  );

  await WalletAsset.updateOne(
    { symbol: 'USDT' },
    { $set: { name: 'Tether USD', decimals: 6, enabled: false }, $setOnInsert: { symbol: 'USDT' } },
    { upsert: true, runValidators: true },
  );
  const sampleNetworks = [
    { networkCode: 'TRC20', chainType: 'tron', contractOrToken: 'configure-trc20-contract', depositModel: 'address' },
    { networkCode: 'ERC20', chainType: 'evm', contractOrToken: 'configure-erc20-contract', depositModel: 'address' },
  ] as const;
  for (const network of sampleNetworks) {
    await WalletNetwork.updateOne(
      { assetSymbol: 'USDT', networkCode: network.networkCode },
      {
        $setOnInsert: {
          ...network,
          assetSymbol: 'USDT',
          depositAccountOrXpub: '',
          memoRequired: false,
          minDeposit: '1',
          minWithdraw: '10',
          withdrawFee: '1',
          confirmationsRequired: 12,
          explorerTxUrlTemplate: network.networkCode === 'ERC20' ? 'https://etherscan.io/tx/{txHash}' : 'https://tronscan.org/#/transaction/{txHash}',
          enabled: false,
        },
      },
      { upsert: true, runValidators: true },
    );
  }
  console.log(`wallet catalog: WAXP/WAX ${env.WAX_DEPOSIT_ACCOUNT ? 'enabled' : '(disabled: set WAX_DEPOSIT_ACCOUNT)'}, USDT TRC20/ERC20 disabled`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
