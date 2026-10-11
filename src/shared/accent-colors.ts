type RGB = [number,number,number];
const rgb=(hex:string):RGB=>{
  const value=hex.replace(/^#/,'');
  const full=value.length===3?value.split('').map(c=>c+c).join(''):value;
  if(!/^[\da-f]{6}$/i.test(full))throw Error('强调色必须是有效的十六进制颜色');
  return [0,2,4].map(i=>parseInt(full.slice(i,i+2),16)) as RGB;
};
const hex=(c:RGB)=>'#'+c.map(n=>Math.round(n).toString(16).padStart(2,'0')).join('');
const mix=(a:RGB,b:RGB,weight:number):RGB=>a.map((n,i)=>Math.round(n*weight+b[i]*(1-weight))) as RGB;
const luminance=(c:RGB)=>c.map(n=>{const v=n/255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
const ratio=(a:RGB,b:RGB)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};

/** Keep the strong fill, soft surface and their text roles independent. */
export function accentColors(accent:string,mode:string){
  const strong=rgb(accent),ink=rgb(mode==='dark'?'#f0f4f8':'#151517');
  const soft=mix(strong,rgb(mode==='dark'?'#151c22':'#ffffff'),mode==='dark'?.16:.10);
  let text=strong;
  for(let step=1;ratio(text,soft)<4.5&&step<=10;step++)text=mix(strong,ink,1-step/10);
  const white=rgb('#ffffff'),black=rgb('#000000');
  const foreground=ratio(white,strong)>=ratio(black,strong)?white:black;
  return {strong:hex(strong),soft:hex(soft),text:hex(text),foreground:hex(foreground)};
}
