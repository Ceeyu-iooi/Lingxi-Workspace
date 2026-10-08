/* Credential-free evidence collector sent only to explicitly configured SSH hosts. */
export function remoteCollector(offset: number) {
  return String.raw`
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const base=fs.realpathSync(process.env.WORKBENCH_CODEX_SOURCE_ROOT||process.env.CODEX_HOME||path.join(os.homedir(),'.codex')),paths=[],seen=new Set();
function inside(file){const rel=path.relative(base,file);return rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);}
function walk(root){if(!fs.existsSync(root))return;const real=fs.realpathSync(root);if(!inside(real)||seen.has(real))return;seen.add(real);for(const item of fs.readdirSync(real,{withFileTypes:true})){const file=path.join(real,item.name);if(item.isDirectory())walk(file);else if(item.isFile()&&item.name.endsWith('.jsonl')){const canonical=fs.realpathSync(file);if(inside(canonical))paths.push(canonical);}}}
walk(path.join(base,'sessions'));walk(path.join(base,'archived_sessions'));paths.sort();
const parse=s=>JSON.parse(s,(k,v,c)=>typeof v==='number'&&!Number.isSafeInteger(v)&&Number.isInteger(v)&&c?.source&&/^-?\d+$/.test(c.source)?BigInt(c.source):v);
const encode=v=>JSON.stringify(v,(_k,x)=>typeof x==='bigint'?JSON.rawJSON(x.toString()):x);
function compact(r){if(!r||typeof r!=='object'||Array.isArray(r))return null;let p=r.payload||{};if(!p||typeof p!=='object'||Array.isArray(p))return null;const kind=r.type;
 if(kind==='session_meta')p=Object.fromEntries(Object.entries(p).filter(([k])=>['id','session_id','model_provider','cwd','timestamp','forked_from_id','originator'].includes(k)));
 else if(kind==='turn_context')p={model:p.model??null};
 else if(kind==='event_msg'&&p.type==='token_count'){const info=p.info||{};if(!info||typeof info!=='object'||Array.isArray(info))throw Error('消费证据格式不正确');p={type:'token_count',info:Object.fromEntries(Object.entries(info).filter(([k])=>['last_token_usage','total_token_usage','response_id'].includes(k)).map(([k,v])=>[k,v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).filter(([f])=>['input_tokens','output_tokens','cached_input_tokens','cache_write_input_tokens','reasoning_output_tokens','total_tokens'].includes(f))):v])),...(p.response_id?{response_id:p.response_id}:{})};}
 else return null;return {type:kind,payload:p,...Object.fromEntries(Object.entries(r).filter(([k])=>['timestamp','response_id'].includes(k)))};
}
async function read(file){let parts=[],size=0,skip=false,hasUsage=false,total=0;const output=[];for await(const chunk of fs.createReadStream(file,{highWaterMark:128*1024})){let start=0;for(let i=0;i<chunk.length;i++)if(chunk[i]===10){if(!skip){parts.push(chunk.subarray(start,i));const line=Buffer.concat(parts).toString('utf8');let row;try{row=parse(line);}catch{if(line.slice(0,600).includes('"token_count"'))throw Error('用量证据损坏');}if(row){const retained=compact(row);if(retained){const line=encode(retained)+'\n';total+=Buffer.byteLength(line);if(total>8*1024*1024)throw Error('单个会话证据过大，请分段导出并保留会话元数据');output.push(line);hasUsage||=retained.type==='event_msg';}}}parts=[];size=0;skip=false;start=i+1;}if(start<chunk.length&&!skip){parts.push(chunk.subarray(start));size+=chunk.length-start;if(size>8*1024*1024){const head=Buffer.concat(parts).subarray(0,600).toString('utf8');if(!head.includes('"response_item"'))throw Error('单条用量证据过大');skip=true;parts=[];size=0;}}}return hasUsage?output.join(''):null;}
(async()=>{const files=[];let size=0;for(let i=${offset};i<paths.length;i++){const content=await read(paths[i]);if(!content)continue;const bytes=Buffer.byteLength(content);if(files.length&&(files.length>=100||size+bytes>12*1024*1024)){console.log(encode({files,next:i}));return;}files.push({name:path.basename(paths[i]),content});size+=bytes;}console.log(encode({files,next:null}));})().catch(error=>{console.error(error.message);process.exitCode=1;});
`;
}
