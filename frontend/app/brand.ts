/** Original Lingxi identity. Maintainer selected the calm orbit for application loading. */
import '../../static/brand.css';
export type BrandVariant = 'static' | 'breath' | 'trace' | 'orbit';
export const loadingVariant: BrandVariant = 'orbit';
export function brandMark(variant: BrandVariant = loadingVariant, size: 'small' | 'large' = 'small') {
  return `<span class="lingxi-mark lingxi-mark--${size}" data-brand-motion="${variant}" aria-hidden="true"><svg viewBox="0 0 120 120" fill="none"><g class="lingxi-mark-body"><path class="lingxi-arc lingxi-arc-a" pathLength="100" d="M60 34C41 20 23 37 28 57c3 13 19 19 32 29"/><path class="lingxi-arc lingxi-arc-b" pathLength="100" d="M60 86c19 14 37-3 32-23C89 50 73 44 60 34"/><path d="m46 62 14-14 14 14-14 14Z" fill="currentColor"/><circle cx="60" cy="62" r="5" class="lingxi-mark-eye"/></g><circle class="lingxi-orbit" cx="60" cy="60" r="55" pathLength="100"/></svg></span>`;
}
function loader(host: HTMLElement, label = '正在读取…', status = 'working') {
  host.setAttribute('role', 'status');host.setAttribute('aria-live', 'polite');
  host.replaceChildren();host.insertAdjacentHTML('afterbegin', brandMark(status === 'working' ? loadingVariant : 'static'));
  if (label) {const text=document.createElement('span');text.className='lingxi-loader-label';text.textContent=label;host.append(text);}
  return () => host.replaceChildren();
}
function progress(host: HTMLElement, input: number) {
  const value=Math.min(100,Math.max(0,Number.isFinite(input)?input:0));
  host.setAttribute('role','progressbar');host.setAttribute('aria-label','准备进度');
  host.setAttribute('aria-valuemin','0');host.setAttribute('aria-valuemax','100');host.setAttribute('aria-valuenow',String(value));
  let bar=host.querySelector<HTMLElement>('.lingxi-progress-fill');
  if(!bar){host.replaceChildren();host.classList.add('lingxi-progress');bar=document.createElement('span');bar.className='lingxi-progress-fill';bar.setAttribute('aria-hidden','true');host.append(bar);}
  bar.style.transform=`scaleX(${value/100})`;
  return ()=>host.replaceChildren();
}
const w=window as any;
w.WorkbenchBrand={mark:brandMark,loader,progress,loadingVariant};
if(w.WorkbenchReact){w.WorkbenchReact.loader=loader;w.WorkbenchReact.progress=progress;}
