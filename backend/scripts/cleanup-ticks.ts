import 'dotenv/config';
import mongoose from 'mongoose';

const execute = process.argv.includes('--execute');
const uri = process.env['MONGO_URI'];

if (!uri) throw new Error('MONGO_URI is required. Set it in backend/.env before running cleanup.');

async function main() {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15_000 });
  const db = mongoose.connection.db!;
  if (db.databaseName !== 'y2markets') {
    throw new Error(`Refusing cleanup: connected database is "${db.databaseName}", expected "y2markets".`);
  }

  const info = await db.listCollections({ name: 'ticks' }).next();
  if (!info) {
    console.log('No ticks collection exists; nothing to clean.');
    return;
  }

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const ticks = db.collection('ticks');
  const count = await ticks.countDocuments({ ts: { $lt: cutoff } });
  console.log(`Found ${count} ticks older than ${cutoff.toISOString()} in y2markets.ticks.`);
  if (!execute) {
    console.log('Dry run only. Re-run with --execute to delete these expired tick-history records.');
    return;
  }

  const result = await ticks.deleteMany({ ts: { $lt: cutoff } });
  const remaining = await ticks.countDocuments({ ts: { $lt: cutoff } });
  console.log(`Deleted ${result.deletedCount} old ticks; ${remaining} old ticks remain.`);
  if (remaining > 0) throw new Error('Some expired ticks remain; rerun cleanup after checking MongoDB logs.');
}

main()
  .catch((error: unknown) => {
    console.error(`Tick cleanup failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => undefined);
  });
