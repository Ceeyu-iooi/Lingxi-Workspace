/* Shared DOM titlebar; the preload exposes only bounded window operations. */
(()=>{
 const bridge=window.workbenchDesktop,disposers=new Map();let observer;
 const mount=host=>{
  if(!bridge?.windowAction||!host||host.querySelector('.lingxi-window-controls'))return ()=>{};
  document.documentElement.classList.add('desktop-shell');
  const controls=document.createElement('div');controls.className='lingxi-window-controls';
  const icons={minimize:'<path d="M4 12h12"/>',maximize:'<rect x="4" y="4" width="12" height="12"/>',restore:'<path d="M7 7V4h9v9h-3"/><rect x="4" y="7" width="9" height="9"/>',close:'<path d="m5 5 10 10M15 5 5 15"/>'};
  for(const [action,label] of [['minimize','最小化'],['maximize','最大化'],['close','关闭']]){const button=document.createElement('button');button.type='button';button.dataset.windowAction=action;button.setAttribute('aria-label',label);button.title=label;button.innerHTML='<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">'+icons[action]+'</svg>';button.onclick=()=>bridge.windowAction(action).catch(()=>{});controls.append(button);}
  host.append(controls);
  const paint=state=>{if(!controls.isConnected)return;const button=controls.querySelector('[data-window-action=maximize]');button.setAttribute('aria-label',state.maximized?'还原':'最大化');button.title=state.maximized?'还原':'最大化';button.innerHTML='<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">'+icons[state.maximized?'restore':'maximize']+'</svg>';};
  bridge.windowState().then(paint).catch(()=>{});const unsubscribe=bridge.onWindowState(paint);
  const dispose=()=>{unsubscribe();disposers.delete(host);controls.remove();if(!disposers.size){observer?.disconnect();observer=null;}};disposers.set(host,dispose);
  if(!observer){observer=new MutationObserver(()=>{for(const [node,cleanup] of disposers)if(!node.isConnected)cleanup();});observer.observe(document.body,{childList:true,subtree:true});}
  return dispose;
 };
 window.WorkbenchWindow={mount};
 const start=()=>document.querySelectorAll('.shell-bar,.preview-top,.onboarding-top,.desktop-start-titlebar,.wb-standalone-header').forEach(mount);
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
