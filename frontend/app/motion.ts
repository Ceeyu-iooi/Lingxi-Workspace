// Shared presentation lifecycle; business values and persistence stay unchanged.
const quiet = () => document.documentElement.dataset.motion === 'reduced' || matchMedia('(prefers-reduced-motion: reduce)').matches;
const ease = 'cubic-bezier(.22,1,.36,1)';
const nativeShow = HTMLDialogElement.prototype.showModal;
const nativeClose = HTMLDialogElement.prototype.close;
const origins = new WeakMap<HTMLDialogElement, DOMRect>();
const closing = new WeakSet<HTMLDialogElement>();
let trigger: Element | null = null,triggerRect:DOMRect|null=null,triggerAt=0;
document.addEventListener('click', event => { triggerAt=performance.now(); trigger = event.target instanceof Element ? event.target.closest('button,a,label,[role=button]') : null;triggerRect=anchor(trigger); }, true);
function anchor(element: Element | DOMRect | null | undefined) {
  if (element instanceof DOMRect) return element;
  if (!element?.isConnected) return null;
  const rect = element.getBoundingClientRect();
  return rect.width && rect.height ? rect : null;
}
function expand(node: HTMLElement, origin: DOMRect | null, leaving = false) {
  if (quiet()) return Promise.resolve();
  const rect = node.getBoundingClientRect();
  const x = origin ? origin.left + origin.width / 2 - rect.left - rect.width / 2 : 0;
  const y = origin ? origin.top + origin.height / 2 - rect.top - rect.height / 2 : 8;
  const start = { opacity: 0, transform: origin ? `translate(${x}px,${y}px) scale(.08)` : 'translateY(8px) scale(.98)' };
  const end = { opacity: 1, transform: 'translate(0,0) scale(1)' };
  node.getAnimations().forEach(animation => animation.cancel());
  return node.animate(leaving ? [end,start] : [start,end], { duration: leaving ? 200 : 260, easing: ease }).finished.catch(() => {});
}
HTMLDialogElement.prototype.showModal = function () {
  if (!(this as any)._motionCancelInstalled) {
    (this as any)._motionCancelInstalled=true;
    this.addEventListener('cancel',event=>{if(!event.defaultPrevented){event.preventDefault();this.close();}});
  }
  this.querySelectorAll('.control-dialog-actions,.wb-dialog-foot').forEach(footer=>{const buttons=[...footer.children].filter(child=>child instanceof HTMLButtonElement);buttons.sort((a,b)=>Number(a.classList.contains('btn')&&!a.classList.contains('ghost')&&!a.classList.contains('danger'))-Number(b.classList.contains('btn')&&!b.classList.contains('ghost')&&!b.classList.contains('danger'))).forEach(button=>footer.append(button));});
  nativeShow.call(this);
  const origin = anchor((this as any)._openAnchor || (performance.now()-triggerAt<1000?triggerRect:null) || document.activeElement);
  if (origin) origins.set(this, origin);
  if (!(this as any)._skipMotion && !quiet()) {this.style.opacity='0';(this as any)._motionFrame=requestAnimationFrame(()=>{this.style.removeProperty('opacity');if(this.open&&!closing.has(this))void expand(this,origin);});}
};
HTMLDialogElement.prototype.close = function (value?: string) {
  if (!this.open || closing.has(this)) return;
  closing.add(this);cancelAnimationFrame((this as any)._motionFrame);this.style.removeProperty("opacity");
  const destination = anchor((this as any)._closeAnchor) || origins.get(this) || null;
  const finish = () => { closing.delete(this); if (this.open) nativeClose.call(this, value); };
  if (quiet() || (this as any)._skipMotion) finish();
  else void expand(this, destination, true).then(finish);
};
function rows(root: HTMLElement, scrolling = false) {
  if (quiet()) return () => {};
  const selector = '[data-motion-row],.preview-card,.preview-swatch,.wb-library-toolbar,.library-toolbar,.wb-library-head,.wb-empty,.empty,.usage-toolbar,.preview-type-row,.preview-section>h2,.preview-section>.preview-lead,.card,.hot-card,.ob-panel,.ob-stats>article,.control-section,.sum-card,.wb-library-card,.resource-row,.workspace-browser,.workspace-files,.dsh-setting-row,.wb-setting-switch,.usage-summary>article,.usage-lifetime>article,.lingxi-account-details>section,.account-quota-window';
  const selected = [...root.querySelectorAll<HTMLElement>(selector)].filter(node=>node.offsetHeight && !(node.matches('.control-section')&&node.querySelector('.dsh-setting-row,.wb-setting-switch')));
  const ancestors=new Set(selected);
  const candidates=selected.filter(node=>{for(let parent=node.parentElement;parent&&parent!==root;parent=parent.parentElement)if(ancestors.has(parent))return false;return true;});
  const grouped = candidates.map(node => ({node, top:node.getBoundingClientRect().top})).sort((a,b) => a.top-b.top);
  let row = -1, top = -Infinity;
  const delays = new Map<HTMLElement, number>();
    grouped.forEach(item => {if(item.top-top>4){row++;top=item.top;}delays.set(item.node,Math.min(row*70,280));});
  const running = new Map<HTMLElement,Animation>();
  const originalOpacity = new Map(candidates.map(node=>[node,node.style.opacity]));
  const visible = new Set<HTMLElement>();
  const play = (node: HTMLElement, delay = 0) => {
    running.get(node)?.cancel();node.style.opacity='1';
    const heroEntry=node.matches('.preview-hero-copy-inner,.brand-visual-inner');
    const animation=node.animate([{opacity:0,transform:`translateY(${heroEntry?18:scrolling?28:20}px)`},{opacity:1,transform:'translateY(0)'}],{duration:heroEntry?680:scrolling?520:420,delay,easing:ease,fill:'backwards'});
    running.set(node,animation);void animation.finished.catch(()=>{}).finally(()=>{if(running.get(node)===animation)running.delete(node);});
  };
  let observer: IntersectionObserver | undefined;
  if (scrolling) {
    observer=new IntersectionObserver(entries=>{
      const entering=entries.filter(entry=>entry.isIntersecting).sort((a,b)=>a.boundingClientRect.top-b.boundingClientRect.top);
      let line=-1,last=-Infinity;
      entering.forEach(entry=>{const node=entry.target as HTMLElement;if(visible.has(node))return;visible.add(node);if(entry.boundingClientRect.top-last>4){line++;last=entry.boundingClientRect.top;}if(!quiet())play(node,Math.min(line*70,280));else node.style.opacity='1';});
      entries.filter(entry=>!entry.isIntersecting).forEach(entry=>{const node=entry.target as HTMLElement;visible.delete(node);running.get(node)?.cancel();node.style.opacity=quiet()?'1':'0';});
    },{root:root.closest('.lingxi-surface') || null,threshold:[0,.08]});
    grouped.forEach(({node})=>{node.style.opacity='0';observer!.observe(node);});
  } else grouped.forEach(({node})=>play(node,delays.get(node)));
  const restore=()=>{if(quiet()){running.forEach(animation=>animation.cancel());candidates.forEach(node=>node.style.opacity='1');}};
  const media=matchMedia('(prefers-reduced-motion: reduce)');media.addEventListener('change',restore);
  const preferences=new MutationObserver(restore);preferences.observe(document.documentElement,{attributes:true,attributeFilter:['data-motion']});
  return () => {observer?.disconnect();preferences.disconnect();media.removeEventListener('change',restore);running.forEach(animation=>animation.cancel());running.clear();originalOpacity.forEach((opacity,node)=>{node.style.opacity=opacity;});};
}
(window as any).WorkbenchMotion = {rows,quiet,anchor,closeNow(dialog: HTMLDialogElement){(dialog as any)._skipMotion=true;nativeClose.call(dialog);delete (dialog as any)._skipMotion;}};
export { rows, quiet };
