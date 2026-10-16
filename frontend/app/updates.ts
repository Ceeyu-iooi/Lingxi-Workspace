import {marked} from 'marked';
import DOMPurify from 'dompurify';
const w=window as any;
let current:any={status:'idle'},started=false,checkJob:Promise<any>|null=null;
const request=async(method:string,url:string)=>{const response=await fetch(url,{method,headers:method==='POST'?{'Content-Type':'application/json'}:undefined,body:method==='POST'?'{}':undefined});const value=await response.json();if(!response.ok)throw Error(value.error||'更新操作失败');return value;};
const bridge=()=>w.workbenchDesktop||{updateState:()=>request('GET','/api/updates/state'),checkUpdate:()=>request('POST','/api/updates/check'),startupCheck:()=>request('POST','/api/updates/startup'),downloadUpdate:()=>request('POST','/api/updates/download'),cancelUpdate:()=>request('POST','/api/updates/cancel')};
function paint(){
  const profile=document.getElementById('control-profile');if(!profile)return;
  let button=document.getElementById('sidebar-update') as HTMLButtonElement|null;
  if(!button){button=document.createElement('button');button.id='sidebar-update';button.type='button';button.textContent='更新';button.title='查看新版本';button.setAttribute('aria-label','查看新版本');button.onclick=open;profile.parentElement!.append(button);}
  button.hidden=!current.availableVersion;
  const about=document.querySelector<HTMLElement>('[data-about-update-status]');if(about)about.textContent=current.error||(current.status==='checking'?'正在检查更新…':current.availableVersion?'发现新版本 '+current.availableVersion:current.status==='latest'?'当前已是最新版本':'');
  window.dispatchEvent(new CustomEvent('workbench:update',{detail:{...current}}));
}
async function check(){if(checkJob)return checkJob;checkJob=bridge().checkUpdate().then((value:any)=>{current=value;paint();return value;}).catch((error:Error)=>{current={...current,status:'error',error:error.message||'检查更新失败'};paint();return current;}).finally(()=>checkJob=null);return checkJob;}
function open(){
  const shell=w.WorkbenchDialogs.open({title:current.availableVersion?'更新至 '+current.availableVersion:'更新详情',body:'<div class="lingxi-release-notes"></div><p data-update-message role="status"></p><div class="lingxi-download"><div class="lingxi-download-label"><span data-percent></span><span data-bytes></span></div><progress max="100" value="0"></progress></div>',actions:[{id:'later',label:'稍后'},{id:'download',label:'下载更新',kind:'primary',disabled:()=>['downloading','installing'].includes(current.status),onClick:async()=>{if(checkJob){await checkJob;if(!alive)return false;}if(current.status==='error'){current=await check();render();return false;}if(current.status==='downloaded'){await w.wbLayoutStorage?.flush?.();if(w.workbenchDesktop)await bridge().installUpdate();else{const a=document.createElement('a');a.href='/api/updates/file';a.click();}return true;}current={...current,status:'downloading',progress:0};render();const job=bridge().downloadUpdate();void poll();void Promise.resolve(job).then((value:any)=>{current=value;paint();render();}).catch((error:Error)=>{current={...current,status:'error',error:error.message};paint();render();});return false;}}]});
  const notes=shell.body.querySelector('.lingxi-release-notes');let notesVersion:string|null=null;const updateNotes=()=>{if(notesVersion===String(current.availableVersion||''))return;notesVersion=String(current.availableVersion||'');notes.innerHTML=DOMPurify.sanitize(marked.parse(String(current.releaseNotes||'尚未获取更新详情。')) as string,{ALLOWED_TAGS:['h2','h3','h4','p','ul','ol','li','strong','em','code','pre','a','br','hr'],ALLOWED_ATTR:['href','title']});
  notes.querySelectorAll('a').forEach((a:HTMLAnchorElement)=>{if(!a.href.startsWith('https://'))a.removeAttribute('href');else{a.target='_blank';a.rel='noopener noreferrer';}});};updateNotes();
  let timer:ReturnType<typeof setTimeout>|undefined,alive=true,polling=false;
  const render=()=>{if(!alive)return;const downloading=current.status==='downloading',downloaded=current.status==='downloaded';const button=shell.footer.querySelector('[data-dialog-action=download]');button.textContent=current.status==='error'?'重新检查':downloaded?(w.workbenchDesktop?'重启安装':'获取安装包'):'下载更新';button.disabled=downloading||current.status==='installing';button.hidden=!current.availableVersion||!['available','cancelled','downloading','downloaded','installing','error'].includes(current.status);shell.body.querySelector('[data-update-message]').textContent=current.error||(current.status==='cancelled'?'下载已取消，可重新下载':downloaded?'下载与校验完成':downloading?(current.total>0&&current.transferred>=current.total?'下载完成，正在校验…':'正在下载…'):'');shell.body.querySelector('.lingxi-download').hidden=!downloading&&!downloaded;if(current.total>0||downloaded)shell.body.querySelector('progress').value=current.progress||0;else shell.body.querySelector('progress').removeAttribute('value');shell.body.querySelector('[data-percent]').textContent=current.total>0||downloaded?Math.round(current.progress||0)+'%':'进度待确定';shell.body.querySelector('[data-bytes]').textContent=current.total>0?((current.transferred||0)/1e6).toFixed(1)+' MB / '+(current.total/1e6).toFixed(1)+' MB':'总量待确定';};
  const poll=async()=>{if(!alive||polling)return;polling=true;try{current=await bridge().updateState();paint();render();}catch(error){shell.body.querySelector('[data-update-message]').textContent=(error as Error).message;}finally{polling=false;if(alive&&current.status==='downloading')timer=setTimeout(poll,500);}};
  const updated=()=>{if(alive){updateNotes();render();}};window.addEventListener('workbench:update',updated);shell.d.addEventListener('close',()=>{alive=false;clearTimeout(timer);window.removeEventListener('workbench:update',updated);},{once:true});render();if(current.status==='downloading')void poll();
}
w.WorkbenchUpdates={check,open,state:()=>({...current})};
window.addEventListener('workbench:state',async(event:any)=>{if(!event.detail?.user||started)return;started=true;try{if(w.workbenchDesktop){current=await bridge().updateState();paint();if(current.status==='checking'){const wait=async()=>{current=await bridge().updateState();paint();if(current.status==='checking')setTimeout(()=>void wait().catch(()=>{}),1000);};void wait();}}else{current=await bridge().startupCheck();paint();}}catch{}});

// One activation can produce both focus and visibilitychange. Merge that burst,
// while allowing a new check on every later visit. Downloads stay authoritative.
let activationTimer:ReturnType<typeof setTimeout>|undefined;
function activationCheck(){
 clearTimeout(activationTimer);
 activationTimer=setTimeout(()=>{
  if(!started||document.visibilityState==='hidden'||w.WorkbenchSurfaces?.isOpen()||['downloading','downloaded','installing'].includes(current.status))return;
  void check();
 },100);
}
window.addEventListener('focus',activationCheck);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')activationCheck();else clearTimeout(activationTimer);});
window.addEventListener('workbench:main-return',activationCheck);
window.addEventListener('pageshow',event=>{if(event.persisted)activationCheck();});
window.addEventListener('pagehide',()=>clearTimeout(activationTimer));
