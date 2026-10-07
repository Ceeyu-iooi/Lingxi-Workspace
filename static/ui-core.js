/* One native adapter layer for business UI, loaders, previews and internal stories. */
(() => {
  const e=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const el=(tag,attrs={},children=[])=>{const n=document.createElement(tag);for(const [k,v] of Object.entries(attrs)){if(k==='class')n.className=v;else if(k==='text')n.textContent=v;else if(k.startsWith('on'))n.addEventListener(k.slice(2),v);else if(v!==null&&v!==undefined)n.setAttribute(k,String(v));}for(const child of Array.isArray(children)?children:[children])n.append(typeof child==='string'?document.createTextNode(child):child);return n;};
  function radio(host,options){host.classList.add('wb-choice');return window.WorkbenchReact.radio(host,{items:options.items.map(item=>Array.isArray(item)?{value:item[0],label:item[1]}:item),value:options.value,onChange:options.onChange,disabled:options.disabled,ariaLabel:options.label});}
  const pendingLoads=new WeakMap();
  function busy(host,label='正在读取…',delay=150){
    let state=pendingLoads.get(host),ended=false;
    if(!state){state={count:0,place:el('span',{class:'wb-loading-seat'})};pendingLoads.set(host,state);state.timer=setTimeout(()=>{if(host.isConnected){host.append(state.place);state.dispose=window.WorkbenchReact.loader(state.place,label);}},delay);}
    state.count++;host.setAttribute('aria-busy','true');
    return ()=>{if(ended)return;ended=true;if(--state.count)return;clearTimeout(state.timer);state.dispose?.();state.place.remove();host.removeAttribute('aria-busy');pendingLoads.delete(host);};
  }
  async function request(method,url,body,options){
    const call=window.workbenchRequest||(async(m,u,b,opt)=>{const r=await fetch(u,{method:m,headers:b?{'Content-Type':'application/json'}:{},body:b?JSON.stringify(b):undefined,signal:opt?.signal});const d=await r.json();if(!r.ok){const x=new Error(d.error||'请求失败');Object.assign(x,d,{status:r.status});throw x;}return d;});
    try{return await call(method,url,body,options);}catch(error){if(error.message&&error.message.includes('其他窗口')){const r=await fetch(url.replace(/\?.*/, '')+'/item?id='+encodeURIComponent(body?.id||''),{signal:options?.signal}).catch(()=>null);if(r?.ok)error.current=await r.json();}throw error;}
  }
  async function job(task,{signal,onProgress}={}){
    let current=task;
    while(current.status==='running'){
      if(signal?.aborted)throw new DOMException('页面已切换','AbortError');onProgress?.(current.progress);
      await new Promise((resolve,reject)=>{const abort=()=>{clearTimeout(id);reject(new DOMException('页面已切换','AbortError'));};const id=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},500);signal?.addEventListener('abort',abort,{once:true});});
      current=await request('GET','/api/jobs?id='+encodeURIComponent(task.id),undefined,{signal});
    }
    if(current.status!=='complete')throw new Error(current.error||'任务没有完成');return current.result;
  }
  const notify=message=>typeof toast==='function'?toast(message):console.info(message);
  async function fileBase64(file){const bytes=new Uint8Array(await file.arrayBuffer());let value='';for(let i=0;i<bytes.length;i+=8192)value+=String.fromCharCode(...bytes.slice(i,i+8192));return btoa(value);}
  function dialog(title,body,{beforeClose}={}){
    const d=el('dialog',{class:'wb-editor-dialog','aria-label':title});d.innerHTML=`<header class="wb-dialog-head"><h2>${e(title)}</h2><button type="button" class="btn ghost" data-modal-close aria-label="关闭">×</button></header><div class="wb-dialog-body">${body}</div><footer class="wb-dialog-foot"></footer>`;
    const focus=document.activeElement;document.body.append(d);const close=force=>{if(!force&&beforeClose&&!beforeClose())return false;d.close();return true;};d.querySelector('[data-modal-close]').onclick=()=>close(false);d.addEventListener('cancel',event=>{event.preventDefault();close(false);});d.addEventListener('close',()=>{d.remove();window.WorkbenchReact.cleanup();if(focus?.isConnected)focus.focus({preventScroll:true});});d.showModal();return {d,close};
  }
  function promptCard(item,{market=false,selected=false,draggable=true}={}){
    return `<article class="wb-library-card" data-id="${e(item.id||'demo')}" data-source="${e(item.source||'')}" ${!market&&draggable?'draggable="true"':''} aria-selected="${selected}" tabindex="0"><div class="wb-card-top">${!market?`<input type="checkbox" data-select aria-label="选择 ${e(item.title)}" ${selected?'checked':''}>`:''}<h3>${e(item.title)}</h3>${item.pinned?'<span class="wb-pill">置顶</span>':''}${item.favorite?'<span class="wb-pill">收藏</span>':''}</div><p class="wb-card-excerpt">${e(item.excerpt||'')}</p><div class="wb-card-bottom">${(item.tags||[]).slice(0,5).map(tag=>`<span class="wb-pill">${e(tag)}</span>`).join('')}<span class="wb-muted">${market?e(item.origin?.license||'来源模板'):e(item.format||'markdown')+' · '+(item.uses||0)+' 次使用'}</span><div class="wb-card-actions">${market?'<button class="btn ghost" data-open>预览</button><button class="btn" data-apply>保存到我的库</button>':'<button class="btn ghost" data-copy>复制</button><button class="btn ghost" data-open>编辑</button><button class="btn ghost" data-pin>'+(item.pinned?'取消置顶':'置顶')+'</button><button class="btn ghost" data-fav>'+(item.favorite?'取消收藏':'收藏')+'</button>'}</div></div></article>`;
  }
  function actionMenu(items){const d=el('dialog',{class:'global-context-menu','aria-label':'页面操作',role:'menu'});d.append(el('div',{class:'context-title',text:'页面操作'}));items.forEach((item,i)=>{const b=el('button',{type:'button',role:'menuitem','data-menu-index':i,text:item.label});b.disabled=!!item.disabled;d.append(b);});return d;}
  function download(file){const bytes=file.base64?Uint8Array.from(atob(file.base64),c=>c.charCodeAt(0)):file.content;const url=URL.createObjectURL(new Blob([bytes],{type:file.mime||'text/plain'}));const a=el('a',{href:url,download:file.filename||'export.txt'});a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  function markdown(host,content){host.classList.add('wb-markdown');host.innerHTML=window.WorkbenchReact.markdown(content);host.querySelectorAll('a').forEach(a=>{a.target='_blank';a.rel='noopener noreferrer';});}
  function richText(doc){const walk=n=>n.type==='text'?n.text||'':(n.content||[]).map(walk).join('')+(['paragraph','heading','listItem'].includes(n.type)?'\n':'');return walk(doc);}
  function richHTML(doc){
    const walk=n=>{if(n.type==='text'){let value=e(n.text||'');for(const mark of n.marks||[]){const tag={bold:'strong',italic:'em',underline:'u',strike:'s',code:'code'}[mark.type];if(tag)value='<'+tag+'>'+value+'</'+tag+'>';}return value;}
      const tag={doc:'div',paragraph:'p',heading:'h2',bulletList:'ul',orderedList:'ol',listItem:'li',blockquote:'blockquote',codeBlock:'pre',hardBreak:'br'}[n.type]||'p';return '<'+tag+'>'+(n.content||[]).map(walk).join('')+'</'+tag+'>';};
    return window.WorkbenchReact.sanitize(walk(doc));
  }
  function richDoc(host){
    const marks={STRONG:'bold',B:'bold',EM:'italic',I:'italic',U:'underline',S:'strike',CODE:'code'};
    const inline=(node,chain=[])=>{if(node.nodeType===3)return node.textContent?[{type:'text',text:node.textContent,...(chain.length?{marks:chain.map(type=>({type}))}:{})}]:[];if(node.nodeType!==1)return [];if(node.tagName==='BR')return [{type:'hardBreak'}];const more=marks[node.tagName]?[...chain,marks[node.tagName]]:chain;return [...node.childNodes].flatMap(n=>inline(n,more));};
    const content=[...host.childNodes].map(node=>node.nodeType===1&&['H1','H2','H3'].includes(node.tagName)?{type:'heading',attrs:{level:2},content:inline(node)}:{type:'paragraph',content:inline(node)});return {type:'doc',content};
  }
  function preview(host,body,format){host.replaceChildren();try{if(format==='markdown')markdown(host,body);else if(format==='rich'){host.classList.add('wb-markdown');host.innerHTML=richHTML(JSON.parse(body));}else {const pre=el('pre',{class:'wb-text-preview',text:format==='json'?JSON.stringify(JSON.parse(body),null,2):body});host.append(pre);}}catch{host.append(el('p',{class:'wb-inline-error',text:'格式暂不完整；原文和草稿已保留。'}),el('pre',{class:'wb-text-preview',text:body}));}}
  function diff(host,before,after){
    const a=String(before).split('\n'),b=String(after).split('\n');let prefix=0,suffix=0;
    while(prefix<Math.min(a.length,b.length)&&a[prefix]===b[prefix])prefix++;
    while(suffix<Math.min(a.length,b.length)-prefix&&a[a.length-1-suffix]===b[b.length-1-suffix])suffix++;
    host.classList.add('wb-editor-columns');host.replaceChildren();
    for(const [lines,title,kind] of [[a,'原文','removed'],[b,'建议 / 历史版本','added']]){const seat=el('section'),pre=el('pre',{class:'wb-text-preview wb-diff'});seat.append(el('h4',{text:title}),pre);lines.slice(0,2000).forEach((line,i)=>pre.append(el('span',{class:i>=prefix&&i<lines.length-suffix?'wb-diff-'+kind:'',text:line+'\n'})));if(lines.length>2000)seat.append(el('p',{class:'wb-muted',text:'仅展示前2000行；完整内容仍保留。'}));host.append(seat);}
  }
  const registry=[['button','按钮'],['field','输入与选择'],['choice','JellyRadio 胶囊'],['loader','LatticeLoader 加载'],['progress','WakeSlider 进度'],['dialog','弹窗与抽屉'],['filter','筛选面板'],['table','数据表格'],['card','统计与内容卡'],['chart','趋势、占比与条形'],['editor','编辑与安全预览'],['account','账户与头像'],['menu','菜单与反馈']];
  const controls=new WeakMap();
  function refreshControls(root){
    root.querySelectorAll('.wb-setting-switch input[type=checkbox],.settings-content .control-checkbox input[type=checkbox],.control-dialog .control-checkbox input[type=checkbox],#appearance-font,#appearance-brightness').forEach(input=>{
      let state=controls.get(input);
      if(!state){
        const slider=input.id==='appearance-font'||input.id==='appearance-brightness',host=el('span',{class:slider?'wb-slider-host':'wb-switch-host'});
        input.hidden=true;input.tabIndex=-1;input.after(host);
        state={host,slider};controls.set(input,state);
        input.addEventListener('change',()=>refreshControls(input.parentElement));input.addEventListener('input',()=>refreshControls(input.parentElement));
      }
      const labelNode=input.closest('label')?.querySelector('span:not(.wb-switch-host)')||input.closest('label');
      const label=input.getAttribute('aria-label')||[...(labelNode?.childNodes||[])].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim()||input.name||input.id;
      if(state.slider)window.WorkbenchReact.wakeSlider(state.host,{value:Number(input.value),min:Number(input.min),max:Number(input.max),step:Number(input.step),ariaLabel:label,disabled:input.disabled,formatValue:v=>v+(input.id==='appearance-font'?' px':'%'),onChange:v=>{input.value=String(v);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));}});
      else window.WorkbenchReact.squishSwitch(state.host,{checked:input.checked,disabled:input.disabled,ariaLabel:label,onChange:checked=>{input.checked=checked;input.dispatchEvent(new Event('change',{bubbles:true}));}});
    });
  }
  registry.push(['commit','SlideCommit 确认'],['switch','SquishSwitch 开关'],['slider','WakeSlider 调节']);
  window.WorkbenchUI={e,el,radio,busy,request,job,notify,download,fileBase64,dialog,promptCard,actionMenu,markdown,richText,richHTML,richDoc,preview,diff,registry,refreshControls,version:'0.0.31'};
  let frame;
  const upgrade=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{window.WorkbenchReact.cleanup();document.querySelectorAll('.settings-content,.control-dialog').forEach(root=>{if([...root.querySelectorAll('input')].some(input=>!controls.has(input)&&input.matches('input[type=checkbox],#appearance-font,#appearance-brightness')))refreshControls(root);});document.querySelectorAll('.control-loading:not([data-lattice]),.module-loading:not([data-lattice])').forEach(host=>{const label=host.textContent||'正在读取…';host.dataset.lattice='true';window.WorkbenchReact.loader(host,label);});});};
  const observer=new MutationObserver(upgrade);observer.observe(document.documentElement,{childList:true,subtree:true});
})();
