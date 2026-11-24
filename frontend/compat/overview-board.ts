// @ts-nocheck
// A single page: work first, then a compact view of each connected module.
(() => {
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const day=v=>v?new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date(v)):'';
  const compact=v=>v==null?'—':new Intl.NumberFormat('zh-CN',{notation:'compact',maximumFractionDigits:1}).format(Number(v));
  function mount(root,{state,complete,add,toast}){
    const date=day(Date.now()),tasks=state.tasks||[],projects=state.projects||[],pending=tasks.filter(t=>!t.done).sort((a,b)=>(Date.parse(a.dueAt||a.startAt)||Infinity)-(Date.parse(b.dueAt||b.startAt)||Infinity)),done=tasks.filter(t=>t.done),active=projects.filter(p=>p.status!=='done');
    const signature=JSON.stringify([state.projects,state.tasks,date]);
    if(root._overviewSignature===signature&&root.querySelector('.overview-board'))return;
    root._overviewSignature=signature;root._overviewAbort?.abort();const abort=new AbortController();root._overviewAbort=abort;
    root._wbDispose=()=>{abort.abort();root._overviewDraft=root.querySelector('[data-quick-task]')?.value||root._overviewDraft||'';};
    const upcoming=pending[0],overdue=pending.filter(t=>t.dueAt&&day(t.dueAt)<date);
    const icons={projects:"M4 6h16v13H4z M7 3v6m10-6v6M7 13l2 2 4-4",usage:"M4 5v14h16M8 15v-3m4 3V8m4 7v-5",finance:"M4 6h16v13H4z M4 10h16m-5 5h2",prompts:"M6 3h9l4 4v14H6z M9 12h7m-7 4h7",skills:"m12 3 9 5-9 5-9-5 9-5z M3 12l9 5 9-5m-18 4 9 5 9-5"};
    const icon=route=>`<span class="ob-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${icons[route]}"/></svg></span>`;
    const heading=(label,route,extra='')=>`<header class="ob-card-heading"><a href="#/${route}" aria-label="查看${label}">${icon(route)}<h3>${label}</h3><span>${extra||""} ↗</span></a></header>`;
    const task=t=>`<div class="ob-task-row"><span class="ob-task-dot ${t.dueAt&&day(t.dueAt)<date?'late':''}"></span><div><strong>${esc(t.title)}</strong><small>${esc(projects.find(p=>p.id===t.projectId)?.name||'独立待办')}${t.dueAt?' · 截止 '+esc(day(t.dueAt)):t.startAt?' · 开始 '+esc(day(t.startAt)):' · 未排期'}${t.location?' · '+esc(t.location):''}</small></div><button type="button" data-complete="${esc(t.id)}" aria-label="完成 ${esc(t.title)}">完成</button></div>`;
    (window.workbenchDesign?.paint||((n,h)=>n.innerHTML=h))(root,`<section class="overview-board ob-dashboard"><header class="ob-top"><div><h1>工作总览</h1></div><time datetime="${date}">${esc(date.replaceAll('-',' / '))}</time></header><div class="ob-dashboard-grid"><section class="ob-focus">${heading('项目与待办','projects',pending.length?pending.length+' 项待办':'')}<div class="ob-focus-title"><span>${overdue.length?'优先处理 · '+overdue.length+' 项已逾期':'下一步'}</span><h2>${esc(upcoming?.title||'待办已清空')}</h2>${upcoming?`<button type="button" data-complete="${esc(upcoming.id)}" aria-label="完成 ${esc(upcoming.title)}">完成</button>`:""}</div><div class="ob-task-list">${pending.slice(1,4).map(task).join('')}</div><form class="ob-quick-add"><input id="overview-add" data-quick-task aria-label="添加待办" placeholder="添加一件待办…" maxlength="300" value="${esc(root._overviewDraft||'')}"><button type="submit" aria-label="保存待办">＋</button></form><div class="ob-project-strip" ${tasks.length||active.length?"":"hidden"}><span>${active.length} 个进行中项目</span><span>已完成 ${done.length} / ${tasks.length} 项</span><div class="ob-bar"><i style="width:${tasks.length?done.length/tasks.length*100:0}%"></i></div></div></section><section class="ob-module ob-usage">${heading('用量监测','usage','近 7 天')}<div class="ob-usage-number"><span data-ob-tokens>—</span><small>Codex · 已知 Token</small></div><div class="ob-spark" data-ob-spark aria-label="最近七天已采集用量"></div><div class="ob-usage-bottom"><span data-ob-requests>正在读取本机记录…</span><span data-ob-cost></span></div></section><section class="ob-module ob-finance">${heading('记账','finance')}<p class="ob-caption">本月支出 · CNY</p><strong class="ob-money" data-ob-expense>—</strong><div class="ob-finance-pair" hidden><span>收入 <b data-ob-income>—</b></span><span>结余 <b data-ob-net>—</b></span></div></section></div><footer class="ob-library-strip"><a href="#/prompts">${icon("prompts")}<strong>提示词</strong><b data-ob-prompts>—</b><span aria-hidden="true">↗</span></a><a href="#/skills">${icon("skills")}<strong>技能库</strong><b data-ob-skills>—</b><span aria-hidden="true">↗</span></a><span class="ob-cache-state" data-ob-status role="status">正在读取模块摘要</span></footer></section>`);
    root.querySelectorAll('[data-complete]').forEach(button=>button.onclick=async()=>{if(button.disabled)return;button.disabled=true;try{const next=await complete(button.dataset.complete);if(!abort.signal.aborted&&next)mount(root,{state:next,complete,add,toast});}catch(error){if(button.isConnected){button.disabled=false;toast(error.message,{kind:'error'});}}});
    const input=root.querySelector('[data-quick-task]');root._overviewDraft=input.value;input.oninput=()=>root._overviewDraft=input.value;
    root.querySelector('form').onsubmit=async event=>{event.preventDefault();const title=input.value.trim(),button=event.currentTarget.querySelector('button');if(!title||button.disabled)return;button.disabled=true;try{await add(title);if(root._overviewDraft?.trim()===title){root._overviewDraft='';const live=root.querySelector('[data-quick-task]');if(live?.value.trim()===title)live.value='';}}catch(error){if(input.isConnected)toast(error.message,{kind:'error'});}finally{if(button.isConnected)button.disabled=false;}};
    async function load(){
      try{const data=await window.workbenchRequest('GET','/api/overview',undefined,{signal:abort.signal});if(abort.signal.aborted)return;
        const put=(key,value)=>root.querySelector(`[data-ob-${key}]`).textContent=value;
        put('tokens',compact(data.usage.summary?.total));put('requests',(data.usage.summary?.requests??0).toLocaleString()+' 次请求 · 已采集范围');
        root.querySelector('[data-ob-cost]').title=data.usage.valuation?.costUnknown?data.usage.valuation.costUnknown+' 条缺价未计入；全球标准文本档基准，非实际账单':'全球标准文本档基准估算，非实际账单';
        put('cost',data.usage.valuation?.pricedRequests?(data.usage.valuation.costUnknown?'已知 API 估算 ¥':'API 估算 ¥')+Number(data.usage.valuation.costs.CNY).toLocaleString('zh-CN',{maximumFractionDigits:2}):'费用待核验');
        if(data.finance.transactionCount){
          root.querySelector(".ob-finance-pair").hidden=false;
          for(const key of ["expense","income","net"])put(key,Number(data.finance[key]).toLocaleString("zh-CN",{minimumFractionDigits:2,maximumFractionDigits:2}));
        }else put("expense","本月暂无交易");
        put('prompts',data.prompts+' 项');put('skills',data.skills+' 项');
        const daily=data.usage.daily||[],max=Math.max(1,...daily.map(r=>Number(r.knownTotal??r.total??0)));
        root.querySelector('[data-ob-spark]').innerHTML=daily.length?daily.slice(-7).map(r=>`<button type="button" data-date="${esc(r.date)}" data-value="${esc(r.knownTotal??r.total??'未知')}" aria-label="${esc(r.date)} · ${esc(r.knownTotal??r.total??'未知')} Token"><i style="height:${Math.max(2,Number(r.knownTotal??r.total??0)/max*100)}%"></i><small>${esc(r.date?.slice(5))}</small></button>`).join(''):'<p class="ob-hint">暂无已采集用量</p>';
        const message=q=>q.dataset.date+" · "+q.dataset.value+" Token";
        root.querySelectorAll("[data-ob-spark] button").forEach(button=>{
          const reveal=()=>put("requests",message(button));
          const reset=()=>put("requests",(data.usage.summary?.requests??0).toLocaleString()+" 次请求");
          button.onfocus=reveal;button.onpointerenter=reveal;button.onblur=reset;button.onpointerleave=()=>{if(document.activeElement!==button)reset();};
          button.onclick=()=>{button.focus({preventScroll:true});reveal();};
        });
        put('status','');
      }catch(error){if(!abort.signal.aborted){root.querySelector('[data-ob-status]').innerHTML='模块摘要读取失败 <button type="button">重试</button>';root.querySelector('[data-ob-status] button').onclick=load;root.querySelector('[data-ob-requests]').textContent='暂时无法读取';}}
    }
    void load();
  }
  window.overviewBoard={mount};
})();
