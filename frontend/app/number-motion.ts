import './number-motion.css';
const running=new WeakMap<HTMLElement,()=>void>();
const values=new WeakMap<HTMLElement,string>();
export function animateNumber(node:HTMLElement,text:string,replay=false,quiet=false){
 const previous=values.get(node)??node.textContent??text;running.get(node)?.();values.set(node,text);node.textContent=text;
 if(quiet||!/[0-9]/.test(text)||!replay&&previous===text)return()=>{};
 node.style.setProperty('--number-ink',getComputedStyle(node).color);node.dataset.oldValue=previous===text?text.replace(/[1-9]/g,'0'):previous;node.dataset.newValue=text;node.classList.add('wb-count');
 const opts={duration:320,easing:'cubic-bezier(.22,1,.36,1)',fill:'both' as FillMode};
 const animations=[node.animate([{transform:'translateY(0)',opacity:1},{transform:'translateY(-100%)',opacity:0}],{...opts,pseudoElement:'::before'}),node.animate([{transform:'translateY(100%)',opacity:0},{transform:'translateY(0)',opacity:1}],{...opts,pseudoElement:'::after'})];
 const clean=()=>{if(running.get(node)!==clean)return;running.delete(node);animations.forEach(a=>a.cancel());node.classList.remove('wb-count');delete node.dataset.oldValue;delete node.dataset.newValue;node.style.removeProperty('--number-ink')};running.set(node,clean);Promise.all(animations.map(a=>a.finished)).then(clean,()=>{});return clean;
}
