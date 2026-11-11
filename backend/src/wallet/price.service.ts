import { env } from '../config/env';
import { WalletAsset, WalletPriceRate } from '../models/wallet';

export interface PriceProvider {
  usdRates(symbols: string[]): Promise<Map<string, string>>;
}

const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const priceCache = new Map<string, { rate: string; expiresAt: number }>();

/** CoinGecko-compatible simple-price endpoint; prices are extracted as text to avoid JS number rounding. */
export class ConfiguredPriceProvider implements PriceProvider {
  async usdRates(symbols: string[]) {
    const ids = new Map((await WalletAsset.find({ symbol: { $in: symbols } }).lean()).map((asset) => [asset.symbol, asset.priceFeedId || asset.symbol.toLowerCase()]));
    const result = new Map<string, string>();
    for (const symbol of symbols) {
      const cached = priceCache.get(symbol);
      if (cached && cached.expiresAt > Date.now()) result.set(symbol, cached.rate);
    }
    const requested = symbols.filter((symbol) => !result.has(symbol));
    if (env.PRICE_API_URL && requested.length) {
      try {
        const url = new URL(env.PRICE_API_URL);
        url.searchParams.set('ids', [...new Set(requested.map((symbol) => ids.get(symbol) ?? symbol.toLowerCase()))].join(','));
        url.searchParams.set('vs_currencies', 'usd');
        const response = await fetch(url, { headers: env.PRICE_API_KEY ? { 'x-cg-demo-api-key': env.PRICE_API_KEY } : {}, signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error(`Price source request failed (${response.status})`);
        const body = await response.text();
        for (const symbol of requested) {
          const id = ids.get(symbol) ?? symbol.toLowerCase();
          const match = new RegExp(`"${escaped(id)}"\\s*:\\s*\\{[^}]*?"usd"\\s*:\\s*([0-9]+(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)`).exec(body);
          if (match?.[1]) {
            result.set(symbol, match[1]);
            priceCache.set(symbol, { rate: match[1], expiresAt: Date.now() + 15_000 });
          }
        }
      } catch {
        // An unavailable live price source falls through to admin/env fallback rates below.
      }
    }

    const [adminRates, configuredRates] = await Promise.all([
      WalletPriceRate.find({ assetSymbol: { $in: symbols } }).lean(),
      Promise.resolve(parseStaticRates()),
    ]);
    const admin = new Map(adminRates.map((rate) => [rate.assetSymbol, rate.usdPrice.toString()]));
    for (const symbol of symbols) {
      if (result.has(symbol)) continue;
      const fallback = admin.get(symbol) ?? configuredRates[symbol];
      if (fallback) result.set(symbol, fallback);
    }
    return result;
  }
}

function parseStaticRates(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(env.WALLET_STATIC_RATES);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).flatMap(([symbol, rate]) =>
      typeof rate === 'string' && /^(?:\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(rate) ? [[symbol.toUpperCase(), rate]] : [],
    ));
  } catch { return {}; }
}

export const priceProvider: PriceProvider = new ConfiguredPriceProvider();
