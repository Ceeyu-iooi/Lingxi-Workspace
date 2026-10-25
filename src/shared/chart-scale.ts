/** Decimal axes for rates and per-token quotes; usage counts retain their own scale. */
export function decimalAxis(values:number[],extent=false) {
  const finite=values.filter(Number.isFinite),high=finite.length?Math.max(...finite):1;
  const low=extent&&finite.length?Math.min(...finite):0;
  const span=Math.max(high-low,Math.abs(high)*0.0002,0.000001);
  const min=extent?Math.max(0,low-span*0.08):0,max=high+span*0.08;
  const rough=(max-min)/6,unit=10**Math.floor(Math.log10(rough));
  const step=([1,2,2.5,5,10].find(n=>n*unit>=rough)??10)*unit;
  const lower=Math.floor(min/step)*step,upper=Math.max(lower+step,Math.ceil(max/step)*step);
  return {lower,upper,step};
}
