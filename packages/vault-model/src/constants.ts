// Fixed protocol constants from the Quanlet whitepaper v2.0 (sections 07-12, Appendix B).
// Demo only: the website simulation uses the same values as the protocol specification.

/** Optional protected-payment timelocks (seconds): none, 1 hour, 24 hours, 72 hours. Default 0. */
export const PROTECTED_DELAYS = [0, 3_600, 86_400, 259_200] as const;
export type ProtectedDelay = (typeof PROTECTED_DELAYS)[number];
export const DEFAULT_PROTECTED_DELAY: ProtectedDelay = 0;

export const WITHDRAWAL_WINDOW = 604_800; // 7 days after executableAt (delayed protected payments)
export const ADMIN_WINDOW = 604_800; // 7 days after a delayed administrative change becomes executable
export const ACCEPTANCE_MAX = 1_800; // signed acceptance span, at most 30 minutes; validUntil exclusive
export const SECURITY_DELAY = 604_800; // recovery and guardian replacement: 7 days
export const SECURITY_WINDOW = 604_800; // then 7 days to finalize (expires at day 14)
export const MAX_ACTIVE_QUEUE = 32; // live delayed withdrawals per execution epoch
export const MAX_GRANT = 2_592_000; // FAST grant horizon: 30 days
export const MAX_RECIPIENTS = 16; // per asset
export const MAX_FEE_RECIPIENTS = 8; // global FAST fee recipients

export const DAY = 86_400;
export const HOUR = 3_600;

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export type AssetSymbol = 'ETH' | 'USDG';

/** Demo assets only. No real token address or issuer support is implied. */
export const ASSETS: Record<AssetSymbol, { symbol: AssetSymbol; decimals: number; label: string }> = {
  ETH: { symbol: 'ETH', decimals: 18, label: 'ETH (simulated)' },
  USDG: { symbol: 'USDG', decimals: 6, label: 'USDG example token (simulated)' },
};

export function delayLabel(d: number): string {
  return d === 0 ? 'None' : d === 3_600 ? '1 hour' : d === 86_400 ? '24 hours' : d === 259_200 ? '72 hours' : `${d} s`;
}
