/** Presentation only: consume normalized real quota responses without inventing windows. */
export interface QuotaWindow {
  slot: string;
  minutes: number;
  label: string;
  remaining: number;
  reset: number | null;
}
export function quotaWindows(quota: any): QuotaWindow[] {
  const buckets = quota?.rateLimitsByLimitId;
  const main =
    buckets?.codex ||
    Object.values(buckets || {}).find((b: any) => b?.limitId === "codex") ||
    quota?.rateLimits;
  return ["primary", "secondary"].flatMap((slot) => {
    const w = main?.[slot];
    if (
      !Number.isFinite(w?.usedPercent) ||
      !Number.isFinite(w?.windowDurationMins) ||
      w.windowDurationMins <= 0
    )
      return [];
    const minutes = w.windowDurationMins;
    return [
      {
        slot,
        minutes,
        label:
          minutes === 300
            ? "5 小时额度"
            : minutes === 10080
              ? "每周额度"
              : `${minutes.toLocaleString("zh-CN")} 分钟额度`,
        remaining: Math.max(0, Math.min(100, 100 - w.usedPercent)),
        reset: Number.isFinite(w.resetsAt) ? w.resetsAt * 1000 : null,
      },
    ];
  });
}
