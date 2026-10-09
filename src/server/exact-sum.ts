import {Decimal} from 'decimal.js';
const parsed=new Map<string,{n:bigint;scale:number}|null>(),powers=new Map<number,bigint>([[0,1n]]);function pow(n:number){let value=powers.get(n);if(value===undefined){value=10n**BigInt(n);powers.set(n,value);}return value;}
export class ExactSum {
 private n=0n;private scale=0;private fallback?:Decimal;
 add(value:any){if(value==null)return;const text=String(value);if(this.fallback){this.fallback=this.fallback.plus(text);return;}let item=parsed.get(text);if(item===undefined){const match=text.match(/^(-?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);if(!match)item=null;else{const fraction=match[3]||'',scale=fraction.length-Number(match[4]||0);item=Math.abs(scale)>256?null:{n:BigInt((match[1]||'')+match[2]+fraction),scale};if(item&&item.scale<0){item.n*=pow(-item.scale);item.scale=0;}}parsed.set(text,item);while(parsed.size>512)parsed.delete(parsed.keys().next().value!);}if(!item){this.fallback=new Decimal(this.string()).plus(text);return;}if(item.scale>this.scale){this.n*=pow(item.scale-this.scale);this.scale=item.scale;}this.n+=item.n*pow(this.scale-item.scale);}
 private string(){const negative=this.n<0n,digits=(negative?-this.n:this.n).toString().padStart(this.scale+1,'0'),text=this.scale?digits.slice(0,-this.scale)+'.'+digits.slice(-this.scale):digits;return (negative?'-':'')+text;}
 result(){return this.fallback?this.fallback.toString():new Decimal(this.string()).toString();}
}
