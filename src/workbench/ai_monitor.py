"""Account-scoped observed usage. Counts come from responses/logs, never estimates."""
from contextlib import contextmanager, closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
import hashlib
import json
import math
import re
import sqlite3
import threading
import time
import uuid
from workbench.storage_cache import ByteLRU

FIELDS=('input','output','cached','reasoning','total')

def decimal_total(values):
    from decimal import Decimal,localcontext
    with localcontext() as ctx:
        ctx.prec=100
        return sum((Decimal(str(v)) for v in values),Decimal(0))

def tokens(usage):
    if not isinstance(usage,dict):return None
    def number(value):
        if value is None:return None
        if isinstance(value,bool) or not isinstance(value,(int,float)) or value<0 or value>9223372036854775807 or not math.isfinite(value) or int(value)!=value:raise ValueError('Token 必须是有效范围内的非负整数')
        return int(value)
    incoming=number(usage.get('input_tokens',usage.get('prompt_tokens',usage.get('input'))))
    outgoing=number(usage.get('output_tokens',usage.get('completion_tokens',usage.get('output'))))
    total=number(usage.get('total_tokens',usage.get('total')))
    if incoming is None and outgoing is None and total is None:return None
    incoming_details=usage.get('input_tokens_details',usage.get('prompt_tokens_details'))
    outgoing_details=usage.get('output_tokens_details',usage.get('completion_tokens_details'))
    if incoming_details is None:incoming_details={}
    if outgoing_details is None:outgoing_details={}
    if not isinstance(incoming_details,dict) or not isinstance(outgoing_details,dict):raise ValueError('Token 明细必须是对象')
    cached=number(usage.get('cached_input_tokens',usage.get('prompt_cache_hit_tokens',usage.get('cached',incoming_details.get('cached_tokens')))))
    reasoning=number(usage.get('reasoning_output_tokens',usage.get('reasoning',outgoing_details.get('reasoning_tokens'))))
    written=number(usage.get('cache_write_input_tokens',usage.get('cache_creation_input_tokens',usage.get('cacheWriteTokens'))))
    if total is None and incoming is not None and outgoing is not None:total=number(incoming+outgoing)
    if incoming is not None and outgoing is not None and total is not None and incoming+outgoing!=total:raise ValueError('输入和输出与总 Token 冲突')
    if incoming is not None and cached is not None and cached>incoming:raise ValueError('缓存读取超过完整输入')
    if incoming is not None and cached is not None and written is not None and cached+written>incoming:raise ValueError('缓存分项超过完整输入')
    if outgoing is not None and reasoning is not None and reasoning>outgoing:raise ValueError('推理超过完整输出')
    return {'input':incoming,'output':outgoing,'cached':cached,'reasoning':reasoning,'total':total}


def iso(value=None):
    if value is None:return datetime.now(timezone.utc).isoformat()
    if isinstance(value,bool):raise ValueError('用量时间格式不正确')
    try:
        dt=datetime.fromtimestamp(value,timezone.utc) if isinstance(value,(int,float)) else datetime.fromisoformat(str(value).replace('Z','+00:00'))
        return dt.replace(tzinfo=timezone.utc).isoformat() if not dt.tzinfo else dt.astimezone(timezone.utc).isoformat()
    except (ValueError,TypeError,OverflowError,OSError):raise ValueError('用量时间格式不正确')

class AIMonitor:
    def __init__(self,data):
        self.path=Path(data)/'storage'/'ai-monitor.sqlite';self.lock=threading.RLock();self.scan_lock=threading.RLock();self.ready=False;self.value_reader=None;self.datasets={};self.snapshot_cache=ByteLRU();self.cache_lock=threading.RLock();self.coverage_cache={};self.warm_threads={};self.agent_value_enabled=True
    @contextmanager
    def db(self):
        self.path.parent.mkdir(parents=True,exist_ok=True)
        with closing(sqlite3.connect(self.path,timeout=20)) as db:
            db.row_factory=sqlite3.Row
            with db:yield db
    def initialize(self):
        with self.lock:
            if self.ready:return
            if self.path.exists() and not self.path.with_name('ai-monitor.pre-v18.sqlite').exists() and not (self.path.parent/'recovery/latest-v27.zip').exists():
                with closing(sqlite3.connect(self.path)) as source:
                    if source.execute('PRAGMA user_version').fetchone()[0]<3:
                        with closing(sqlite3.connect(self.path.with_name('ai-monitor.pre-v18.sqlite'))) as target:source.backup(target)
            with self.db() as db:
                db.execute('PRAGMA journal_mode=WAL')
                db.execute('''CREATE TABLE IF NOT EXISTS events(owner TEXT NOT NULL,id TEXT NOT NULL,at TEXT NOT NULL,source TEXT NOT NULL,agent TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,session TEXT NOT NULL,project TEXT NOT NULL,status TEXT NOT NULL,input INTEGER,output INTEGER,cached INTEGER,reasoning INTEGER,total INTEGER,duration_ms INTEGER,cost REAL,currency TEXT,PRIMARY KEY(owner,id))''')
                db.execute('CREATE INDEX IF NOT EXISTS events_owner_time ON events(owner,at)')
                columns={row[1] for row in db.execute('PRAGMA table_info(events)')}
                if 'connection_id' not in columns and db.execute('SELECT COUNT(*) FROM events').fetchone()[0]:
                    backup=self.path.with_name('ai-monitor.pre-v2.sqlite')
                    if not backup.exists():
                        with closing(sqlite3.connect(backup)) as target:db.backup(target)
                for name in ('connection_id','requested_model','auth_mode'):
                    if name not in columns:db.execute('ALTER TABLE events ADD COLUMN '+name+" TEXT NOT NULL DEFAULT ''")
                db.execute("UPDATE events SET model='未识别模型' WHERE source='codex' AND model='Codex'")
                db.execute('''CREATE TABLE IF NOT EXISTS cursors(owner TEXT,path TEXT,offset INTEGER,state TEXT,PRIMARY KEY(owner,path))''')
                from workbench.codex_ledger import setup
                setup(db)
                from workbench.usage_evidence import setup as setup_evidence
                setup_evidence(db)
                from workbench.usage_evidence import migrate_codex_details
                migrate_codex_details(db,tokens)
                db.execute('CREATE INDEX IF NOT EXISTS events_scope_time ON events(owner,source,at)')
                db.execute('PRAGMA user_version=3')
            self.ready=True
    def record(self,owner,usage=None,_db=None,**meta):
        self.initialize();counts=tokens(usage)
        rates=meta.get('rates') or {};cost=None
        if counts is not None and counts['input'] is not None and counts['output'] is not None and counts['cached'] is not None and all(isinstance(rates.get(k),(int,float)) and rates[k]>=0 and math.isfinite(rates[k]) for k in ('input','output','cached')):
            cost=((counts['input']-counts['cached'])*rates['input']+counts['cached']*rates['cached']+counts['output']*rates['output'])/1_000_000
        event={'owner':owner,'id':str(meta.get('id') or uuid.uuid4().hex)[:250],'at':iso(meta.get('at'))}
        for key,default in [('source','api'),('agent','工作台'),('provider','未标注'),('model','未标注'),('session',''),('project',''),('status','success')]:event[key]=str(meta.get(key,default))[:300]
        event.update({k:counts[k] if counts is not None else None for k in FIELDS})
        for key in ('connection_id','requested_model','auth_mode'):event[key]=str(meta.get(key,'') or '')[:300]
        event.update(duration_ms=max(0,int(meta.get('duration_ms') or 0)),cost=cost,currency=str(rates.get('currency','CNY'))[:8])
        if 'imported_cost' in meta:
            event['cost']=meta['imported_cost'];event['currency']=meta.get('currency','CNY')
        def insert(db):
            inserted=db.execute('INSERT OR IGNORE INTO events('+','.join(event)+') VALUES('+','.join('?' for _ in event)+')',list(event.values())).rowcount
            if meta.get('import_evidence') and event['source'] in ('zcode','dsh') and counts and counts['total'] is not None:
                from workbench.usage_evidence import encode,VERSION
                raw={'usage':{**counts,'cache_write_input_tokens':usage.get('cache_write_input_tokens',usage.get('cache_creation_input_tokens'))},'origin':'authorized-import','timestamp':event['at'],'model':event['model']}
                serialized=encode(raw)
                db.execute('INSERT OR IGNORE INTO agent_evidence VALUES(?,?,?,?,?,?,?,?)',(owner,event['id'],event['source'],serialized,hashlib.sha256(serialized.encode()).hexdigest(),VERSION,1,'verified'))
            return inserted
        if _db is not None:return insert(_db)
        with self.lock,self.db() as db:inserted=insert(db)
        return inserted
    def import_records(self,owner,records,validate_only=False):
        if not isinstance(records,list) or len(records)>10000:raise ValueError('一次最多导入 10000 条记录')
        # Validate the entire batch before committing any event.
        clean=[]
        for row in records:
            if not isinstance(row,dict):raise ValueError('用量记录必须是对象')
            usage=row.get('usage',row);counts=tokens(usage)
            if counts is None and not ('status' in row and 'total' in row):raise ValueError('记录缺少 usage Token 字段')
            stamp=iso(row.get('timestamp',row.get('at',row.get('created'))))
            duration=row.get('duration_ms',0)
            if isinstance(duration,bool) or not isinstance(duration,int) or duration<0:raise ValueError('耗时必须是非负整数')
            cost=row.get('cost')
            if cost is not None and (isinstance(cost,bool) or not isinstance(cost,(int,float)) or not math.isfinite(cost) or cost<0):raise ValueError('费用估算必须是非负数')
            currency=row.get('currency','CNY')
            if currency not in ('CNY','USD'):raise ValueError('币种必须是 CNY 或 USD')
            identity=row.get('id') or hashlib.sha256(json.dumps(row,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
            clean.append((usage,dict(id=str(identity),at=stamp,source=row.get('source','import'),status=row.get('status','success'),agent=row.get('agent','导入 Agent'),provider=row.get('provider','导入'),model=row.get('model','未识别模型'),session=row.get('session',''),project=row.get('project',''),connection_id=row.get('connection_id',''),requested_model=row.get('requested_model',''),auth_mode=row.get('auth_mode',''),duration_ms=duration,imported_cost=cost,currency=currency,import_evidence=True)))
        self.initialize()
        if validate_only:
            with self.db() as db:known={r[0] for r in db.execute('SELECT id FROM events WHERE owner=?',(owner,))}
            duplicates=0;preview=[]
            for usage,meta in clean:
                identity=str(meta['id'])[:250]
                duplicates+=identity in known;known.add(identity)
                if len(preview)<20:preview.append({**meta,**(tokens(usage) or {k:None for k in FIELDS})})
            return {'records':len(clean),'duplicates':duplicates,'newRecords':len(clean)-duplicates,'preview':preview}
        with self.lock,self.db() as db:imported=sum(self.record(owner,usage,_db=db,**meta) for usage,meta in clean)
        return {'imported':imported,'records':len(clean),'duplicates':len(clean)-imported}
    def scan_codex(self,owner,root):
        with self.scan_lock:return self._scan_codex(owner,root)
    def _scan_codex(self,owner,root):
        from workbench.codex_ledger import scan
        return scan(self,owner,root)
    def events(self,owner):
        self.initialize()
        with self.db() as db:return [dict(row) for row in db.execute('SELECT * FROM events WHERE owner=? ORDER BY at DESC',(owner,))]
    def data_version(self,owner):
        self.initialize()
        with self.db() as db:
            row=db.execute('SELECT version FROM usage_versions WHERE owner=?',(owner,)).fetchone()
            return row[0] if row else 0
    def browser_snapshot(self,owner,days=30,valuation_enabled=None,**params):
        """Large first builds are asynchronous; no unverified zero is published."""
        from workbench.usage_summary import Dataset
        enabled=self.agent_value_enabled if valuation_enabled is None else bool(valuation_enabled)
        scope=params.get('scope','');version=self.data_version(owner);currency=params.get('value_currency','USD')
        if scope not in ('codex','zcode','dsh'):return self.snapshot(owner,days,valuation_enabled=enabled,**params)
        price_version=0
        if enabled:
            from workbench.api_value import APIValue
            if self.value_reader is None:self.value_reader=APIValue(self)
            price_version=self.value_reader.version()
        ready_key=(owner,scope,version,price_version,currency) if enabled else (owner,scope,version)
        with self.cache_lock:ready=ready_key in self.datasets
        if ready:return self.snapshot(owner,days,valuation_enabled=enabled,**params)
        with self.db() as db:count=db.execute('SELECT count(*) FROM events WHERE owner=? AND source=?',(owner,scope)).fetchone()[0]
        if count<=30000:return self.snapshot(owner,days,valuation_enabled=enabled,**params)
        with self.cache_lock:
            task=self.warm_threads.get((owner,scope))
            if task is None or not task.is_alive():
                def prepare():
                    try:self.snapshot(owner,days,valuation_enabled=enabled,**params)
                    except (ValueError,OSError,sqlite3.Error):pass
                task=threading.Thread(target=prepare,name='usage-cache-prepare',daemon=True);self.warm_threads[(owner,scope)]=task;task.start()
            for key,cached in reversed(list(self.snapshot_cache.items())):
                old=json.loads(key[-1])
                if key[0][:2]==(owner,scope) and key[3]==currency and old.get('agent_value_enabled')==enabled and old.get('days')==days and all(old.get(k)==v for k,v in params.items() if k!='value_currency'):
                    result=json.loads(cached);result.update(warming=True);return result
        defaults={'source':'','provider':'','model':'','project':'','connection_id':'','include_all':False,'period':'','start_date':'','end_date':'','models':None}
        defaults.update({k:v for k,v in params.items() if k in defaults})
        result=Dataset([],'CNY').snapshot(days=days,scope=scope,**defaults)
        for item in [result['summary'],result['lifetime'],*result['daily'],*result['activity']]:
            item.update({k:None for k in FIELDS});item.update(requests=None,observations=None,requestCount=None,unknown=1,unknownFields={k:None for k in FIELDS},costUnknown=1)
            for key in ('cumulativeTotal','cumulativeRequests','peak','currentStreak','longestStreak'):
                if key in item:item[key]=None
        result.update(warming=True,dataVersion=str(version),pricing={'enabled':enabled},accounting={'incomplete':True,'message':'统计缓存正在后台准备，缺失数据保持未知'})
        return result
    def snapshot(self,owner,days=30,source='',provider='',model='',project='',scope='',connection_id='',include_all=False,rows_override=None,period='',start_date='',end_date='',cost_currency='CNY',models=None,value_currency='USD',range_earliest=None,valuation_enabled=None):
        from workbench.usage_summary import Dataset
        from workbench.codex_ledger import visible,coverage
        from workbench.usage_evidence import coverage as agent_coverage
        enabled=self.agent_value_enabled if valuation_enabled is None else bool(valuation_enabled)
        self.initialize();version=self.data_version(owner)
        params=dict(days=days,source=source,provider=provider,model=model,project=project,scope=scope,connection_id=connection_id,include_all=include_all,period=period,start_date=start_date,end_date=end_date,models=models)
        if rows_override is not None:return Dataset([dict(r) for r in rows_override],cost_currency,range_earliest).snapshot(**params)
        key=(owner,scope,version)
        with self.cache_lock:dataset=self.datasets.get(key)
        if dataset is None:
            with self.db() as db:
                db.execute('BEGIN')
                sql='SELECT * FROM events WHERE owner=?';args=[owner]
                if scope in ('codex','zcode','dsh'):sql+=' AND source=?';args.append(scope)
                elif scope=='api':sql+=" AND source NOT IN ('codex','zcode','dsh')"
                rows=[dict(r) for r in db.execute(sql+' ORDER BY at DESC',args) if visible(r)]
                if scope in ('zcode','dsh'):
                    verified={r[0] for r in db.execute('SELECT id FROM agent_evidence WHERE owner=? AND source=? AND verified=1',(owner,scope))}
                    rows=[r for r in rows if r['id'] in verified]
            dataset=Dataset(rows,cost_currency)
            with self.cache_lock:
                self.datasets={k:v for k,v in self.datasets.items() if k[:2]!=(owner,scope)};self.datasets[key]=dataset
        price_version=0
        if scope in ('codex','zcode','dsh') and enabled:
            from workbench.api_value import APIValue
            if self.value_reader is None:self.value_reader=APIValue(self)
            price_version=self.value_reader.version()
        cache_key=(key,price_version,cost_currency,value_currency,datetime.now(timezone(timedelta(hours=8))).date().isoformat(),json.dumps(dict(params,agent_value_enabled=enabled),sort_keys=True))
        with self.cache_lock:cached=self.snapshot_cache.get(cache_key)
        if cached is not None:return json.loads(cached)
        result=dataset.snapshot(**params)
        coverage_key=(owner,scope,version)
        with self.cache_lock:accounting=self.coverage_cache.get(coverage_key)
        if accounting is None:
            accounting=coverage(self,owner) if scope=='codex' else agent_coverage(self,owner,scope) if scope in ('zcode','dsh') else {}
            with self.cache_lock:
                self.coverage_cache={k:v for k,v in self.coverage_cache.items() if k[:2]!=(owner,scope)};self.coverage_cache[coverage_key]=accounting
        result['dataVersion']=str(version);result['accounting']=accounting
        result['pricing']={'enabled':enabled,'source':'https://modelradar.cn/data/models.json'}
        result['dataSource']={'kind':'local-logs','label':'已核验本机日志','scope':scope,'method':'usage-v18 / codex:v4','message':'本机活动、归档及既有导入证据；不等于官方账户活动汇总'}
        if scope in ('codex','zcode','dsh') and enabled:
            valued_key=(owner,scope,version,price_version,value_currency)
            with self.cache_lock:valued_data=self.datasets.get(valued_key)
            if valued_data is None:
                valued=self.value_reader.rows(owner,dataset.rows,value_currency)
                valued_data=Dataset(valued,value_currency)
                with self.cache_lock:
                    self.datasets={k:v for k,v in self.datasets.items() if len(k)<5 or k[:2]!=(owner,scope) or k[2:4]==(version,price_version)}
                    self.datasets[valued_key]=valued_data
            else:valued=valued_data.rows
            valuation=valued_data.snapshot(**params)
            reasons=valuation['summary'].get('valueIssues',{})
            valuation.update(experimental=True,costCurrency=value_currency,costAvailable=valuation['summary']['pricedRequests']>0,issues=reasons,assumptions='ModelRadar 当日原币文本 Token 参考等价值；不是实际账单，不含工具、缓存存储和订阅费用',priceVersion=valued[0].get('valueVersion',price_version) if valued else price_version)
            result['valuation']=valuation
        serialized=json.dumps(result,ensure_ascii=False)
        with self.cache_lock:
            if len(self.snapshot_cache)>=64:self.snapshot_cache.pop(next(iter(self.snapshot_cache)))
            self.snapshot_cache[cache_key]=serialized
        return result
