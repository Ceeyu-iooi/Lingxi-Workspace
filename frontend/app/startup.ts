import '../../static/startup.css';
const cover=document.getElementById('startup-cover');
if((window as any).workbenchDesktop?.resumeState)void (window as any).workbenchDesktop.resumeState().then((state:any)=>{if(state.resuming)cover?.remove();}).catch(()=>{});
let finishing:Promise<void>|null=null;
const began=performance.now();
function finish(){
 if(finishing)return finishing;
 finishing=(async()=>{
  if(!cover||!cover.isConnected)return;
  await Promise.allSettled([document.fonts.ready,...[...cover.querySelectorAll('img')].map(image=>image.decode())]);
  await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
  const wait=(window as any).workbenchDesktop?0:Math.max(0,2000-(performance.now()-began));
  if(wait)await new Promise(resolve=>setTimeout(resolve,wait));
  const quiet=document.documentElement.dataset.motion==='reduced'||matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(!quiet){const root=document.getElementById('react-root');const incoming=root?.animate([{opacity:0},{opacity:1}],{duration:500,easing:'cubic-bezier(.22,1,.36,1)'});const outgoing=cover.animate([{opacity:1},{opacity:0}],{duration:500,easing:'cubic-bezier(.22,1,.36,1)',fill:'forwards'});await Promise.allSettled([outgoing.finished,incoming?.finished]);}
  cover.remove();
 })();return finishing;
}
(window as any).WorkbenchStartup={finish};
