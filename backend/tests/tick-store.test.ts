import { afterEach, describe, expect, it, vi } from 'vitest';
import { Tick } from '../src/models/market';
import { TickStore } from '../src/market/tick-store';

describe('tick history persistence sampling', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps every tick in memory but writes history at the configured interval', async () => {
    const store = new TickStore();
    const insert = vi.spyOn(Tick, 'insertMany').mockResolvedValue([] as never);
    const start = Date.now();
    const first = store.add('TEST_OTC', 10, start);
    store.add('TEST_OTC', 11, start + 1000);
    const fifth = store.add('TEST_OTC', 15, start + 5000);

    await store.flush();

    expect(store.latest('TEST_OTC')).toBe(fifth);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ _id: first.id, price: 10 }),
        expect.objectContaining({ _id: fifth.id, price: 15 }),
      ]),
    );
    expect(insert.mock.calls[0]?.[0]).toHaveLength(2);
  });

  it('persists a sampled tick when a trade or CFD references it', async () => {
    const store = new TickStore();
    const insert = vi.spyOn(Tick, 'insertMany').mockResolvedValue([] as never);
    const start = Date.now();
    store.add('TEST_OTC', 10, start);
    const referenced = store.add('TEST_OTC', 11, start + 1000);
    store.persistReference(referenced);

    await store.flush();

    expect(insert.mock.calls[0]?.[0]).toHaveLength(2);
    expect(insert.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([expect.objectContaining({ _id: referenced.id, price: 11 })]),
    );
  });
});
