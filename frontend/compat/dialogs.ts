// @ts-nocheck
/** Shared Harness-style window shell. All close routes use one lifecycle. */
(() => {
  if(window.WorkbenchDialogs)return;
  const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function open({title,body='',size='medium',actions=[],beforeClose,initialFocus,origin,closeOrigin}={}){
    const focus=document.activeElement,d=document.createElement('dialog');let closed=false,busy=false;
    d._openAnchor=origin;d._closeAnchor=closeOrigin;
    d.className='control-dialog lingxi-dialog wb-editor-dialog';d.dataset.dialogSize=size;d.setAttribute('aria-label',title);
    d.innerHTML=`<header class="control-dialog-head wb-dialog-head"><h2>${escape(title)}</h2><button type="button" class="lingxi-dialog-close btn ghost" data-modal-close aria-label="关闭">×</button></header><div class="lingxi-dialog-body wb-dialog-body">${body}</div><p class="lingxi-dialog-error" role="alert" hidden></p><footer class="control-dialog-actions wb-dialog-foot"></footer>`;
    const close=(force=false)=>{if(closed)return true;if(!force&&beforeClose){const accepted=beforeClose();if(accepted&&typeof accepted.then==='function'){accepted.then(value=>{if(value!==false)close(true);});return false;}if(accepted===false)return false;}closed=true;d.close();return true;};
    d.querySelector('[data-modal-close]').onclick=()=>close();
    d.addEventListener('cancel',event=>{event.preventDefault();close();});
    d.addEventListener('close',()=>{closed=true;d.remove();window.WorkbenchReact?.cleanup();if(focus?.isConnected)focus.focus({preventScroll:true});},{once:true});
    const foot=d.querySelector('footer');
    for(const action of [...actions].sort((a,b)=>(b.kind==='primary')-(a.kind==='primary'))){const button=document.createElement('button');button.type='button';button.className='btn'+(action.kind==='primary'?'':action.kind==='danger'?' danger':' ghost');button.textContent=action.label;button.dataset.dialogAction=action.id||action.label;button.onclick=async()=>{if(busy)return;if(!action.onClick){await close();return;}busy=true;button.disabled=true;const error=d.querySelector('[role=alert]');error.hidden=true;try{if(await action.onClick({d,close})===true)await close(true);}catch(e){if(d.isConnected){error.textContent=e.message||'操作失败，请重试';error.hidden=false;}}finally{busy=false;if(button.isConnected)button.disabled=false;}};foot.append(button);}
    document.body.append(d);d.showModal();if(initialFocus)d.querySelector(initialFocus)?.focus();return {d,close,body:d.querySelector('.lingxi-dialog-body'),footer:foot};
  }
  window.WorkbenchDialogs={open};
})();
