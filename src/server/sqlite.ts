import { DatabaseSync, backup, type StatementSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { rewriteUsageDDL,rewriteUsageIdSQL } from './usage-storage.ts';
/** Small adapter over the runtime's own SQLite: one bounded statement cache, no ABI addon. */
class Statement {
  private integers=false;
  constructor(private statement:StatementSync) {statement.setReadBigInts(true);}
  safeIntegers(enabled=true){this.integers=enabled;return this;}
  private row(value:any):any{if(!value)return value;return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,item instanceof Uint8Array?Buffer.from(item):typeof item==='bigint'&&!this.integers&&item<=BigInt(Number.MAX_SAFE_INTEGER)&&item>=BigInt(Number.MIN_SAFE_INTEGER)?Number(item):item]));}
  all(...args:any[]):any[]{return (this.statement.all as any)(...args).map((row:any)=>this.row(row));}
  get(...args:any[]):any{return this.row((this.statement.get as any)(...args));}
  *iterate(...args:any[]):Generator<any>{for(const row of (this.statement.iterate as any)(...args))yield this.row(row);}
  run(...args:any[]):{changes:number;lastInsertRowid:number|bigint}{const result=(this.statement.run as any)(...args);return {changes:Number(result.changes),lastInsertRowid:result.lastInsertRowid<=BigInt(Number.MAX_SAFE_INTEGER)?Number(result.lastInsertRowid):result.lastInsertRowid};}
}
export default class SQLite {
  usageStorage=false;
  get inTransaction(){return this.db.isTransaction;}
  private db:DatabaseSync;
  private statements=new Map<string,StatementSync>();
  constructor(file:string,options:{readonly?:boolean;fileMustExist?:boolean}={}){if(options.fileMustExist&&!existsSync(file))throw Error('SQLite 文件不存在');this.db=new DatabaseSync(file,{readOnly:options.readonly===true,allowExtension:false});}
  exec(sql:string){this.db.exec(this.usageStorage?rewriteUsageDDL(sql):sql);return this;}
  prepare(sql:string){if(this.usageStorage)sql=rewriteUsageIdSQL(sql);let stmt=this.statements.get(sql);if(!stmt){stmt=this.db.prepare(sql);this.statements.set(sql,stmt);while(this.statements.size>128)this.statements.delete(this.statements.keys().next().value!);}return new Statement(stmt);}
  pragma(sql:string,options:{simple?:boolean}={}){const rows=this.prepare('PRAGMA '+sql).all();return options.simple?Object.values(rows[0]||{})[0]:rows;}
  aggregate(name:string,options:any){this.db.aggregate(name,options);}
  function(name:string,options:any,callback:(...args:any[])=>any){this.db.function(name,options,callback);}
  backup(file:string){return backup(this.db,file);}
  close(){this.statements.clear();this.db.close();}
}
