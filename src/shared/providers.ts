/**
 * The provider-id seam for DeepSeek's period-based billing: host/fold.ts and
 * host/activity.ts split the billed buckets into peak/off-peak periods, and
 * client/cost.ts prices the peak buckets at double — for DeepSeek alone.
 */

const DEEPSEEK_PROVIDER_IDS: ReadonlySet<string> = new Set([
  // dsh's two native DeepSeek routes share one period-based list — plus the
  // bare vendor id some envelopes carry directly.
  'deepseek-official',
  'deepseek-account',
  'deepseek',
])

/** Whether a dsh provider bills through DeepSeek's period-based list (peak / half-price off-peak). */
export function isDeepSeekProvider(dshProviderId: string): boolean {
  return DEEPSEEK_PROVIDER_IDS.has(dshProviderId)
}
