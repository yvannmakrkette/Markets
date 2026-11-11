import 'dotenv/config';
import { MongoClient, type Collection, type Document } from 'mongodb';

const SOURCE_URI = process.env['MONGO_URI'];
const TARGET_URI = process.env['MIGRATION_NEW_URI'];
const execute = process.argv.includes('--execute');
const resume = process.argv.includes('--resume');
const BATCH_SIZE = 500;
const TICK_COLLECTION = 'ticks';

if (!SOURCE_URI || !TARGET_URI) {
  throw new Error('Set MONGO_URI (source) and MIGRATION_NEW_URI (destination) in backend/.env.');
}

function databaseIdentity(uri: string) {
  const parsed = new URL(uri);
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, '').split('/')[0] || 'test');
  return { host: parsed.host.toLowerCase(), dbName };
}

const sourceIdentity = databaseIdentity(SOURCE_URI);
const targetIdentity = databaseIdentity(TARGET_URI);
if (sourceIdentity.host === targetIdentity.host) {
  throw new Error('Source and destination must be different MongoDB clusters; another database on the same cluster shares storage.');
}
if (sourceIdentity.dbName !== targetIdentity.dbName) {
  throw new Error(`Source and destination database names must match (source: ${sourceIdentity.dbName}, destination: ${targetIdentity.dbName}).`);
}

const sourceClient = new MongoClient(SOURCE_URI, { appName: 'y2markets-migration-source' });
const targetClient = new MongoClient(TARGET_URI, { appName: 'y2markets-migration-target' });

try {
  await Promise.all([sourceClient.connect(), targetClient.connect()]);
  const sourceDb = sourceClient.db(sourceIdentity.dbName);
  const targetDb = targetClient.db(targetIdentity.dbName);
  const sourceNames = (await sourceDb.listCollections({}, { nameOnly: true }).toArray())
    .map((item) => item.name)
    .filter((name) => !name.startsWith('system.') && name !== TICK_COLLECTION);
  const targetNames = (await targetDb.listCollections({}, { nameOnly: true }).toArray())
    .map((item) => item.name)
    .filter((name) => !name.startsWith('system.'));

  if (targetNames.length && !resume) {
    throw new Error(`Destination is not empty (${targetNames.join(', ')}). Use a fresh database or rerun a partial migration with --resume.`);
  }
  if (resume && targetNames.some((name) => !sourceNames.includes(name))) {
    throw new Error('Resume refused: destination contains collections that are not part of this source database.');
  }

  const summary: Array<{ collection: string; documents: number }> = [];
  for (const name of sourceNames) {
    const source = sourceDb.collection(name);
    summary.push({ collection: name, documents: await source.estimatedDocumentCount() });
  }

  console.log(execute ? 'Migration plan (ticks excluded):' : 'Dry run only; migration plan (ticks excluded):');
  for (const row of summary) console.log(`  ${row.collection}: ${row.documents} documents`);
  console.log(`  ${TICK_COLLECTION}: excluded (market price history is regenerated)`);
  if (!execute) {
    console.log('No data copied. Set MIGRATION_NEW_URI and run with --execute when ready.');
  } else {
    for (const { collection: name } of summary) {
      const source = sourceDb.collection(name);
      const target = targetDb.collection(name);
      await copyCollection(source, target);
      console.log(`Copied ${name}`);
    }
    console.log('Migration complete. Source database was left unchanged.');
  }
} finally {
  await Promise.allSettled([sourceClient.close(), targetClient.close()]);
}

async function copyCollection(source: Collection<Document>, target: Collection<Document>) {
  const metadata = await sourceDbCollectionInfo(source);
  const targetExists = await target.db.listCollections({ name: target.collectionName }, { nameOnly: true }).hasNext();
  if (!targetExists && metadata.options && Object.keys(metadata.options).length) {
    const options = { ...metadata.options } as Record<string, unknown>;
    delete options.uuid;
    delete options.clusteredIndex;
    await target.db.createCollection(target.collectionName, options);
  }

  const cursor = source.find({}, { batchSize: BATCH_SIZE });
  let batch: Document[] = [];
  for await (const doc of cursor) {
    batch.push(doc);
    if (batch.length === BATCH_SIZE) {
      await upsertBatch(target, batch);
      batch = [];
    }
  }
  if (batch.length) await upsertBatch(target, batch);

  const indexes = await source.listIndexes().toArray();
  for (const index of indexes) {
    if (index.name === '_id_') continue;
    const { key, name, ns: _ns, v: _v, background: _background, ...options } = index;
    await target.createIndex(key, { ...options, name });
  }
}

async function sourceDbCollectionInfo(source: Collection<Document>) {
  const info = await source.db.listCollections({ name: source.collectionName }, { nameOnly: false }).next();
  return { options: info?.options };
}

async function upsertBatch(target: Collection<Document>, docs: Document[]) {
  await target.bulkWrite(
    docs.map((doc) => ({ replaceOne: { filter: { _id: doc['_id'] }, replacement: doc, upsert: true } })),
    { ordered: true },
  );
}
