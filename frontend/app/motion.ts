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
  this.querySelectorAll('.control-dialog-actions,.wb-dialog-foot').forEach(footer=>{const buttons=[...footer.children].filter(child=>child instanceof HTMLButtonElement);buttons.sort((a,b)=>Number(b.classList.contains('btn')&&!b.classList.contains('ghost')&&!b.classList.contains('danger'))-Number(a.classList.contains('btn')&&!a.classList.contains('ghost')&&!a.classList.contains('danger'))).forEach(button=>footer.append(button));});
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
  grouped.forEach(item => {if(item.top-top>4){row++;top=item.top;}delays.set(item.node,Math.min(row*60,300));});
  const running = new Set<Animation>();
  const play = (node: HTMLElement, delay = 0) => {
    const animation=node.animate([{opacity:0,transform:'translateY(12px)'},{opacity:1,transform:'translateY(0)'}],{duration:300,delay,easing:ease,fill:'backwards'});
    running.add(animation); void animation.finished.catch(()=>{}).finally(()=>running.delete(animation));
  };
  let observer: IntersectionObserver | undefined;
  if (scrolling) {
    observer=new IntersectionObserver(entries=>{const visible=entries.filter(entry=>entry.isIntersecting).sort((a,b)=>a.boundingClientRect.top-b.boundingClientRect.top);let line=-1,last=-Infinity;visible.forEach(entry=>{if(entry.boundingClientRect.top-last>4){line++;last=entry.boundingClientRect.top;}play(entry.target as HTMLElement,Math.min(line*60,300));observer!.unobserve(entry.target);});},{root:root.closest('.lingxi-surface') || null,threshold:.08});
    grouped.forEach(({node})=>observer!.observe(node));
  } else grouped.forEach(({node})=>play(node,delays.get(node)));
  return () => {observer?.disconnect();running.forEach(animation=>animation.cancel());running.clear();};
}
(window as any).WorkbenchMotion = {rows,quiet,anchor,closeNow(dialog: HTMLDialogElement){(dialog as any)._skipMotion=true;nativeClose.call(dialog);delete (dialog as any)._skipMotion;}};
export { rows, quiet };
