/** Numeric interpolation shared by usage metrics and the taskbar panel. */
const counters = new WeakMap<HTMLElement,{value:number;frame:number;cancel:()=>void}>();
export function animateCount(node:HTMLElement,target:number|null,format:(value:number|null)=>string,replay=false,quiet=false){
 const old=counters.get(node);old?.cancel();
 const from=replay?0:old?.value??target;
 const state={value:from??0,frame:0,cancel:()=>{cancelAnimationFrame(state.frame);motion?.cancel()}};
 let motion:Animation|undefined;
 counters.set(node,state);
 const paint=(value:number|null)=>{state.value=value??0;node.textContent=format(value)};
 if(target===null||!Number.isFinite(target)||from===null||quiet||!old&&!replay||from===target){paint(target);return state.cancel}
 if(replay)motion=node.animate([{transform:'translateY(4px)'},{transform:'translateY(0)'}],{duration:280,easing:'cubic-bezier(.2,.7,.3,1)'});
 const start=performance.now();
 const tick=(now:number)=>{if(!node.isConnected)return;const p=Math.min(1,(now-start)/280);paint(p===1?target:from+(target-from)*(1-(1-p)**3));if(p<1)state.frame=requestAnimationFrame(tick)};
 state.frame=requestAnimationFrame(tick);return state.cancel;
}
