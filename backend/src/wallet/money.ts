/** Convert token decimal text to atomic integer units without floating-point math. */
export function toAtomic(value: string, decimals: number): bigint {
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) throw new Error('Invalid decimal amount');
  const fraction = match[2] ?? '';
  const exponent = Number(match[3] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) throw new Error('Invalid decimal exponent');
  const coefficient = BigInt(`${match[1]}${fraction}`);
  const scaleAdjustment = decimals - fraction.length + exponent;
  if (scaleAdjustment >= 0) return coefficient * 10n ** BigInt(scaleAdjustment);
  const divisor = 10n ** BigInt(-scaleAdjustment);
  if (coefficient % divisor !== 0n) throw new Error('Amount has more precision than the asset supports');
  return coefficient / divisor;
}

export function fromAtomic(value: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  if (decimals === 0) return whole.toString();
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function formatTokenAmount(value: string, decimals: number): string {
  return fromAtomic(toAtomic(value, decimals), decimals);
}
