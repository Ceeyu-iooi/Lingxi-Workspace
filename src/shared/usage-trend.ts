export type TrendPeriod = 'day' | 'hour';
export type HourState = 'known' | 'zero' | 'partial' | 'unknown' | 'unobserved' | 'future';
export interface HourPoint {
 date:string; label:string; caption:string; total:number|string|null; knownTotal:number|string;
 input:number|string; output:number|string; cached:number|string; reasoning:number|string;
 requestCount:number; state:HourState; provided:boolean;
 unknownFields:Record<string,number>;
 models:{provider:string;model:string;total:number|string|null}[];
}
export interface HourTrend {
 granularity:'hour'; timezone:'Asia/Shanghai'; date:string; series:HourPoint[];
 dataVersion:string; observedAt:string; metric:'tokens';
 coverage:{status:'complete'|'partial'|'unverified';message:string;timeBasis:'source-event';collection:string};
 summary:Record<string,unknown>;
}
export const localAgentScopes = ['codex','zcode','dsh'] as const;
export const supportsHourly = (scope:string) => (localAgentScopes as readonly string[]).includes(scope);
export const hourStateLabel:Record<HourState,string>={known:'已核验',zero:'已知零',partial:'已核验部分',unknown:'总量未知',unobserved:'未观测',future:'未来时段'};
