import {supportsHourly,type TrendPeriod,type HourTrend} from '../../src/shared/usage-trend';
import './usage-trend.css';
export interface TrendContext{scope:string;start:string;end:string;key:string;active?:boolean}
export interface TrendControlOptions{
 radio:(host:HTMLElement,value:TrendPeriod,change:(value:TrendPeriod)=>void)=>void;
 load:(date:string,signal:AbortSignal)=>Promise<HourTrend>;
 commit:()=>void;
 disposeRadio?:()=>void;
}
/** One owner for day selection, latest-result checks, and visible refresh/error state. */
export function mountTrendControl(host:HTMLElement,options:TrendControlOptions){
 host.classList.add('usage-trend-controls');
 host.innerHTML='<div class="trend-control-row"><div class="trend-period"></div><div class="trend-day" hidden><button type="button" data-step="-1" aria-label="前一天">‹</button><input type="date" aria-label="小时趋势日期"><button type="button" data-step="1" aria-label="后一天">›</button></div></div><div class="trend-feedback"><span role="status" aria-live="polite"></span><button type="button" data-retry hidden>重试</button></div>';
 const radio=host.querySelector<HTMLElement>('.trend-period')!,day=host.querySelector<HTMLElement>('.trend-day')!,input=host.querySelector<HTMLInputElement>('input')!,status=host.querySelector<HTMLElement>('[role=status]')!,retry=host.querySelector<HTMLButtonElement>('[data-retry]')!;
 let period:TrendPeriod='day',date='',context:TrendContext={scope:'',start:'',end:'',key:''},result:HourTrend|null=null,key='',ticket=0,abort:AbortController|undefined,disposed=false,radioKey='',clock:ReturnType<typeof setTimeout>|undefined;
 const feedback=(message:string,state='idle')=>{status.textContent=message;host.dataset.state=state;retry.hidden=state!=='error'};
 const validDate=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&value>=context.start&&value<=context.end;
 const render=()=>{
  const signature=period+supportsHourly(context.scope);if(radioKey!==signature){radioKey=signature;options.radio(radio,period,value=>{if(!supportsHourly(context.scope)&&value==='hour'){feedback('此来源仅支持按日查看');return}period=value;key='';result=null;render();if(period==='hour')void load();else {abort?.abort();clearTimeout(clock);ticket++;feedback('')}options.commit()})}
  day.hidden=period!=='hour';input.min=context.start;input.max=context.end;input.value=date;
  host.querySelector<HTMLButtonElement>('[data-step="-1"]')!.disabled=!date||date<=context.start;
  host.querySelector<HTMLButtonElement>('[data-step="1"]')!.disabled=!date||date>=context.end;
 };
 async function load(){
  if(disposed||period!=='hour'||context.active===false||document.hidden)return;
  if(!validDate(date)){feedback('请选择范围内的有效日期','error');return}
  abort?.abort();clearTimeout(clock);clock=setTimeout(()=>void load(),3600000-Date.now()%3600000+50);abort=new AbortController();const own=++ticket,current=date,query=context.key,signal=abort.signal;
  key=JSON.stringify([query,current]);feedback(result?'正在更新，仍显示上一查询结果':'正在读取小时趋势…','refreshing');
  try{const next=await options.load(current,signal);if(disposed||signal.aborted||own!==ticket||query!==context.key||current!==date)return;
   if(next.granularity!=='hour'||next.date!==current||next.series?.length!==24)throw Error('小时趋势响应不完整');
   result=next;feedback(next.coverage.status==='complete'?'上海时间 · 已登记日志范围':next.coverage.message,'ready');options.commit();
  }catch(error){if(!disposed&&!signal.aborted&&own===ticket)feedback((error instanceof Error?error.message:'读取失败')+(result?'；保留上次结果':''),'error')}
 }
 input.onchange=()=>{if(!validDate(input.value)){feedback('请选择范围内的有效日期','error');return}date=input.value;render();void load()};
 host.querySelectorAll<HTMLButtonElement>('[data-step]').forEach(button=>button.onclick=()=>{const next=new Date(Date.parse(date+'T00:00:00Z')+Number(button.dataset.step)*86400000).toISOString().slice(0,10);if(validDate(next)){date=next;render();void load()}});
 retry.onclick=()=>void load();
 const visibility=()=>{if(document.hidden){abort?.abort();clearTimeout(clock);ticket++;key=''}else if(period==='hour')void load()};
 document.addEventListener('visibilitychange',visibility);
 return {
  get period(){return period},get result(){return result},get date(){return result?.date||date},
  update(next:TrendContext){if(disposed)return;const old=context;context=next;
   if(!validDate(date))date=next.end;
   if(!supportsHourly(next.scope)&&period==='hour'){period='day';result=null;key='';abort?.abort();clearTimeout(clock);ticket++;feedback('此来源仅支持按日查看')}
   if(next.active===false){abort?.abort();clearTimeout(clock);ticket++;key='';return}
   render();const expected=JSON.stringify([next.key,date]);if(period==='hour'&&(key!==expected||old.active===false))void load();
  },
  refresh(){key='';void load()},
  dispose(){disposed=true;ticket++;abort?.abort();clearTimeout(clock);document.removeEventListener('visibilitychange',visibility);options.disposeRadio?.();host.replaceChildren()}
 };
}
