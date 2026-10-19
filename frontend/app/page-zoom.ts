let zoom=100;
export function setZoom(value:number, persist=true){
  zoom=Math.max(60,Math.min(160,Number(value)||100));
  document.documentElement.style.setProperty('--ui-scale','1');
  document.documentElement.style.setProperty('--page-scale',String(1.15*zoom/100));
  document.documentElement.dataset.uiScale=String(zoom);
  try{localStorage.setItem('wb-page-zoom',String(zoom));}catch{}
  if(persist){(window as any).wbLayoutStorage?.setItem('wb-page-zoom',String(zoom));(window as any).wbLayoutStorage?.setItem('wb-page-zoom-baseline','115');}
  window.dispatchEvent(new Event('workbench:zoom'));
}
const legacy=(value:unknown,baseline:unknown)=>{const n=Number(value)||100;return baseline==='115'||n===100?n:Math.max(60,Math.min(160,Math.round(n/1.15)));};
try{const n=legacy(localStorage.getItem('wb-page-zoom'),localStorage.getItem('wb-page-zoom-baseline'));setZoom(n,false);localStorage.setItem('wb-page-zoom-baseline','115');}catch{setZoom(100,false);}
(window as any).WorkbenchPageZoom={set:setZoom,get:()=>zoom,migrate:legacy};
window.addEventListener('keydown',event=>{
  if(!(event.ctrlKey||event.metaKey)||event.altKey||!['+','=','-','_','0'].includes(event.key)||document.documentElement.dataset.valuationBusy==='true')return;
  event.preventDefault();event.stopImmediatePropagation();setZoom(event.key==='0'?100:zoom+(['-','_'].includes(event.key)?-10:10));
},{capture:true});
window.addEventListener('wheel',event=>{if(!event.ctrlKey||document.documentElement.dataset.valuationBusy==='true')return;event.preventDefault();setZoom(zoom+(event.deltaY>0?-5:5));},{passive:false,capture:true});
