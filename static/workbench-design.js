(() => {
  'use strict';
  const snapshots = new Map(), frames = new Map();
  let identity = '', active = null;
  const reduced = () => (document.documentElement.dataset.motion==='reduced'||matchMedia('(prefers-reduced-motion: reduce)').matches);
  const key = node => node.nodeType === 1 ? node.id || ['id','project','task','session','section','month','key'].map(k => node.dataset[k] ? `${node.tagName}:${k}:${node.dataset[k]}` : '').find(Boolean) || '' : '';
  const semantic = node => node?.classList?.contains('wb-select') ? node.querySelector('select') : node;
  const compatible = (a,b) => a && b && a.nodeType === b.nodeType && a.nodeName === b.nodeName;
  function morph(old, next) {
    if (old.nodeType === 3) { if (old.data !== next.data) old.data = next.data; return; }
    const value = /^(INPUT|TEXTAREA|SELECT)$/.test(old.tagName) ? old.value : null;
    const dirty = old.dataset.wbDirty === 'true' || old === document.activeElement;
    const resizable=old.classList.contains('resizable-panel');
    const opened=old.tagName==='DETAILS'?old.open:null;
    const numeric=old.matches('strong,b') && !old.children.length && !next.children.length && /^[¥￥+−\d\s,.%\-]+$/.test(old.textContent) && /^[¥￥+−\d\s,.%\-]+$/.test(next.textContent);
    for (const attr of [...old.attributes]) if (!next.hasAttribute(attr.name) && !['data-wb-dirty','data-layout-index','tabindex'].includes(attr.name)) old.removeAttribute(attr.name);
    for (const attr of next.attributes) if (old.getAttribute(attr.name) !== attr.value) {if(old.namespaceURI==='http://www.w3.org/2000/svg'&&['points','d','cy','height'].includes(attr.name))geometry(old,attr.name,attr.value);else old.setAttribute(attr.name, attr.value);}
    if (old.tagName === 'TEXTAREA' || old.tagName === 'INPUT') {
      if (!dirty && old.type !== 'file') old.value = next.value;
      if (old.type === 'checkbox' && !dirty) old.checked = next.checked;
      return;
    }
    if(resizable)old.classList.add('resizable-panel');
    if(numeric)number(old,next.textContent);else if(!next.dataset.wbSlot||next.childNodes.length)reconcile(old,next);
    if(opened!==null)old.open=opened;
    if (old.tagName === 'SELECT' && value !== null && [...old.options].some(o => o.value === value)) old.value = value;
  }
  function reconcile(parent, template) {
    const oldNodes = [...parent.childNodes], used = new Set();
    const keyed = new Map(oldNodes.map(n => [key(semantic(n)), n]).filter(([k]) => k));
    let cursor = parent.firstChild;
    for (const wanted of [...template.childNodes]) {
      const wantedKey = key(wanted);
      let node = wantedKey ? keyed.get(wantedKey) : oldNodes.find(n => !used.has(n) && !key(semantic(n)) && compatible(semantic(n), wanted));
      if (!compatible(semantic(node), wanted)) node = wanted.cloneNode(true);
      else morph(semantic(node), wanted);
      used.add(node);
      if (cursor !== node) parent.insertBefore(node, cursor);
      cursor = node.nextSibling;
    }
    oldNodes.forEach(n=>{if(!used.has(n)&&!n.matches?.('.resize-corner,.card-drag-handle,.ws-divider,.col-dividers'))n.remove();});
  }
  function paint(root, html) {
    const template = document.createElement('template'); template.innerHTML = html;
    reconcile(root, template.content);
    window.roundedSelects?.scan();
  }
  function number(node, text) {
    const previous = node.textContent;
    if (previous === String(text)) return;
    node.textContent = text;
    if (!reduced() && previous && /\d/.test(previous) && /\d/.test(String(text))) {
      node.dataset.oldValue = previous;
      node.getAnimations?.().forEach(a=>a.cancel());node.classList.remove('wb-count');
      node.animate?.([{transform:'translateY(4px)'},{transform:'translateY(0)'}], {duration:280,easing:'cubic-bezier(.2,.7,.3,1)'});
      node.classList.add('wb-count');node.animate?.([{transform:'translateY(0)'},{transform:'translateY(-110%)'}],{duration:280,pseudoElement:'::before',fill:'forwards',easing:'cubic-bezier(.2,.7,.3,1)'});
    }
  }
  function geometry(node, attr, value) {
    const previous = node.getAttribute(attr) || '';
    if (previous === value) return;
    const existing = frames.get(node);
    if (existing) { cancelAnimationFrame(existing.id); frames.delete(node); }
    const before = previous.match(/-?\d+(?:\.\d+)?/g)?.map(Number), after = value.match(/-?\d+(?:\.\d+)?/g)?.map(Number);
    if (reduced() || !before?.length || before.length !== after?.length){node.setAttribute(attr,value);return;}
    const start = performance.now(), animation = {id:0, finish:()=>node.setAttribute(attr,value)};
    const step = time => {
      if (!node.isConnected) { frames.delete(node); return; }
      const progress = Math.min(1, Math.max(0,(time-start)/320)), eased = 1-Math.pow(1-progress,3);
      let index=0;
      node.setAttribute(attr,value.replace(/-?\d+(?:\.\d+)?/g,()=>String(before[index]+(after[index]-before[index++])*eased)));
      if (progress<1) animation.id=requestAnimationFrame(step); else { animation.finish();frames.delete(node); }
    };
    frames.set(node,animation);step(start);
  }
  function reveal(root) {
    if (reduced() || root.dataset.wbRevealed) return;
    const nodes=[...root.querySelectorAll('.card,.hot-card,.ob-panel,.ob-stats>article,.resource-row,.agent-chat,.agent-sessions,.workspace-browser,.workspace-files')].slice(0,6);if(!nodes.length)return;
    root.dataset.wbRevealed='true';
    nodes.forEach((el,i) => el.animate?.([{opacity:.92,transform:'translateY(6px)'},{opacity:1,transform:'none'}],{duration:180,delay:i*20,easing:'cubic-bezier(.2,.7,.3,1)'}));
  }
  function capture(root) {
    const fields = {};
    root.querySelectorAll('input[id],textarea[id],select[id]').forEach(el => {
      if (el.type === 'password' || el.type === 'file' || /key|token|secret|password|credential|ws-editor|ws-proposal|^sum-|^agent-/i.test(el.id)) return;
      if (el.dataset.wbDirty === 'true' || el.type === 'search') fields[el.id]={value:el.value,checked:el.checked};
    });
    return {fields,custom:root._wbSnapshot?.(),scroll:root.parentElement?.scrollTop||0};
  }
  function restore(root, saved) {
    if (!saved) return;
    Object.entries(saved.fields).forEach(([id,value]) => {
      const el=root.querySelector('#'+CSS.escape(id));if(!el)return;
      el.value=value.value;if(el.type==='checkbox')el.checked=value.checked;
      el.dataset.wbDirty='true';
      if(el.type==='search')el.dispatchEvent(new Event('input',{bubbles:true}));
    });
    window.roundedSelects?.scan();if(root.parentElement)root.parentElement.scrollTop=saved.scroll;
  }
  function activate(main, view, owner) {
    if(owner!==identity){if(active)dispose(active.root);active=null;snapshots.clear();identity=owner;}
    if(active?.view===view && active.root.isConnected) return active.root;
    if(active){snapshots.set(active.view,capture(active.root));dispose(active.root);}
    const root=document.createElement('div');root.className=view==='usage'?'module-surface':'module-surface wb-redesign';root.dataset.module=view;
    root.addEventListener('input',event=>{if(event.target.matches('input,textarea,select'))event.target.dataset.wbDirty='true';});
    root.addEventListener('change',event=>{if(event.target.matches('input,textarea,select'))event.target.dataset.wbDirty='true';});
    root._wbAbort=new AbortController();main.replaceChildren(root);active={view,root};
    root._wbSaved=snapshots.get(view);return root;
  }
  function finish(root) { restore(root,root._wbSaved);root._wbSaved=null;reveal(root); }
  function dispose(root) {
    root._wbAbort?.abort();root._columnResizeObserver?.disconnect();root._columnResizeAbort?.abort();
    [root,...root.querySelectorAll('.control-host,#settings-panel')].forEach(el=>{el._workspaceDispose?.();el._wbDispose?.();el._workspaceDispose=null;el._wbDispose=null;});
    for(const [node,frame] of frames)if(root.contains(node)){cancelAnimationFrame(frame.id);frame.finish();frames.delete(node);}
    root.getAnimations?.({subtree:true}).forEach(a=>a.cancel());
  }
  function clear(){if(active)dispose(active.root);active=null;identity='';snapshots.clear();}
  const unsaved=()=>!!active?.root._wbUnsaved?.() || !!active?.root.querySelector('#settings-panel')?._wbUnsaved?.();
  window.workbenchDesign={paint,number,geometry,reveal,activate,finish,dispose,clear,unsaved};
})();
