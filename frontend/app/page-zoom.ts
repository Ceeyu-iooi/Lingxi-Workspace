let zoom=100;
export function setZoom(value:number){
  zoom=Math.max(60,Math.min(160,Number(value)||100));
  document.documentElement.style.setProperty('--ui-scale','1');
  document.documentElement.style.setProperty('--page-scale',String(zoom/100));
  document.documentElement.dataset.uiScale=String(zoom);
  try{localStorage.setItem('wb-page-zoom',String(zoom));}catch{}
  window.dispatchEvent(new Event('workbench:zoom'));
}
try{setZoom(Number(localStorage.getItem('wb-page-zoom'))||100);}catch{setZoom(100);}
(window as any).WorkbenchPageZoom={set:setZoom};
window.addEventListener('keydown',event=>{
  if(!(event.ctrlKey||event.metaKey)||event.altKey||!['+','=','-','0'].includes(event.key)||document.documentElement.dataset.valuationBusy==='true')return;
  event.preventDefault();event.stopImmediatePropagation();setZoom(event.key==='0'?100:zoom+(event.key==='-'?-10:10));
},{capture:true});
window.addEventListener('wheel',event=>{if(!event.ctrlKey||document.documentElement.dataset.valuationBusy==='true')return;event.preventDefault();setZoom(zoom+(event.deltaY>0?-5:5));},{passive:false,capture:true});
