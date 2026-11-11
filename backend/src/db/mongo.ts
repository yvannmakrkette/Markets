import mongoose from 'mongoose';
import path from 'node:path';
import fs from 'node:fs';
import { env, isProd } from '../config/env';
import { createLogger } from '../lib/logger';
import { Tick } from '../models/market';

const log = createLogger('db');
let memoryServer: { stop: () => Promise<unknown> } | null = null;

/**
 * Connects to MongoDB. Transactions need a replica set:
 *  - MONGO_URI set  -> use it (docker-compose rs0, Atlas, etc.)
 *  - MONGO_URI empty (dev/test only) -> start an embedded single-node replica set persisted to ./.data/mongo
 */
export async function connectMongo(opts: { ephemeral?: boolean } = {}) {
  let uri = env.MONGO_URI;
  if (!uri) {
    if (isProd) throw new Error('MONGO_URI is required in production');
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    const dbPath = opts.ephemeral ? undefined : path.resolve(process.cwd(), '.data', 'mongo');
    if (dbPath) fs.mkdirSync(dbPath, { recursive: true });
    log.info(`starting embedded MongoDB replica set${dbPath ? ` (data: ${dbPath})` : ' (ephemeral)'}; first run downloads mongod, please wait…`);
    const rs = await MongoMemoryReplSet.create({
      replSet: { count: 1, name: 'rs0', storageEngine: 'wiredTiger' },
      // Fixed port: the replica-set config stored in dbPath records host:port, so it must not change between runs.
      instanceOpts: dbPath ? [{ dbPath, storageEngine: 'wiredTiger', port: Number(process.env['DEV_MONGO_PORT'] ?? 27077) }] : undefined,
    });
    memoryServer = rs;
    uri = rs.getUri('y2markets');
  }
  mongoose.set('strictQuery', true);
  // Collections and indexes are created explicitly in ensureCollections() (time-series needs special options).
  mongoose.set('autoCreate', false);
  mongoose.set('autoIndex', false);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  log.info('connected');
  await ensureCollections();
}

/** Collections must exist before they are used inside multi-document transactions. */
async function ensureCollections() {
  const existing = new Set((await mongoose.connection.db!.listCollections().toArray()).map((c) => c.name));
  if (!existing.has(Tick.collection.collectionName)) {
    const retention = env.TICK_RETENTION_DAYS > 0 ? { expireAfterSeconds: env.TICK_RETENTION_DAYS * 86400 } : {};
    await mongoose.connection
      .db!.createCollection(Tick.collection.collectionName, {
        timeseries: { timeField: 'ts', metaField: 'symbol', granularity: 'seconds' },
        ...retention,
      })
      .then(() => log.info('created time-series collection "ticks"'))
      .catch((e: { code?: number }) => {
        if (e.code !== 48) throw e; // 48 = NamespaceExists
      });
  }
  // createCollection options only apply on first creation. Update the TTL on an existing
  // time-series collection too, so operators can turn on bounded tick retention later.
  if (env.TICK_RETENTION_DAYS > 0) {
    try {
      await mongoose.connection.db!.command({
        collMod: Tick.collection.collectionName,
        expireAfterSeconds: env.TICK_RETENTION_DAYS * 86400,
      });
    } catch (e) {
      const err = e as { code?: number; message?: string };
      log.warn(`could not apply tick retention (${err.message ?? 'unknown MongoDB error'}); check MongoDB time-series TTL support`);
    }
  }
  await Tick.collection.createIndex({ symbol: 1, ts: 1 });
  for (const m of Object.values(mongoose.models)) {
    if (m === Tick) continue;
    if (!existing.has(m.collection.collectionName)) await m.createCollection().catch(() => undefined);
    await m.syncIndexes().catch((e) => log.warn(`index sync failed for ${m.modelName}: ${e.message}`));
  }
}

export async function disconnectMongo() {
  await mongoose.disconnect();
  if (memoryServer) await memoryServer.stop();
}
