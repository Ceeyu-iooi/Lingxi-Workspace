import {createHash} from 'node:crypto';
import {zstdCompressSync,zstdDecompressSync} from 'node:zlib';
import type SQLite from './sqlite.ts';
const magic=Buffer.from('LXZ1'),digest=(raw:Buffer)=>createHash('sha256').update(raw).digest();
export function packText(value:string):string|Buffer{
  const raw=Buffer.from(value);if(raw.length<128)return value;if(raw.length>4*1024*1024)throw Error('目录正文超过保存限制');
  const body=zstdCompressSync(raw);if(body.length+40>=raw.length)return value;
  const header=Buffer.alloc(40);magic.copy(header);header.writeUInt32BE(raw.length,4);digest(raw).copy(header,8);return Buffer.concat([header,body]);
}
export function unpackText(value:any):string{
  if(typeof value==='string')return value;const body=Buffer.from(value);
  if(body.length<40||!body.subarray(0,4).equals(magic))throw Error('目录正文压缩格式无效');
  const size=body.readUInt32BE(4);if(size>4*1024*1024)throw Error('目录正文长度无效');
  const raw=zstdDecompressSync(body.subarray(40),{maxOutputLength:size+1});if(raw.length!==size||!digest(raw).equals(body.subarray(8,40)))throw Error('目录正文校验失败');return raw.toString();
}
/** Only old plaintext catalogue entries need conversion; future scans write
 * this representation directly. Original text and metadata remain exact. */
export function compactSkillCatalog(db:SQLite,limit=Infinity){
  if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='skill_catalog'").get())return 0;
  const rows=db.prepare("SELECT owner,id,body,meta FROM skill_catalog WHERE typeof(body)='text' OR typeof(meta)='text'").iterate(),put=db.prepare('UPDATE skill_catalog SET body=?,meta=? WHERE owner=? AND id=?');let changed=0;
  const same=(a:any,b:any)=>typeof a==='string'?a===b:b instanceof Uint8Array&&a.equals(Buffer.from(b));
  for(const row of rows){const body=unpackText(row.body),meta=unpackText(row.meta),a=packText(body),b=packText(meta);if(same(a,row.body)&&same(b,row.meta))continue;
    if(unpackText(a)!==body||unpackText(b)!==meta)throw Error('目录压缩改变了原始文本');put.run(a,b,row.owner,row.id);if(++changed>=limit)break;}
  return changed;
}
