(() => {
  window.usageProviders={openrouter:{name:'OpenRouter',url:'https://openrouter.ai/api/v1'},newapi:{name:'New API',url:''},sub2api:{name:'Sub2API',url:''},custom_balance:{name:'自定义余额',url:''},siliconflow:{name:'硅基流动',url:'https://api.siliconflow.cn/v1'},moonshot:{name:'Moonshot',url:'https://api.moonshot.cn/v1'},minimax:{name:'MiniMax',url:'https://api.minimaxi.com/v1'}};
  const e=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const presets=[['all','全部'],['today','今天'],['yesterday','昨天'],['7','近 7 天'],['30','近 30 天'],['month','本月'],['last-month','上月'],['recent-year','近一年'],['year','本年'],['custom','自定义']];
  const date=d=>d.toISOString().slice(0,10),today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const chevron='<svg class="usage-filter-chevron" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 9 6 6 6-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const caption=text=>'<span class="usage-filter-label">'+e(text)+'</span>'+chevron;
  function range(root,changed){
    const select=root.querySelector('#usage-days'),label=select.parentElement;
    select.innerHTML=presets.map(([v,t])=>`<option value="${v}">${t}</option>`).join('');select.value='30';select.hidden=true;
    const shell=document.createElement('div');shell.className='usage-date-range';shell.innerHTML='<button type="button" class="usage-filter-button" aria-expanded="false">'+caption('近 30 天')+'</button><div class="usage-date-popover" data-custom="false" hidden><div class="usage-date-presets"></div><div class="usage-date-body" aria-hidden="true"><div class="usage-calendars"></div><p class="usage-date-error" role="status"></p></div></div>';
    label.append(shell);const button=shell.querySelector('button'),popup=shell.querySelector('.usage-date-popover'),body=shell.querySelector('.usage-date-body'),error=shell.querySelector('[role=status]');
    let start='',end='',applied=null;const months={start:new Date(today().slice(0,8)+'01T00:00:00Z'),end:new Date(today().slice(0,8)+'01T00:00:00Z')};
    body.inert=true;
    const expand=value=>{popup.dataset.custom=String(value);body.inert=!value;body.setAttribute('aria-hidden',String(!value));};
    const close=(focus=false)=>{popup.hidden=true;button.setAttribute('aria-expanded','false');if(focus)button.focus({preventScroll:true});};
    const title=()=>{button.innerHTML=caption(select.value==='custom'&&applied?`${applied.start_date} — ${applied.end_date}`:presets.find(([v])=>v===select.value)?.[1]||'时间范围');button.title=button.textContent;};
    const validEnd=d=>!!start&&d>=start&&d<=today()&&(Date.parse(d)-Date.parse(start))/86400000<366;
    const apply=()=>{if(!end||!validEnd(end))return;const next={period:'custom',start_date:start,end_date:end},different=select.value!=='custom'||JSON.stringify(applied)!==JSON.stringify(next);select.value='custom';applied=next;title();if(different)changed();};
    const presetList=shell.querySelector('.usage-date-presets');presetList.innerHTML=presets.map(([v,t])=>`<button type="button" data-preset="${v}" aria-pressed="false">${t}</button>`).join('');
    const calendars=shell.querySelector('.usage-calendars');calendars.innerHTML=['start','end'].map(role=>`<section data-calendar="${role}"><div class="usage-calendar-heading"><button type="button" data-nav="-1" aria-label="${role==='start'?'起始':'终止'}上一月">‹</button><strong></strong><button type="button" data-nav="1" aria-label="${role==='start'?'起始':'终止'}下一月">›</button></div><div class="usage-calendar-grid"></div></section>`).join('');
    const render=()=>{
      const focused=document.activeElement,role=focused?.closest('[data-calendar]')?.dataset.calendar,focusDate=focused?.dataset.date;
      presetList.querySelectorAll('[data-preset]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.preset===(popup.dataset.custom==='true'?'custom':select.value))));
      calendars.querySelectorAll('[data-calendar]').forEach(section=>{const role=section.dataset.calendar,first=months[role],days=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0)).getUTCDate();section.querySelector('strong').textContent=(role==='start'?'起始：':'终止：')+first.getUTCFullYear()+'年'+(first.getUTCMonth()+1)+'月';section.querySelector('[data-nav="1"]').disabled=first.getUTCFullYear()+'-'+String(first.getUTCMonth()+1).padStart(2,'0')>=today().slice(0,7);
        section.querySelector('.usage-calendar-grid').innerHTML=['日','一','二','三','四','五','六'].map(x=>'<span>'+x+'</span>').join('')+'<span></span>'.repeat(first.getUTCDay())+Array.from({length:days},(_,i)=>{const d=date(new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth(),i+1))),selected=d===(role==='start'?start:end),inRange=start&&end&&d>=start&&d<=end;return `<button type="button" data-date="${d}" aria-label="${role==='start'?'起始':'终止'} ${d}" aria-pressed="${selected}" class="${selected?'selected ':''}${inRange?'in-range':''}" ${d>today()||role==='end'&&!validEnd(d)?'disabled':''}>${i+1}</button>`;}).join('');
      });
      if(role&&focusDate){const target=calendars.querySelector(`[data-calendar="${role}"] [data-date="${focusDate}"]`);if(target&&!target.disabled)target.focus({preventScroll:true});}
      error.textContent=start&&!end?'请选择终止日期':'';
    };
    presetList.onclick=event=>{const choice=event.target.closest('[data-preset]');if(!choice)return;if(choice.dataset.preset==='custom'){expand(true);render();return;}select.value=choice.dataset.preset;expand(false);title();render();close(true);changed();};
    calendars.onclick=event=>{const section=event.target.closest('[data-calendar]'),target=event.target.closest('button');if(!section||!target||target.disabled)return;const role=section.dataset.calendar;if(target.dataset.nav){months[role].setUTCMonth(months[role].getUTCMonth()+Number(target.dataset.nav));render();return;}if(!target.dataset.date)return;if(role==='start'){start=target.dataset.date;if(end&&!validEnd(end))end='';if(months.end<months.start)months.end=new Date(months.start);}else end=target.dataset.date;apply();render();};
    button.onclick=()=>{if(!popup.hidden){close();return;}expand(false);render();popup.hidden=false;button.setAttribute('aria-expanded','true');};
    select.addEventListener('change',()=>{title();});
    const outside=ev=>{if(!shell.contains(ev.target))close();},escape=ev=>{if(ev.key==='Escape'){close();button.focus();}};document.addEventListener('pointerdown',outside);shell.addEventListener('keydown',escape);
    window.usageCharts.track(root,()=>document.removeEventListener('pointerdown',outside));
    return {params:()=>select.value==='custom'&&applied?{...applied}:{period:select.value},select,title};
  }
  function keys(root,changed){
    const shell=document.createElement('details');shell.className='usage-key-picker';shell.innerHTML='<summary class="usage-filter-button">'+caption('全部')+'</summary><div class="usage-key-options"></div>';let rows=[],selected=[];
    const paint=()=>{const active=document.activeElement,focusKey=shell.contains(active)&&active.matches('input')?(active.hasAttribute('data-all')?'[data-all]':`input[value="${CSS.escape(active.value)}"]`):null;shell.querySelector('summary').innerHTML=caption(selected.length===1?rows.find(r=>r.id===selected[0])?.name||'APIKey':selected.length?selected.length+' 个 APIKey':'全部');shell.querySelector('.usage-key-options').innerHTML='<label><input type="checkbox" data-all '+(!selected.length?'checked':'')+'>全部</label>'+rows.map(r=>`<label><input type="checkbox" value="${e(r.id)}" ${selected.includes(r.id)?'checked':''}>${e(r.name)}</label>`).join('');shell.querySelector('[data-all]').onchange=()=>{selected=[];paint();changed();};shell.querySelectorAll('input[value]').forEach(input=>input.onchange=()=>{selected=[...shell.querySelectorAll('input[value]:checked')].map(x=>x.value);paint();changed();});if(focusKey)shell.querySelector(focusKey)?.focus({preventScroll:true});};
    const outside=ev=>{if(!shell.contains(ev.target))shell.open=false;};document.addEventListener('pointerdown',outside);window.usageCharts.track(root,()=>document.removeEventListener('pointerdown',outside));
    return {shell,get:()=>[...selected],set:(value=[])=>{selected=value.filter(id=>rows.some(r=>r.id===id));paint();},update:value=>{rows=value;selected=selected.filter(id=>rows.some(r=>r.id===id));paint();}};
  }
  function models(root,select,changed,key){
    select.hidden=true;let values=[],rows=[],restored=false,scope='';
    const shell=document.createElement('details');shell.className='usage-key-picker usage-model-picker';shell.innerHTML='<summary class="usage-filter-button" aria-haspopup="true" aria-expanded="false">'+caption('全部模型')+'</summary><div class="usage-model-popover"><input class="usage-model-search" type="search" placeholder="搜索模型" aria-label="搜索模型"><div class="usage-model-options"><label class="usage-model-all"><input type="checkbox" data-all>全部模型</label></div><p class="usage-model-empty" hidden>没有匹配的模型</p></div>';select.before(shell);
    const summary=shell.querySelector('summary'),search=shell.querySelector('input[type=search]'),list=shell.querySelector('.usage-model-options'),allBox=shell.querySelector('[data-all]'),nodes=new Map();
    const storage=()=>typeof key==='function'?key():key;
    const save=()=>{if(storage())window.wbLayoutStorage?.setItem(storage(),JSON.stringify(values));};
    const filter=()=>{const term=search.value.toLocaleLowerCase();let visible=0;nodes.forEach((label,value)=>{label.hidden=!value.toLocaleLowerCase().includes(term);if(!label.hidden)visible++;});shell.querySelector('.usage-model-empty').hidden=!!visible;};
    const paint=()=>{summary.querySelector('.usage-filter-label').textContent=values.length===1?values[0]:values.length?'已选 '+values.length+' 个模型':'全部模型';summary.title=values.length?values.join('、'):'全部模型';allBox.checked=!values.length;allBox.closest('label').classList.toggle('selected',!values.length);nodes.forEach((label,value)=>{const input=label.querySelector('input');input.checked=values.includes(value);label.classList.toggle('selected',input.checked);});select.value=values[0]||'';};
    const load=()=>{const next=storage()||'';if(restored&&scope===next)return;scope=next;restored=true;try{const saved=JSON.parse(window.wbLayoutStorage?.getItem(next)||'[]');values=Array.isArray(saved)?[...new Set(saved.filter(v=>typeof v==='string'&&v))].sort():[];}catch{values=[];}search.value='';paint();};
    const set=(next=[],persist=true)=>{values=[...new Set(next.filter(v=>typeof v==='string'&&v))].sort();if(persist)save();paint();};
    const update=next=>{load();rows=[...new Set(next)].sort();let removed=false;nodes.forEach((label,value)=>{if(!rows.includes(value)){if(label.contains(document.activeElement))search.focus({preventScroll:true});label.remove();nodes.delete(value);}});rows.forEach(value=>{if(nodes.has(value))return;const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.value=value;label.append(input,document.createTextNode(value));list.append(label);nodes.set(value,label);input.onchange=()=>{const chosen=new Set(values);if(input.checked)chosen.add(value);else chosen.delete(value);set([...chosen]);changed();};});const valid=values.filter(v=>rows.includes(v));removed=valid.length!==values.length;if(removed){values=valid;save();}paint();filter();return removed;};
    allBox.onchange=()=>{set([]);changed();};search.oninput=filter;shell.ontoggle=()=>summary.setAttribute('aria-expanded',String(shell.open));
    select.addEventListener('change',()=>{set(select.value?[select.value]:[]);changed();});
    shell.addEventListener('keydown',event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();shell.open=false;summary.focus({preventScroll:true});return;}
      if(event.target===summary&&event.key==='ArrowDown'){event.preventDefault();shell.open=true;search.focus();return;}
      const inputs=[allBox,...[...nodes.values()].filter(label=>!label.hidden).map(label=>label.querySelector('input'))],index=inputs.indexOf(event.target);
      if(index<0)return;
      if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
        event.preventDefault();const target=inputs[event.key==='Home'?0:event.key==='End'?inputs.length-1:(index+(event.key==='ArrowDown'?1:-1)+inputs.length)%inputs.length];
        target.focus({preventScroll:true});const box=list.getBoundingClientRect(),row=target.closest('label').getBoundingClientRect();
        if(row.top<box.top)list.scrollTop-=box.top-row.top;else if(row.bottom>box.bottom)list.scrollTop+=row.bottom-box.bottom;
      }else if([' ','Enter'].includes(event.key)){event.preventDefault();event.target.checked=!event.target.checked;event.target.dispatchEvent(new Event('change',{bubbles:true}));}
    });
    const outside=event=>{if(!shell.contains(event.target))shell.open=false;};document.addEventListener('pointerdown',outside);window.usageCharts.track(root,()=>document.removeEventListener('pointerdown',outside));
    const picker={shell,get:()=>[...values],set,update,load};select._modelPicker=picker;load();return picker;
  }
  window.usageFilters={range,keys,models,supplierId:r=>r.kind==='custom'?'custom:'+(r.supplierName||new URL(r.apiUrl).hostname):r.kind,presets};
})();
