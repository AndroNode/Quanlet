import { ASSETS, type AssetSymbol, ZERO_ADDRESS } from './constants';

export type ParseResult = { ok: true; value: bigint } | { ok: false; error: string };

/** Parse a decimal string into integer base units. Rejects excess precision instead of rounding. */
export function parseUnits(input: string, decimals: number): ParseResult {
  const s = input.trim();
  if (s === '') return { ok: false, error: 'Enter an amount.' };
  if (!/^\d+(\.\d+)?$/.test(s)) return { ok: false, error: 'Use digits and at most one decimal point.' };
  const [whole = '0', frac = ''] = s.split('.');
  if (frac.length > decimals) {
    return { ok: false, error: `This asset supports at most ${decimals} decimal places.` };
  }
  const value = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
  return { ok: true, value };
}

export function parseAssetAmount(input: string, asset: AssetSymbol): ParseResult {
  return parseUnits(input, ASSETS[asset].decimals);
}

export function formatUnits(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole.toString()}${frac ? '.' + frac : ''}`;
}

export function formatAsset(value: bigint, asset: AssetSymbol): string {
  return `${formatUnits(value, ASSETS[asset].decimals)} ${asset}`;
}

export function isAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s.trim());
}

export function validateRecipient(s: string): string | null {
  if (!isAddress(s)) return 'Enter a full 0x address with 40 hex characters.';
  if (s.trim().toLowerCase() === ZERO_ADDRESS) return 'The zero address cannot receive a withdrawal.';
  return null;
}
