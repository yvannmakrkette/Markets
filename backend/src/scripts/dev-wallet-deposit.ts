import { connectMongo, disconnectMongo } from '../db/mongo';
import { simulateWaxDeposit } from '../wallet/deposit.service';

async function main() {
  const email = process.argv[2];
  const amount = process.argv[3];
  if (!email || !amount) throw new Error('Usage: npm run dev:wallet-deposit -- <user-email> <amount-in-WAX>');
  await connectMongo();
  try {
    console.log(await simulateWaxDeposit(email, amount));
  } finally {
    await disconnectMongo();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
