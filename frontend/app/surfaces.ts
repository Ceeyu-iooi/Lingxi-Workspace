import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { rows } from './motion';

const w = window as any;
type SurfaceKind = 'preview' | 'preview-dark' | 'prices' | 'design';
type Layer = {kind:SurfaceKind;dialog:HTMLDialogElement;dispose?:()=>void;focus:Element|null;theme:string|undefined};
const stack: Layer[] = [];
let sequence=0, syncing=Promise.resolve();
const kinds = new Set<SurfaceKind>(['preview','preview-dark','prices','design']);
const stateKinds = ():SurfaceKind[] => (history.state?.lingxiSurfaces||[]).filter((kind:SurfaceKind)=>kinds.has(kind));
const esc=(text:string)=>text.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
async function mount(kind:SurfaceKind, origin?:Element|null) {
  const dialog=document.createElement('dialog');dialog.className='lingxi-surface';dialog.dataset.page=kind==='prices'?'prices':'preview';dialog.setAttribute('aria-label',kind==='prices'?'模型价格与汇率':kind==='design'?'设计规范':'设计系统预览');
  const layer:Layer={kind,dialog,focus:origin||document.activeElement,theme:document.documentElement.dataset.theme};
  (dialog as any)._openAnchor=origin;(dialog as any)._closeAnchor=origin;
  const body=document.createElement('div');body.className=kind.startsWith('preview')?'lingxi-preview':'lingxi-surface-content';dialog.append(body);
  dialog.addEventListener('cancel',event=>{event.preventDefault();back();});
  dialog.addEventListener('close',()=>{layer.dispose?.();dialog.remove();w.WorkbenchReact?.cleanup();},{once:true});
  dialog.addEventListener('click',event=>{const link=(event.target as Element).closest('[data-return]');if(link){event.preventDefault();back();}});
  document.body.append(dialog);stack.push(layer);dialog.showModal();
  try {
    if(kind.startsWith('preview')) {
      const {mountPreview}=await import('./preview');
      if(!dialog.isConnected||!stack.includes(layer))return;
      layer.dispose=mountPreview(body,{dark:kind==='preview-dark'?true:undefined});
    } else if(kind==='design') {
      body.innerHTML='<header class="preview-top"><strong>灵犀设计规范</strong><button class="onboarding-action secondary design-toc-toggle" data-toggle-toc aria-expanded="false">目录</button><div class="preview-top-actions"><button class="onboarding-action secondary" data-copy-design>复制规范</button><button class="onboarding-action secondary" data-return>返回</button></div></header><div class="surface-scroll"><div class="design-layout"><aside class="design-toc" aria-label="规范目录"><strong>CONTENTS</strong><nav></nav></aside><main class="design-reader" aria-busy="true">正在读取规范…</main></div></div>';
      const response=await fetch('/design.md',{redirect:'error'});if(!response.ok)throw Error('设计规范暂不可用');const text=await response.text();
      if(!dialog.isConnected||!stack.includes(layer))return;
      const content=body.querySelector<HTMLElement>('main')!;
      const front=text.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
      const prose=front?text.slice(front[0].length):text;
      content.innerHTML=(front?'<details class="design-reader-tokens"><summary>查看设计令牌</summary><pre><code>'+esc(front[0])+'</code></pre></details>':'')+DOMPurify.sanitize(await marked.parse(prose),{FORBID_TAGS:['script','iframe','img','object','embed'],FORBID_ATTR:['style']});content.removeAttribute('aria-busy');
      body.querySelector<HTMLButtonElement>('[data-copy-design]')!.onclick=()=>navigator.clipboard.writeText(text).then(()=>w.workbenchNotify?.('已复制设计规范',{kind:'success'})).catch(()=>w.workbenchNotify?.('复制失败，请选中文字复制',{kind:'error'}));
      const toc=body.querySelector<HTMLElement>('.design-toc')!, headings=[...content.querySelectorAll<HTMLElement>('h1,h2,h3')];
      const controller=new AbortController(),scroll=body.querySelector<HTMLElement>('.surface-scroll')!;
      headings.forEach((heading,index)=>{heading.id='design-heading-'+index;const button=document.createElement('button');button.type='button';button.dataset.level=heading.tagName.slice(1);button.textContent=heading.textContent;button.onclick=()=>{heading.scrollIntoView({behavior:w.WorkbenchMotion.quiet()?'instant':'smooth',block:'start'});toc.dataset.open='false';body.querySelector('[data-toggle-toc]')?.setAttribute('aria-expanded','false');};toc.querySelector('nav')!.append(button);});
      const toggle=body.querySelector<HTMLButtonElement>('[data-toggle-toc]')!;toggle.onclick=()=>{const open=toc.dataset.open!=='true';toc.dataset.open=String(open);toggle.setAttribute('aria-expanded',String(open));};
      let frame=0;const buttons=[...toc.querySelectorAll('button')];
      const highlight=()=>{frame=0;let active=0;const edge=dialog.getBoundingClientRect().top+100;headings.forEach((heading,i)=>{if(heading.getBoundingClientRect().top<=edge)active=i;});buttons.forEach((button,i)=>button.setAttribute('aria-current',String(i===active)));};
      scroll.addEventListener('scroll',()=>{if(!frame)frame=requestAnimationFrame(highlight);},{passive:true,signal:controller.signal});highlight();
      requestAnimationFrame(()=>{Promise.allSettled(dialog.getAnimations().map(animation=>animation.finished)).then(()=>{if(!controller.signal.aborted)highlight();});});
      layer.dispose=()=>{controller.abort();cancelAnimationFrame(frame);};
    } else {
      body.innerHTML='<header class="preview-top"><strong>模型价格与汇率</strong><button class="onboarding-action secondary" data-return>返回</button></header><div class="surface-scroll"><main class="wb-standalone"><div data-standalone-body></div></main></div>';
      const content=body.querySelector<HTMLElement>('[data-standalone-body]')!;
      layer.dispose=()=>{(content as any)._wbDispose?.();};
      await w.WorkbenchPrices.mount(content);
      if(!dialog.isConnected||!stack.includes(layer))return;
      const stop=rows(content);layer.dispose=()=>{stop();(content as any)._wbDispose?.();};
    }
    if(dialog.isConnected)w.WorkbenchWindow?.mount(body.querySelector('.preview-top'));
  } catch(error) {
    if(dialog.isConnected)body.innerHTML='<header class="preview-top"><strong>暂时无法打开</strong><button class="onboarding-action secondary" data-return>返回</button></header><p class="design-reader" role="alert">'+esc((error as Error).message)+'</p>';
  }
}
function sync() {
  const ticket=++sequence,target=stateKinds();
  syncing=syncing.then(async()=>{
    if(ticket!==sequence)return;
    let shared=0;while(shared<stack.length&&shared<target.length&&stack[shared].kind===target[shared])shared++;
    while(stack.length>shared){const layer=stack.pop()!;await new Promise<void>(resolve=>{layer.dialog.addEventListener('close',()=>resolve(),{once:true});layer.dialog.close();if(!layer.dialog.open)resolve();});document.documentElement.dataset.theme=layer.theme||'light';if(layer.focus instanceof HTMLElement&&layer.focus.isConnected)layer.focus.focus({preventScroll:true});}
    for(let i=shared;i<target.length&&ticket===sequence;i++)await mount(target[i]);
  }).catch(()=>{});
}
function open(kind:SurfaceKind,origin?:Element|null) {
  if(!kinds.has(kind))return;
  // Same URL history entries leave the mounted business route and its DOM intact.
  history.pushState({...history.state,lingxiSurfaces:[...stack.map(layer=>layer.kind),kind]},'',location.href);
  syncing=syncing.then(()=>mount(kind,origin)).catch(()=>{});
}
function back(){if(stack.length)history.back();}
document.addEventListener('click',event=>{
  if(event.defaultPrevented||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey||event.button!==0)return;
  const link=(event.target as Element)?.closest<HTMLAnchorElement>('a[href]');if(!link||link.hasAttribute('download'))return;
  const url=new URL(link.href,location.href);if(url.origin!==location.origin)return;
  const name=url.pathname.split('/').pop()!;
  const kind:SurfaceKind|undefined=name==='preview.html'?'preview':name==='preview-dark.html'?'preview-dark':name==='prices.html'?'prices':name==='design.md'?'design':undefined;
  if(kind){event.preventDefault();open(kind,link);}
});
window.addEventListener('popstate',sync);
window.addEventListener('hashchange',()=>{if(stack.length){history.replaceState({...history.state,lingxiSurfaces:[]},'',location.href);sync();}});
window.addEventListener('workbench:state',(event:any)=>{if(!event.detail?.user&&stack.length){history.replaceState({...history.state,lingxiSurfaces:[]},'',location.href);sync();}});
w.WorkbenchSurfaces={open,back,isOpen:()=>stack.length>0};
