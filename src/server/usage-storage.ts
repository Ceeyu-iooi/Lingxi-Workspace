import { createHash } from 'node:crypto';
import { inflateSync, zstdCompressSync, zstdDecompressSync, constants } from 'node:zlib';
import type SQLite from './sqlite.ts';
import type {ProfileStore} from './profile.ts';
import {compactSkillCatalog} from './compressed-text.ts';

/** Compatibility views keep the public consumption identities unchanged. Only
 * queryable fields stay in the indexed rows; exact legacy JSON lives in packs. */
const dictionaryColumns = new Set(['owner','source','agent','provider','model','session','project','status','connection_id','requested_model','auth_mode','path','reason','currency']);
const tables: Record<string,{ columns:string[]; key:string[]; cold?:string[] }> = {
  events:{columns:['owner','id','at','source','agent','provider','model','session','project','status','input','output','cached','reasoning','total','duration_ms','cost','currency','connection_id','requested_model','auth_mode'],key:['owner','id']},
  codex_evidence:{columns:['owner','id','session','at','provider','model','cumulative','last_usage','usage','baseline','reason','verified','raw','lineage'],key:['owner','id'],cold:['cumulative','last_usage','usage','baseline','raw','lineage']},
  agent_evidence:{columns:['owner','id','source','raw','digest','version','verified','reason'],key:['owner','id'],cold:['raw']},
  codex_links:{columns:['owner','path','id'],key:['owner','path','id']},
  valuation_dirty:{columns:['owner','id'],key:['owner','id']},
  radar_values:{columns:['owner','id','currency','fingerprint','result'],key:['owner','id','currency'],cold:['result']},
};
const q=(name:string)=>'"'+name.replaceAll('"','""')+'"';
const hash=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
const idPrefixes=['codex:v4:s:','codex:v4:c:','codex:v4:','zcode:','dsh:'];
function packId(value:any):string|Buffer{
  if(typeof value!=='string')return value;
  const match=/^([\s\S]*)([a-f0-9]{64})$/.exec(value);if(!match)return value;
  const prefix=idPrefixes.indexOf(match[1]),digest=Buffer.from(match[2],'hex');
  return prefix<0?Buffer.concat([Buffer.from([1]),Buffer.from(match[1]),digest]):Buffer.concat([Buffer.from([16+prefix]),digest]);
}
function unpackId(value:any):string{
  if(typeof value==='string')return value;const bytes=Buffer.from(value);
  if(bytes[0]===1&&bytes.length>=33)return bytes.subarray(1,-32).toString()+bytes.subarray(-32).toString('hex');
  if(bytes.length===33&&bytes[0]>=16&&bytes[0]<16+idPrefixes.length)return idPrefixes[bytes[0]-16]+bytes.subarray(1).toString('hex');
  throw Error('消费身份编码无效');
}
function idExpression(value:string){
  return "(CASE typeof("+value+") WHEN 'blob' THEN (CASE hex(substr("+value+",1,1)) WHEN '01' THEN CAST(substr("+value+",2,length("+value+")-33) AS TEXT) "+idPrefixes.map((prefix,i)=>"WHEN '"+(16+i).toString(16).toUpperCase()+"' THEN '"+prefix+"'").join(' ')+" END)||lower(hex(substr("+value+",-32))) ELSE "+value+" END)";
}
export function rewriteUsageIdSQL(sql:string){return sql.replace(/\blingxi_id\(((?:"[^"]+"|[a-zA-Z_]\w*)(?:\.(?:"[^"]+"|[a-zA-Z_]\w*))?)\)/g,(_match,value)=>idExpression(value));}
function ensureIdentityJoins(db:SQLite){
  const views=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='view' AND instr(sql,'LEFT JOIN usage_ids')>0").all();
  if(!views.length)return;db.exec('BEGIN IMMEDIATE');try{for(const view of views){const triggers=db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=?").all(view.name);db.exec('DROP VIEW '+q(view.name));db.exec(view.sql.replaceAll('LEFT JOIN usage_ids','JOIN usage_ids'));for(const trigger of triggers)db.exec(trigger.sql);}db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
}
function compactIds(db:SQLite){
  if(Number(db.pragma('user_version',{simple:true}))>=6)return;
  const definitions=db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE type IN ('view','trigger')").all();
  const rewrite=(sql:string)=>sql.replaceAll('"d_id".value','lingxi_id("d_id".value)').replaceAll('i.value AS id','lingxi_id(i.value) AS id').replaceAll('SELECT value FROM usage_ids','SELECT lingxi_id(value) FROM usage_ids').replace(/SELECT NEW\.(?:"id"|id) WHERE/g,'SELECT lingxi_pack_id(NEW.id) WHERE').replace(/value=lingxi_pack_id\((NEW|OLD)\.id\)/g,'lingxi_id(value)=$1.id').replace(/value=(NEW|OLD)\.(?:"id"|id)/g,'lingxi_id(value)=$1.id');
  const foreign=db.pragma('foreign_keys',{simple:true});db.exec('PRAGMA foreign_keys=OFF;BEGIN IMMEDIATE');try{
    for(const kind of ['trigger','view'])for(const row of definitions.filter((r:any)=>r.type===kind))db.exec('DROP '+kind+' '+q(row.name));
    // One index on the decoded public identity keeps compatibility-view point
    // queries indexed. Keeping only a binary-value index caused full scans.
    db.exec('CREATE TABLE usage_ids_new(k INTEGER PRIMARY KEY,value BLOB NOT NULL);INSERT INTO usage_ids_new SELECT k,lingxi_pack_id(value) FROM usage_ids;DROP TABLE usage_ids;ALTER TABLE usage_ids_new RENAME TO usage_ids;CREATE UNIQUE INDEX usage_id_external ON usage_ids('+idExpression('value')+')');
    for(const kind of ['view','trigger'])for(const row of definitions.filter((r:any)=>r.type===kind))db.exec(row.sql.includes('usage_ids')?rewriteUsageIdSQL(rewrite(row.sql)):row.sql);
    db.exec('PRAGMA user_version=6;COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}finally{db.exec('PRAGMA foreign_keys='+(foreign?'ON':'OFF'));}
}
export function initializeUsageStorage(profile:ProfileStore){
  const db=profile.db;
  if(Number(db.pragma('user_version',{simple:true}))>7)throw Error('用量数据库来自更新版本，请升级应用');
  registerStorageFunctions(db);
  const event=db.prepare("SELECT type FROM sqlite_schema WHERE name='events'").get();
  if(event?.type==='view'&&Number(db.pragma('user_version',{simple:true}))<7)installUsageStorage(db,false);
  const existing=Object.keys(tables).filter(name=>db.prepare("SELECT 1 FROM sqlite_schema WHERE name=? AND type IN ('table','view')").get(name));
  if(existing.includes('radar_values')&&(event?.type==='table'||event?.type==='view'&&Number(db.pragma('user_version',{simple:true}))<7)&&existing.some(name=>db.prepare('SELECT 1 FROM '+q(name)+' LIMIT 1').get())){
    const receipt=(database:SQLite)=>Object.fromEntries(existing.map(name=>{
      const digest=createHash('sha256');let count=0;
      for(const row of database.prepare('SELECT * FROM '+q(name)+' ORDER BY '+tables[name].key.map(q).join(',')).safeIntegers().iterate()){
        digest.update(JSON.stringify(row,(_key,value)=>typeof value==='bigint'?{integer:value.toString()}:value));count++;
      }
      return [name,{count,digest:digest.digest('hex')}];
    }));
    const before=JSON.stringify(receipt(db));
    profile.migrateDatabase(candidate=>{registerStorageFunctions(candidate);installUsageStorage(candidate);compactSkillCatalog(candidate);if(JSON.stringify(receipt(candidate))!==before)throw Error('迁移改变了用量记录或审计证据，原库保留');});
    registerStorageFunctions(profile.db);
  }
  return installUsageStorage(profile.db);
}
export function compactEventProjection(alias='e'){
  if(!/^[a-z]+$/.test(alias))throw Error('用量查询别名无效');
  return tables.events.columns.map(column=>{
    const field=alias+'.'+q(column);
    return (dictionaryColumns.has(column)||column==='id'?'(SELECT '+(column==='id'?'lingxi_id(value)':'value')+' FROM '+(column==='id'?'usage_ids':'usage_strings')+' WHERE k='+field+')':field)+' AS '+q(column);
  }).join(',');
}
export function installUsageStorage(db:SQLite,allowIdUpgrade=true){
  const present=db.prepare("SELECT type FROM sqlite_schema WHERE name='events'").get();
  if(!present)return false; // The first Monitor creates its initial schema.
  const migrated=present.type==='view';
  const cache=new Map<number,{body:any[];bytes:number}>();let bytes=0;
  const unpack=(delta:any,body:any,size:any,digest:any,pack:any,ordinal:any,field:any,format=1)=>{
    if(delta!==null){const value=JSON.parse(String(delta));return value[Number(field)]??null;}
    if(body===null||pack===null)throw Error('用量证据块不存在');
    let saved=cache.get(Number(pack));
    if(!saved){const length=Number(size);if(!Number.isSafeInteger(length)||length<0||length>4*1024*1024)throw Error('用量证据块长度无效');const raw=(format===2?zstdDecompressSync:inflateSync)(Buffer.from(body),{maxOutputLength:length+1});if(raw.length!==length||hash(raw)!==digest)throw Error('用量证据块校验失败');saved={body:JSON.parse(raw.toString()),bytes:raw.length*2};if(saved.bytes<=2*1024*1024){cache.set(Number(pack),saved);bytes+=saved.bytes;while(bytes>2*1024*1024&&cache.size>1){const first=cache.keys().next().value!;bytes-=cache.get(first)!.bytes;cache.delete(first);}}}
    const row=saved.body[Number(ordinal)];if(!Array.isArray(row)||!Number.isSafeInteger(Number(field))||Number(field)<0||Number(field)>=row.length)throw Error('用量证据定位无效');return row[Number(field)]??null;
  };
  db.function('lingxi_unpack',{deterministic:true},(delta:any,body:any,size:any,digest:any,pack:any,ordinal:any,field:any)=>unpack(delta,body,size,digest,pack,ordinal,field));
  db.function('lingxi_read_payload',{deterministic:true},(delta:any,pack:any,ordinal:any,field:any)=>{
    if(delta!==null)return unpack(delta,null,null,null,null,ordinal,field);
    if(Number(pack)<0){const pending=db.prepare('SELECT delta FROM usage_deltas WHERE k=?').get(-Number(pack));if(!pending)throw Error('待压缩用量证据不存在');return unpack(pending.delta,null,null,null,null,ordinal,field);}
    const existing=cache.get(Number(pack));if(existing){const row=existing.body[Number(ordinal)];if(!Array.isArray(row)||Number(field)<0||Number(field)>=row.length)throw Error('用量证据定位无效');return row[Number(field)]??null;}
    const value=db.prepare('SELECT format,body,raw_size,digest FROM usage_packs WHERE k=?').get(pack);if(!value||![1,2].includes(value.format))throw Error('用量证据块格式无效');return unpack(null,value.body,value.raw_size,value.digest,pack,ordinal,field,value.format);
  });
  if(migrated){
    const foreign=db.pragma('foreign_key_list(compact_events)') as any[];
    const trigger=db.prepare("SELECT sql FROM sqlite_schema WHERE name='compact_codex_evidence_insert'").get();
    if(!foreign.some(row=>row.from==='owner'&&row.table==='usage_strings')||!foreign.some(row=>row.from==='id'&&row.table==='usage_ids')||!String(trigger?.sql).includes('AND NOT EXISTS('))
      throw Error('发现未发布的旧试验用量结构，不能继续采集；请从迁移前恢复基线重新验证');
    const bad=db.pragma('foreign_key_check') as any[];if(bad.length)throw Error('用量字典关联校验失败，原数据保留，请恢复一致性基线');
    if(allowIdUpgrade){compactIds(db);ensureIdentityJoins(db);compactAmounts(db);}db.usageStorage=true;installPackMaintenance(db);return true;
  }
  const existing=Object.keys(tables).filter(name=>db.prepare('SELECT 1 FROM sqlite_schema WHERE name=? AND type=\'table\'').get(name));
  if(!existing.includes('radar_values'))return false; // Initialize all legacy tables before conversion.
  db.exec('BEGIN IMMEDIATE');
  try{
    // Drop and recreate only triggers that depend on the converted relations.
    const triggers=db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND (tbl_name IN ('events','codex_evidence','agent_evidence') OR name LIKE 'value_%')").all();
    for(const t of triggers)db.exec('DROP TRIGGER '+q(t.name));
    db.exec(`CREATE TABLE usage_strings(k INTEGER PRIMARY KEY,value TEXT UNIQUE);
      CREATE TABLE usage_ids(k INTEGER PRIMARY KEY,value TEXT UNIQUE);
      CREATE TABLE usage_payloads(k INTEGER PRIMARY KEY,pack INTEGER,ordinal INTEGER,delta TEXT,raw_size INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE usage_packs(k INTEGER PRIMARY KEY AUTOINCREMENT,format INTEGER NOT NULL,raw_size INTEGER NOT NULL,digest TEXT NOT NULL,body BLOB NOT NULL);
      CREATE INDEX usage_payloads_pending ON usage_payloads(k) WHERE delta IS NOT NULL;`);
    for(const [name,spec] of Object.entries(tables)){
      if(!existing.includes(name))continue;
      const cold=spec.cold||[],hot=spec.columns.filter(c=>!cold.includes(c));
      db.exec('ALTER TABLE '+q(name)+' RENAME TO '+q('legacy_'+name));
      const types=hot.map(c=>q(c)+' '+(dictionaryColumns.has(c)||c==='id'?'INTEGER REFERENCES '+(c==='id'?'usage_ids':'usage_strings')+'(k)':c==='fingerprint'?'BLOB':(['input','output','cached','reasoning','total','duration_ms','verified'].includes(c)?'INTEGER':c==='cost'?'REAL':'TEXT')));
      if(cold.length)types.push('payload INTEGER NOT NULL');
      db.exec('CREATE TABLE '+q('compact_'+name)+'('+types.join(',')+',PRIMARY KEY('+spec.key.map(q).join(',')+')) WITHOUT ROWID');
      for(const c of hot.filter(c=>dictionaryColumns.has(c)||c==='id')){const d=c==='id'?'usage_ids':'usage_strings';db.exec('INSERT OR IGNORE INTO '+d+'(value) SELECT DISTINCT '+q(c)+' FROM '+q('legacy_'+name)+' WHERE '+q(c)+' IS NOT NULL');}
      const expressions=hot.map(c=>dictionaryColumns.has(c)||c==='id'?'(SELECT k FROM '+(c==='id'?'usage_ids':'usage_strings')+' WHERE value=l.'+q(c)+')':c==='fingerprint'?'lingxi_digest(l.fingerprint)':'l.'+q(c));
      if(cold.length){
        const offset=Number(db.prepare('SELECT coalesce(max(k),0) n FROM usage_payloads').get().n);
        // Preserve chronological locality for compression. Evidence scans use a
        // payload-order index; point queries use the independent identity key.
        db.exec('INSERT INTO usage_payloads(k,delta) SELECT '+offset+'+rowid,json_array('+cold.map(c=>'l.'+q(c)).join(',')+') FROM '+q('legacy_'+name)+' l');
        expressions.push(offset+'+l.rowid');
      }
      db.exec('INSERT INTO '+q('compact_'+name)+' SELECT '+expressions.join(',')+' FROM '+q('legacy_'+name)+' l');
      const joins=hot.filter(c=>dictionaryColumns.has(c)||c==='id').map(c=>'LEFT JOIN '+(c==='id'?'usage_ids':'usage_strings')+' '+q('d_'+c)+' ON '+q('d_'+c)+'.k=s.'+q(c));
      if(cold.length)joins.push('LEFT JOIN usage_payloads p ON p.k=s.payload LEFT JOIN usage_packs b ON b.k=p.pack');
      const select=spec.columns.map(c=>cold.includes(c)?'lingxi_read_payload(p.delta,p.pack,p.ordinal,'+cold.indexOf(c)+') AS '+q(c):dictionaryColumns.has(c)||c==='id'?q('d_'+c)+'.value AS '+q(c):c==='fingerprint'?'lower(hex(s.fingerprint)) AS fingerprint':'s.'+q(c));
      db.exec('CREATE VIEW '+q(name)+' AS SELECT '+select.join(',')+' FROM '+q('compact_'+name)+' s '+joins.join(' ')+(cold.length&&name!=='radar_values'?' ORDER BY s.owner,s.payload':''));
      const dict=hot.filter(c=>dictionaryColumns.has(c)||c==='id').map(c=>{const table=c==='id'?'usage_ids':'usage_strings';return 'INSERT INTO '+table+'(value) SELECT NEW.'+q(c)+' WHERE NEW.'+q(c)+' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM '+table+' WHERE value=NEW.'+q(c)+');';}).join('');
      const values=hot.map(c=>dictionaryColumns.has(c)||c==='id'?'(SELECT k FROM '+(c==='id'?'usage_ids':'usage_strings')+' WHERE value=NEW.'+q(c)+')':c==='fingerprint'?'lingxi_digest(NEW.fingerprint)':'NEW.'+q(c));
      const where=spec.key.map(c=>'s.'+q(c)+' IS (SELECT k FROM '+(c==='id'?'usage_ids':'usage_strings')+' WHERE value=OLD.'+q(c)+')').join(' AND ');
      let payloadInsert='';
      if(cold.length){payloadInsert='INSERT INTO usage_payloads(delta) VALUES(json_array('+cold.map(c=>'NEW.'+q(c)).join(',')+'));';values.push('last_insert_rowid()');}
      const updates=hot.filter(c=>!spec.key.includes(c)).map(c=>q(c)+'=excluded.'+q(c));if(cold.length)updates.push('payload=excluded.payload');
      for(const op of ['INSERT','UPDATE']){
        const write='INSERT INTO '+q('compact_'+name)+'('+hot.map(q).concat(cold.length?['payload']:[]).join(',')+') VALUES('+values.join(',')+') ON CONFLICT('+spec.key.map(q).join(',')+') '+(updates.length&&!(name==='events'&&op==='INSERT')?'DO UPDATE SET '+updates.join(','):'DO NOTHING')+';';
        const oldPayload=cold.length?'DELETE FROM usage_payloads WHERE k=(SELECT payload FROM '+q('compact_'+name)+' s WHERE '+where.replaceAll('OLD.','NEW.')+');':'';
        db.exec('CREATE TRIGGER '+q('compact_'+name+'_'+op.toLowerCase())+' INSTEAD OF '+op+' ON '+q(name)+' BEGIN '+dict+oldPayload+payloadInsert+write+' END');
      }
      db.exec('CREATE TRIGGER '+q('compact_'+name+'_delete')+' INSTEAD OF DELETE ON '+q(name)+' BEGIN '+(cold.length?'DELETE FROM usage_payloads WHERE k=(SELECT payload FROM '+q('compact_'+name)+' s WHERE '+where+');':'')+'DELETE FROM '+q('compact_'+name)+' WHERE '+where.replaceAll('s.',q('compact_'+name)+'.')+'; END');
      db.exec('DROP TABLE '+q('legacy_'+name));
    }
    mergeValuationCurrencies(db);
    db.exec('CREATE INDEX compact_events_scope ON compact_events(owner,at,source);CREATE INDEX compact_codex_origin ON compact_codex_evidence(owner,session,at);CREATE INDEX compact_codex_payload_scan ON compact_codex_evidence(owner,payload);PRAGMA user_version=4');
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  compactIds(db);ensureIdentityJoins(db);compactAmounts(db);db.usageStorage=true;installPackMaintenance(db);packPendingUsage(db,Infinity);return true;
}

function installPackMaintenance(db:SQLite){
  db.exec(`CREATE INDEX IF NOT EXISTS usage_payloads_pack ON usage_payloads(pack) WHERE pack IS NOT NULL;
    CREATE TABLE IF NOT EXISTS usage_pack_gc(k INTEGER PRIMARY KEY) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS usage_deltas(k INTEGER PRIMARY KEY,delta TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS usage_payloads_pending AFTER INSERT ON usage_payloads WHEN NEW.pack IS NULL AND NEW.delta IS NULL
      BEGIN UPDATE usage_payloads SET pack=-NEW.k,ordinal=0 WHERE k=NEW.k; END;
    CREATE TRIGGER IF NOT EXISTS usage_payloads_delta AFTER INSERT ON usage_payloads WHEN NEW.delta IS NOT NULL
      BEGIN INSERT INTO usage_deltas VALUES(NEW.k,NEW.delta);UPDATE usage_payloads SET delta=NULL,pack=-NEW.k,ordinal=0 WHERE k=NEW.k; END;
    CREATE TRIGGER IF NOT EXISTS usage_payloads_delta_delete BEFORE DELETE ON usage_payloads
      BEGIN DELETE FROM usage_deltas WHERE k=OLD.k; END;
    CREATE TRIGGER IF NOT EXISTS usage_payloads_gc BEFORE DELETE ON usage_payloads WHEN OLD.pack IS NOT NULL
      BEGIN INSERT OR IGNORE INTO usage_pack_gc SELECT OLD.pack WHERE OLD.pack>0; END;`);
}

// Exact coefficient/exponent encoding. This preserves arbitrary decimal digits,
// including the 80-digit exchange-rate results, without float conversion.
function packDecimal(value:any):Buffer|null{
  if(value===null||value===undefined)return null;
  const match=/^([+-]?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value));if(!match)throw Error('精确金额格式无效');
  let digits=(match[2]+(match[3]||'')).replace(/^0+/,''),exponent=Number(match[4]||0)-(match[3]?.length||0);if(!digits)return Buffer.from([0]);
  const trailing=/0+$/.exec(digits)?.[0].length||0;digits=digits.slice(0,digits.length-trailing);exponent+=trailing;
  if(!Number.isSafeInteger(exponent)||exponent<-2147483648||exponent>2147483647)throw Error('精确金额指数无效');
  const hex=BigInt(digits).toString(16),coefficient=Buffer.from(hex.length%2?'0'+hex:hex,'hex'),small=exponent>=-128&&exponent<=127,header=Buffer.alloc(small?2:5);header[0]=1|(match[1]==='-'?0x80:0)|(small?0:2);if(small)header.writeInt8(exponent,1);else header.writeInt32BE(exponent,1);return Buffer.concat([header,coefficient]);
}
function unpackDecimal(value:any):string|null{
  if(value===null)return null;const raw=Buffer.from(value);if(raw.length===1&&raw[0]===0)return '0';if(![1,3,129,131].includes(raw[0]))throw Error('精确金额格式无效');const large=!!(raw[0]&2),offset=large?5:2;if(raw.length<=offset)throw Error('精确金额存储损坏');const exponent=large?raw.readInt32BE(1):raw.readInt8(1);return (raw[0]&0x80?'-':'')+BigInt('0x'+raw.subarray(offset).toString('hex')).toString()+'e'+exponent;
}
export function registerStorageFunctions(db:SQLite){
  db.function('lingxi_pack_id',{deterministic:true},packId);db.function('lingxi_id',{deterministic:true},unpackId);
  db.function('lingxi_digest',{deterministic:true},(value:any)=>{if(typeof value!=='string'||! /^[a-f0-9]{64}$/i.test(value))throw Error('计价指纹格式无效');return Buffer.from(value,'hex');});
  db.function('lingxi_pack_decimal',{deterministic:true},packDecimal);db.function('lingxi_decimal',{deterministic:true},unpackDecimal);
  db.function('lingxi_decimal_output',{deterministic:true},unpackOutput);
}

const decimalPowers=new Map<number,bigint>();
function power10(scale:number){if(!Number.isInteger(scale)||scale<0||scale>256)throw Error('金额差分尺度无效');let value=decimalPowers.get(scale);if(value===undefined){value=10n**BigInt(scale);decimalPowers.set(scale,value);}return value;}
function decimalInteger(value:any){const raw=Buffer.from(value);if(raw.length===1&&raw[0]===0)return {coefficient:0n,exponent:0};if(![1,3,129,131].includes(raw[0]))throw Error('金额差分输入格式无效');const large=!!(raw[0]&2),offset=large?5:2;if(raw.length<=offset)throw Error('金额差分输入损坏');return {coefficient:(raw[0]&0x80?-1n:1n)*BigInt('0x'+raw.subarray(offset).toString('hex')),exponent:large?raw.readInt32BE(1):raw.readInt8(1)};}
function packOutput(output:any,cost:any,input:any,cached:any,written:any){
  if([output,cost,input,cached,written].some(value=>value==null))return output;
  const values=[output,cost,input,cached,written].map(decimalInteger),nonzero=values.filter(value=>value.coefficient!==0n);if(!nonzero.length)return output;
  const exponent=Math.min(...nonzero.map(value=>value.exponent));if(nonzero.some(value=>value.exponent-exponent>256))return output;
  const ints=values.map(value=>value.coefficient===0n?0n:value.coefficient*power10(value.exponent-exponent)),delta=ints[0]-ints[1]+ints[2]+ints[3]+ints[4],saved=Buffer.concat([Buffer.from([0x40]),packDecimal(delta.toString()+'e'+exponent)!]);
  return saved.length<output.length?saved:output;
}
function unpackOutput(output:any,cost:any,input:any,cached:any,written:any):string|null{
  if(output==null)return null;const raw=Buffer.from(output);if(raw[0]!==0x40)return unpackDecimal(raw);
  if(raw.length<2||[cost,input,cached,written].some(value=>value==null))throw Error('金额差分依赖缺失');
  const values=[cost,input,cached,written,raw.subarray(1)].map(decimalInteger),nonzero=values.filter(value=>value.coefficient!==0n),exponent=nonzero.length?Math.min(...nonzero.map(value=>value.exponent)):0;
  const ints=values.map(value=>value.coefficient===0n?0n:value.coefficient*power10(value.exponent-exponent));return (ints[0]-ints[1]-ints[2]-ints[3]+ints[4]).toString()+'e'+exponent;
}
function compactAmounts(db:SQLite){
  if(Number(db.pragma('user_version',{simple:true}))>=7)return;
  db.exec('BEGIN IMMEDIATE');try{const update=db.prepare('UPDATE compact_valuations SET usd_output=?,cny_output=? WHERE owner=? AND id=?');
    for(const row of db.prepare('SELECT * FROM compact_valuations').iterate()){
      const outputs=['usd','cny'].map(name=>packOutput(row[name+'_output'],row[name+'_cost'],row[name+'_input'],row[name+'_cached'],row[name+'_write']));
      for(const [i,name] of ['usd','cny'].entries())if(outputs[i]!=null&&unpackOutput(outputs[i],row[name+'_cost'],row[name+'_input'],row[name+'_cached'],row[name+'_write'])!==unpackDecimal(row[name+'_output'])){
        // Compare numeric identity without converting through floating point.
        const a=decimalInteger(packDecimal(unpackOutput(outputs[i],row[name+'_cost'],row[name+'_input'],row[name+'_cached'],row[name+'_write']))),b=decimalInteger(row[name+'_output']);
        const exponent=Math.min(a.exponent,b.exponent);if(a.coefficient*power10(a.exponent-exponent)!==b.coefficient*power10(b.exponent-exponent))throw Error('金额差分改变了精确值');
      }
      update.run(...outputs,row.owner,row.id);
    }
    db.exec('PRAGMA user_version=7;COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}

/** The normal pricing writer crosses the SQLite boundary once per result, not
 * once per decimal field. Views still support legacy maintenance/import writes. */
export function writeCompactValuation(db:SQLite,owner:string,id:string,currency:string,fingerprint:string,value:any,keys?:{owner:number|bigint;id:number|bigint},sealedPayload?:number|bigint){
  const name=currency.toLowerCase();if(!['usd','cny'].includes(name)||! /^[a-f0-9]{64}$/i.test(fingerprint))throw Error('计价缓存身份无效');
  let ownerKey=keys?.owner??db.prepare('SELECT k FROM usage_strings WHERE value=?').get(owner)?.k,idKey=keys?.id??db.prepare('SELECT k FROM usage_ids WHERE lingxi_id(value)=?').get(id)?.k;
  if(ownerKey===undefined)ownerKey=db.prepare('INSERT INTO usage_strings(value) VALUES(?)').run(owner).lastInsertRowid;
  if(idKey===undefined)idKey=db.prepare('INSERT INTO usage_ids(value) VALUES(lingxi_pack_id(?))').run(id).lastInsertRowid;
  let payload=sealedPayload;
  if(payload===undefined){db.prepare('DELETE FROM usage_payloads WHERE k=(SELECT '+name+'_payload FROM compact_valuations WHERE owner=? AND id=?)').run(ownerKey,idKey);payload=db.prepare('INSERT INTO usage_payloads DEFAULT VALUES').run().lastInsertRowid;db.prepare('INSERT INTO usage_deltas VALUES(?,?)').run(payload,JSON.stringify([JSON.stringify(value)]));}
  const fields=['fingerprint','payload','cost','reason','input','cached','write','output'],columns=fields.map(f=>name+'_'+f);
  const amounts=[value.cost,...['input','cached','write','output'].map(f=>value.valueParts?.[f])].map(packDecimal);amounts[4]=packOutput(amounts[4],amounts[0],amounts[1],amounts[2],amounts[3]);
  db.prepare('INSERT INTO compact_valuations(owner,id,'+columns.map(q).join(',')+') VALUES('+Array(10).fill('?').join(',')+') ON CONFLICT(owner,id) DO UPDATE SET '+columns.map(c=>q(c)+'=excluded.'+q(c)).join(',')).run(ownerKey,idKey,Buffer.from(fingerprint,'hex'),payload,amounts[0],value.valueReason??null,...amounts.slice(1));
}

/** Prepare both currencies with one physical upsert and two bounded payloads. */
export function writeCompactValuationPair(db:SQLite,owner:string,id:string,usd:any,cny:any,keys:{owner:number|bigint;id:number|bigint},sealedPayloads?:(number|bigint)[]){
  if(!usd||!cny){const saved=usd||cny;writeCompactValuation(db,owner,id,usd?'USD':'CNY',saved.fingerprint,saved.value,keys,sealedPayloads?.[0]);return;}
  for(const saved of [usd,cny])if(!/^[a-f0-9]{64}$/i.test(saved.fingerprint))throw Error('计价缓存指纹无效');
  let payloads=sealedPayloads?.map(k=>({k}));
  if(!payloads){db.prepare('DELETE FROM usage_payloads WHERE k IN (SELECT usd_payload FROM compact_valuations WHERE owner=? AND id=? UNION ALL SELECT cny_payload FROM compact_valuations WHERE owner=? AND id=?)').run(keys.owner,keys.id,keys.owner,keys.id);payloads=db.prepare('INSERT INTO usage_payloads(delta) VALUES(NULL),(NULL) RETURNING k').all();db.prepare('INSERT INTO usage_deltas VALUES(?,?),(?,?)').run(payloads[0].k,JSON.stringify([JSON.stringify(usd.value)]),payloads[1].k,JSON.stringify([JSON.stringify(cny.value)]));}
  const fields=['fingerprint','payload','cost','reason','input','cached','write','output'];
  const columns=['usd','cny'].flatMap(name=>fields.map(field=>name+'_'+field));
  const values=[usd,cny].flatMap((saved,i)=>{const amounts=[saved.value.cost,...['input','cached','write','output'].map(field=>saved.value.valueParts?.[field])].map(packDecimal);amounts[4]=packOutput(amounts[4],amounts[0],amounts[1],amounts[2],amounts[3]);return [Buffer.from(saved.fingerprint,'hex'),payloads[i].k,amounts[0],saved.value.valueReason??null,...amounts.slice(1)];});
  db.prepare('INSERT INTO compact_valuations(owner,id,'+columns.map(q).join(',')+') VALUES('+Array(18).fill('?').join(',')+') ON CONFLICT(owner,id) DO UPDATE SET '+columns.map(column=>q(column)+'=excluded.'+q(column)).join(',')).run(keys.owner,keys.id,...values);
}

/** A preparation transaction already owns a bounded batch. Seal its results
 * directly, avoiding a temporary text insert/update/delete for every record. */
export function writeCompactValuationBatch(db:SQLite,owner:string,rows:any[]){
  if(!rows.length)return;if(rows.length>256||!db.inTransaction)throw Error('计价封块必须在受限批次事务中执行');
  const ownerKey=rows[0].keys.owner;
  if(rows.some(row=>row.keys.owner!==ownerKey))throw Error('计价批次账户不一致');
  for(const currency of ['usd','cny']){const ids=rows.filter(row=>row[currency]).map(row=>row.keys.id);if(ids.length)db.prepare('DELETE FROM usage_payloads WHERE k IN (SELECT '+currency+'_payload FROM compact_valuations WHERE owner=? AND id IN ('+ids.map(()=>'?').join(',')+'))').run(ownerKey,...ids);}
  const entries=rows.flatMap(row=>['usd','cny'].filter(name=>row[name]).map(name=>({row,name,delta:JSON.stringify([JSON.stringify(row[name].value)])}))),payloads=new Map<any,(number|bigint)[]>();
  for(let offset=0;offset<entries.length;){const batch:typeof entries=[];let bytes=2;while(offset<entries.length&&batch.length<256){const entry=entries[offset],length=Buffer.byteLength(entry.delta)+1;if(batch.length&&bytes+length>256*1024)break;batch.push(entry);bytes+=length;offset++;}
    const raw=Buffer.from('['+batch.map(entry=>entry.delta).join(',')+']');if(raw.length>4*1024*1024)throw Error('计价证据块超过保存限制');
    const body=zstdCompressSync(raw,{params:{[constants.ZSTD_c_compressionLevel]:1,[constants.ZSTD_c_checksumFlag]:1}}),pack=db.prepare('INSERT INTO usage_packs(format,raw_size,digest,body) VALUES(2,?,?,?)').run(raw.length,hash(raw),body).lastInsertRowid;
    const saved=db.prepare('INSERT INTO usage_payloads(pack,ordinal,raw_size) VALUES '+batch.map(()=>'(?,?,?)').join(',')+' RETURNING k').all(...batch.flatMap((entry,i)=>[pack,i,Buffer.byteLength(entry.delta)]));
    batch.forEach((entry,i)=>{const list=payloads.get(entry.row)||[];list.push(saved[i].k);payloads.set(entry.row,list);});
  }
  for(const row of rows)writeCompactValuationPair(db,owner,row.id,row.usd,row.cny,row.keys,payloads.get(row));
}

function mergeValuationCurrencies(db:SQLite){
  const fields=['cost','reason','input','cached','write','output'];
  const currencies=['usd','cny'];
  const hot=(name:string,field:string)=>name+'_'+field;
  const valueFields=currencies.flatMap(name=>['fingerprint','payload',...fields].map(f=>hot(name,f)));
  db.exec('CREATE TABLE compact_valuations(owner INTEGER NOT NULL,id INTEGER NOT NULL,'+valueFields.map(c=>q(c)+' '+(c.endsWith('_payload')?'INTEGER':c.endsWith('_reason')?'TEXT':'BLOB')).join(',')+',PRIMARY KEY(owner,id)) WITHOUT ROWID');
  const rows=db.prepare('SELECT s.*,d.value AS currency,p.delta,b.body,b.raw_size,b.digest,b.k AS pack,p.ordinal FROM compact_radar_values s JOIN usage_strings d ON d.k=s.currency LEFT JOIN usage_payloads p ON p.k=s.payload LEFT JOIN usage_packs b ON b.k=p.pack').iterate();
  for(const row of rows){const currency=String(row.currency).toLowerCase();if(!currencies.includes(currency))throw Error('历史计价币种不支持无损迁移');const payload=db.prepare('SELECT lingxi_unpack(?,?,?,?,?,?,0) value').get(row.delta,row.body,row.raw_size,row.digest,row.pack,row.ordinal).value;const data=JSON.parse(payload);const values=[row.owner,row.id,row.fingerprint,row.payload,packDecimal(data.cost),data.valueReason??null,...['input','cached','write','output'].map(f=>packDecimal(data.valueParts?.[f]))];const columns=['owner','id',...['fingerprint','payload',...fields].map(f=>hot(currency,f))];db.prepare('INSERT INTO compact_valuations('+columns.map(q).join(',')+') VALUES('+values.map(()=>'?').join(',')+') ON CONFLICT(owner,id) DO UPDATE SET '+columns.slice(2).map(c=>q(c)+'=excluded.'+q(c)).join(',')).run(...values);}
  for(const op of ['insert','update','delete'])db.exec('DROP TRIGGER compact_radar_values_'+op);db.exec('DROP VIEW radar_values;DROP TABLE compact_radar_values');
  const branches=currencies.map(name=>`SELECT o.value AS owner,i.value AS id,'${name.toUpperCase()}' AS currency,lower(hex(s.${name}_fingerprint)) AS fingerprint,lingxi_read_payload(p.delta,p.pack,p.ordinal,0) AS result FROM compact_valuations s JOIN usage_strings o ON o.k=s.owner JOIN usage_ids i ON i.k=s.id LEFT JOIN usage_payloads p ON p.k=s.${name}_payload WHERE s.${name}_fingerprint IS NOT NULL`);
  db.exec('CREATE VIEW radar_values AS '+branches.join(' UNION ALL '));
  const dictionary="INSERT INTO usage_strings(value) SELECT NEW.owner WHERE NOT EXISTS(SELECT 1 FROM usage_strings WHERE value=NEW.owner);INSERT INTO usage_ids(value) SELECT NEW.id WHERE NOT EXISTS(SELECT 1 FROM usage_ids WHERE value=NEW.id);";
  const owner='(SELECT k FROM usage_strings WHERE value=NEW.owner)',id='(SELECT k FROM usage_ids WHERE value=NEW.id)';
  const columnValues=valueFields.map(c=>{const [name,field]=c.split('_'),condition="NEW.currency='"+name.toUpperCase()+"'";let value=field==='fingerprint'?'lingxi_digest(NEW.fingerprint)':field==='payload'?'last_insert_rowid()':"json_extract(NEW.result,'$."+(field==='cost'?'cost':field==='reason'?'valueReason':'valueParts.'+field)+"')";if(!['fingerprint','payload','reason'].includes(field))value='lingxi_pack_decimal('+value+')';return 'CASE WHEN '+condition+' THEN '+value+' ELSE NULL END';});
  const preserve=valueFields.map(c=>'"'+c+'"=CASE WHEN NEW.currency=\''+c.slice(0,3).toUpperCase()+'\' THEN excluded."'+c+'" ELSE compact_valuations."'+c+'" END').join(',');
  const clearOld='DELETE FROM usage_payloads WHERE k=(SELECT CASE NEW.currency WHEN \'USD\' THEN usd_payload WHEN \'CNY\' THEN cny_payload END FROM compact_valuations WHERE owner='+owner+' AND id='+id+');';
  for(const op of ['INSERT','UPDATE'])db.exec('CREATE TRIGGER compact_radar_values_'+op.toLowerCase()+' INSTEAD OF '+op+' ON radar_values BEGIN SELECT CASE WHEN NEW.currency NOT IN (\'USD\',\'CNY\') THEN RAISE(ABORT,\'计价币种无效\') END;'+dictionary+clearOld+'INSERT INTO usage_payloads(delta) VALUES(json_array(NEW.result));INSERT INTO compact_valuations(owner,id,'+valueFields.map(q).join(',')+') VALUES('+[owner,id,...columnValues].join(',')+') ON CONFLICT(owner,id) DO UPDATE SET '+preserve+'; END');
  const oldOwner='(SELECT k FROM usage_strings WHERE value=OLD.owner)',oldId='(SELECT k FROM usage_ids WHERE value=OLD.id)';
  db.exec('CREATE TRIGGER compact_radar_values_delete INSTEAD OF DELETE ON radar_values BEGIN '+clearOld.replaceAll('NEW.','OLD.')+'UPDATE compact_valuations SET '+valueFields.map(c=>q(c)+'=CASE WHEN OLD.currency=\''+c.slice(0,3).toUpperCase()+'\' THEN NULL ELSE '+q(c)+' END').join(',')+' WHERE owner='+oldOwner+' AND id='+oldId+';DELETE FROM compact_valuations WHERE owner='+oldOwner+' AND id='+oldId+' AND usd_fingerprint IS NULL AND cny_fingerprint IS NULL; END');
}

/** Existing trigger bodies retain textual public identities while targeting the
 * compact physical rows. Compatibility views themselves only have INSTEAD OF triggers. */
export function rewriteUsageDDL(sql:string){
  sql=rewriteUsageIdSQL(sql);
  sql=sql.replace(/CREATE INDEX IF NOT EXISTS (events_owner_time|events_scope_time|codex_evidence_origin) ON [^;]+;/g,'');
  const match=/AFTER (?:INSERT|UPDATE|DELETE) ON (events|codex_evidence|agent_evidence)\b/.exec(sql);
  if(match){sql=sql.replace(match[0],match[0].replace('ON '+match[1],'ON compact_'+match[1]));sql=sql.replace(/\b(NEW|OLD)\.(owner|source|agent|provider|model|session|project|status|connection_id|requested_model|auth_mode|path|reason|currency|id)\b/g,(_m,row,column)=>'(SELECT '+(column==='id'?'lingxi_id(value)':'value')+' FROM '+(column==='id'?'usage_ids':'usage_strings')+' WHERE k='+row+'.'+column+')');}
  return sql;
}

export function packPendingUsage(db:SQLite,limit=1000){
  if(!db.usageStorage)return {packed:0};let completed=0;
  while(completed<limit){let rows=db.prepare('SELECT k,delta FROM usage_payloads WHERE delta IS NOT NULL ORDER BY k LIMIT 256').all();if(!rows.length)rows=db.prepare('SELECT d.k,d.delta FROM usage_deltas d JOIN usage_payloads p ON p.k=d.k ORDER BY d.k LIMIT 256').all();if(!rows.length)break;
    const batch:any[]=[];let size=2;for(const row of rows){const length=Buffer.byteLength(row.delta)+1;if(batch.length&&size+length>256*1024)break;batch.push(row);size+=length;}
    const raw=Buffer.from('['+batch.map(r=>r.delta).join(',')+']');if(raw.length>4*1024*1024)throw Error('用量证据块超过限制');const body=zstdCompressSync(raw,{params:{[constants.ZSTD_c_compressionLevel]:1,[constants.ZSTD_c_checksumFlag]:1}});
    const nested=db.inTransaction;db.exec(nested?'SAVEPOINT lingxi_pack':'BEGIN IMMEDIATE');try{const pack=db.prepare('INSERT INTO usage_packs(format,raw_size,digest,body) VALUES(2,?,?,?)').run(raw.length,hash(raw),body).lastInsertRowid;const update=db.prepare('UPDATE usage_payloads SET pack=?,ordinal=?,raw_size=?,delta=NULL WHERE k=?'),remove=db.prepare('DELETE FROM usage_deltas WHERE k=?');batch.forEach((r,i)=>{update.run(pack,i,Buffer.byteLength(r.delta),r.k);remove.run(r.k);});db.exec(nested?'RELEASE lingxi_pack':'COMMIT');}catch(e){db.exec(nested?'ROLLBACK TO lingxi_pack; RELEASE lingxi_pack':'ROLLBACK');throw e;}completed+=batch.length;
  }
  // Inspect only blocks affected by deleted payloads. Scanning all payloads on
  // every batch would turn an incremental write into quadratic work.
  const abandoned=db.prepare('SELECT k FROM usage_pack_gc LIMIT 32').all();
  if(abandoned.length){const nested=db.inTransaction;db.exec(nested?'SAVEPOINT lingxi_pack':'BEGIN IMMEDIATE');try{
    const remove=db.prepare('DELETE FROM usage_packs WHERE k=? AND NOT EXISTS(SELECT 1 FROM usage_payloads WHERE pack=?)'),clean=db.prepare('DELETE FROM usage_pack_gc WHERE k=?');
    for(const row of abandoned){
      const live=db.prepare('SELECT k,ordinal,raw_size FROM usage_payloads WHERE pack=? ORDER BY ordinal').all(row.k);
      if(live.length){const old=db.prepare('SELECT * FROM usage_packs WHERE k=?').get(row.k);
        const retained=live.reduce((n:number,r:any)=>n+Number(r.raw_size)+1,2);
        // Repack only affected blocks with substantial dead contents. This is
        // amortized local reclamation, never a whole-history decompression.
        if(old&&retained<Number(old.raw_size)*0.8){
          const size=Number(old.raw_size);if(![1,2].includes(old.format)||!Number.isSafeInteger(size)||size<0||size>4*1024*1024)throw Error('回收证据块格式无效');
          const decoded=(old.format===2?zstdDecompressSync:inflateSync)(Buffer.from(old.body),{maxOutputLength:size+1});if(decoded.length!==size||hash(decoded)!==old.digest)throw Error('回收证据块校验失败');
          const records=JSON.parse(decoded.toString()),values=live.map((r:any)=>records[r.ordinal]);if(values.some((r:any)=>!Array.isArray(r)))throw Error('回收证据定位无效');
          const raw=Buffer.from(JSON.stringify(values)),body=zstdCompressSync(raw,{params:{[constants.ZSTD_c_compressionLevel]:1,[constants.ZSTD_c_checksumFlag]:1}});
          const replacement=db.prepare('INSERT INTO usage_packs(format,raw_size,digest,body) VALUES(2,?,?,?)').run(raw.length,hash(raw),body).lastInsertRowid;
          const update=db.prepare('UPDATE usage_payloads SET pack=?,ordinal=? WHERE k=?');live.forEach((r:any,i:number)=>update.run(replacement,i,r.k));
        }
      }
      remove.run(row.k,row.k);clean.run(row.k);
    }
    db.exec(nested?'RELEASE lingxi_pack':'COMMIT');
  }catch(error){db.exec(nested?'ROLLBACK TO lingxi_pack; RELEASE lingxi_pack':'ROLLBACK');throw error;}}
  return {packed:completed};
}


