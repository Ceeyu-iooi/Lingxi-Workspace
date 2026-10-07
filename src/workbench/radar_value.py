"""Daily price observations; network collection never holds valuation locks."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime,date,timedelta,timezone
from decimal import Decimal,localcontext,InvalidOperation
from urllib import request,error
from urllib.parse import urlparse
import hashlib,json,re,threading,time,uuid
import workbench.storage_cache as cache

MILLION=Decimal(1000000)
RADAR='https://modelradar.cn/data/'
FX_URL='https://www.bankofcanada.ca/valet/observations/FXUSDCAD,FXCNYCAD/json'
SCENARIO='ModelRadar/native-currency/text'

def fetch(url,etag=''):
    if urlparse(url).hostname not in ('modelradar.cn','www.bankofcanada.ca'):raise ValueError('价格来源不受支持')
    class NoRedirect(request.HTTPRedirectHandler):
        def redirect_request(self,*args):return None
    headers={'User-Agent':'Lingxi-Usage/0.0.18','Accept':'application/json'}
    if etag:headers['If-None-Match']=etag
    try:
        with request.build_opener(NoRedirect).open(request.Request(url,headers=headers),timeout=12) as response:
            body=response.read(4*1024*1024+1)
            if len(body)>4*1024*1024:raise ValueError('价格响应过大')
            return body.decode('utf-8'),response.headers.get('ETag','')
    except error.HTTPError as exc:
        if exc.code==304:return None,etag
        raise

def validate(body,expected=None):
    data=json.loads(body,parse_float=Decimal)
    if not isinstance(data,dict) or data.get('schemaVersion') not in (1,'1','1.0.0') or data.get('billingUnit')!='per_1m_tokens':raise ValueError('价格结构版本或单位不受支持')
    day=date.fromisoformat(data['effectiveDate']);observed=datetime.fromisoformat(data['generatedAt'].replace('Z','+00:00'))
    if observed.tzinfo is None or observed.date()!=day or day>datetime.now(timezone.utc).date() or expected and day.isoformat()!=expected:raise ValueError('价格日期不正确')
    if not isinstance(data.get('models'),list) or len(data['models'])>10000:raise ValueError('模型目录不正确')
    models=[];seen=set()
    for r in data['models']:
        if not isinstance(r,dict) or not isinstance(r.get('id'),str) or not r['id'] or len(r['id'])>300 or r['id'] in seen:raise ValueError('模型身份不正确或重复')
        seen.add(r['id']);q={}
        for k,f in [('input','inputPricePer1M'),('output','outputPricePer1M'),('cached','cacheReadPricePer1M'),('write','cacheWritePricePer1M')]:
            v=r.get(f)
            if v is not None:
                if isinstance(v,bool):raise ValueError('价格不是有效数值')
                try:v=Decimal(str(v))
                except InvalidOperation:raise ValueError('价格不是有效数值') from None
                if not v.is_finite() or not 0<=v<=100000:raise ValueError('价格超出范围')
            q[k]=None if v is None else str(v)
        source=r.get('sourceUrl','');source=source if isinstance(source,str) and urlparse(source).scheme=='https' else 'https://modelradar.cn/api'
        notes=str(r.get('pricingNotes') or '')[:2000]
        unsupported=bool(re.search(r'阶梯|分时|高峰|低峰|batch|priority|regional|audio|image|tts|超过|above|tiered|threshold',notes,re.I))
        models.append(dict(model=r['id'],provider=str(r.get('provider') or ''),currency=r.get('currency'),quote=q,source=source,sourceType=r.get('sourceType'),notes=notes,
            unsupported=unsupported or bool(r.get('pricingRules')) or bool(re.search(r'audio|tts|image|sora|video',r['id'],re.I))))
    return day.isoformat(),models

class APIValue:
    def __init__(self,monitor):
        self.monitor=monitor;self.lock=threading.RLock();self.sync_lock=threading.Lock();self.ready=False
        self.refreshing=False;self.last_attempt=0;self.task={'status':'idle','errors':[]};self.index=None;self.index_version=None
    def setup(self):
        self.monitor.initialize()
        with self.lock:
            if self.ready:return
            with self.monitor.db() as db:
                db.execute('CREATE TABLE IF NOT EXISTS radar_days(day TEXT PRIMARY KEY,body TEXT,digest TEXT,source TEXT,observed TEXT)')
                db.execute('CREATE TABLE IF NOT EXISTS radar_meta(id INTEGER PRIMARY KEY,version INTEGER)');db.execute('INSERT OR IGNORE INTO radar_meta VALUES(1,0)')
                db.execute('CREATE TABLE IF NOT EXISTS radar_fetches(url TEXT PRIMARY KEY,etag TEXT,attempt REAL,success REAL,failures INTEGER,error TEXT)')
                db.execute('CREATE TABLE IF NOT EXISTS value_fx(day TEXT PRIMARY KEY,usd_cad TEXT,cny_cad TEXT,source TEXT,observed TEXT,digest TEXT)')
                db.execute('CREATE TABLE IF NOT EXISTS radar_values(owner TEXT,id TEXT,currency TEXT,fingerprint TEXT,result TEXT,PRIMARY KEY(owner,id,currency))')
                db.execute('CREATE TABLE IF NOT EXISTS radar_observations(url TEXT,digest TEXT,body TEXT,observed TEXT,PRIMARY KEY(url,digest))')
                cache.setup(db)
                pending=bool(db.execute("SELECT 1 FROM radar_days WHERE body NOT LIKE '@blob:%' LIMIT 1").fetchone() or db.execute("SELECT 1 FROM radar_observations WHERE body NOT LIKE '@blob:%' LIMIT 1").fetchone() or db.execute("SELECT 1 FROM radar_values WHERE json_extract(result,'$._proof') IS NULL LIMIT 1").fetchone())
            self.ready=True
            self.migration_thread=None
            if not pending:
                self.migration={'status':'complete'}
                return
            self.migration={'status':'running'}
            def migrate():
                try:
                    cache.migrate(self.monitor);self.migration={'status':'complete'}
                except Exception:
                    self.migration={'status':'failed','error':'缓存迁移未完成，保留原证据'}
            self.migration_thread=threading.Thread(target=migrate,name='evidence-compression',daemon=True)
            self.migration_thread.start()
    def body(self,value,db=None):
        if db is not None:return cache.read(db,value)
        with self.monitor.db() as connection:return cache.read(connection,value)
    def version(self):
        self.setup()
        with self.monitor.db() as db:return db.execute('SELECT version FROM radar_meta WHERE id=1').fetchone()[0]
    def _index(self):
        version=self.version()
        with self.lock:
            if self.index_version==version:return self.index
        prices={}
        with self.monitor.db() as db:
            db.execute('BEGIN')
            version=db.execute('SELECT version FROM radar_meta WHERE id=1').fetchone()[0]
            for r in db.execute('SELECT * FROM radar_days'):
                day,models=validate(self.body(r['body'],db),r['day'])
                for p in models:prices[(day,p['model'])]=dict(p,day=day,digest=r['digest'],observed=r['observed'],snapshotSource=r['source'])
            fx={r['day']:dict(r) for r in db.execute('SELECT * FROM value_fx')}
        index=(prices,fx,version)
        with self.lock:
            if self.index_version is None or self.index_version<=version:self.index=index;self.index_version=version
        return index
    def state(self):
        prices,fx,version=self._index();intervals=[]
        for p in sorted(prices.values(),key=lambda p:(p['model'],p['day'])):
            end=(date.fromisoformat(p['day'])+timedelta(days=1)).isoformat()+'T00:00:00+00:00';item=dict(p,id=p['model']+':'+p['day'],start=p['day']+'T00:00:00+00:00',end=end)
            if intervals and intervals[-1]['model']==item['model'] and intervals[-1]['end']==item['start'] and all(intervals[-1][k]==item[k] for k in ('quote','currency','sourceType','unsupported')):intervals[-1]['end']=end
            else:intervals.append(item)
        return dict(experimental=True,mode=SCENARIO,source=RADAR+'models.json',agentCalculationEnabled=self.monitor.agent_value_enabled,prices=intervals,fxDays=len(fx),historicalAPI=True,refreshing=self.refreshing,task=dict(self.task),version=version,assumptions='ModelRadar 当日原币文本 Token 参考等价值；不是实际账单')
    def ensure_fresh(self):
        self.setup()
        if time.monotonic()-self.last_attempt>=3600:self.start_sync()
    def start_sync(self,start=None,end=None):
        today=datetime.now(timezone.utc).date();start=start or (today-timedelta(days=365)).isoformat();end=end or today.isoformat()
        a=date.fromisoformat(start);b=date.fromisoformat(end)
        if a>b or (b-a).days>1096 or b>today:raise ValueError('价格同步最多三年，不能查询未来')
        with self.lock:
            if self.refreshing:return dict(self.task,refreshing=True)
            self.refreshing=True;self.last_attempt=time.monotonic();self.task=dict(id=uuid.uuid4().hex,status='running',errors=[])
        def work():
            try:
                result=self.sync(start,end)
                with self.lock:self.task.update(result,status='complete')
            except Exception:
                with self.lock:self.task.update(status='failed',errors=[{'source':'ModelRadar','error':'价格同步失败，保留已有证据'}])
            finally:
                with self.lock:self.refreshing=False
        threading.Thread(target=work,name='modelradar-sync',daemon=True).start();return dict(self.task,refreshing=True)
    def sync(self,start,end,loader=fetch,*,owner=None,scope=None,required_rows=None,progress=None,check=None,force=False):
        self.setup();a=date.fromisoformat(start);b=date.fromisoformat(end)
        if a>b or (required_rows is None and (b-a).days>1096) or b>datetime.now(timezone.utc).date():raise ValueError('价格日期范围不正确，不能查询未来')
        with self.sync_lock:
            with self.monitor.db() as db:
                known={r['day']:self.body(r['body'],db) for r in db.execute('SELECT day,body FROM radar_days')}
                rows=required_rows if required_rows is not None else [dict(r) for r in db.execute("SELECT at,model FROM events WHERE source IN ('codex','zcode','dsh')" + (' AND owner=? AND source=?' if owner is not None else ''), (owner,scope) if owner is not None else ())]
                used={datetime.fromisoformat(r['at'].replace('Z','+00:00')).astimezone(timezone.utc).date() for r in rows}
                prior={r['url']:dict(r) for r in db.execute('SELECT * FROM radar_fetches')}
            days={d for d in used if a<=d<=b};days|={d-timedelta(days=1) for d in days}
            required={}
            for r in rows:
                day=datetime.fromisoformat(r['at'].replace('Z','+00:00')).astimezone(timezone.utc).date()
                for d in (day,day-timedelta(days=1)):required.setdefault(d.isoformat(),set()).add(r['model'].removeprefix('chatgpt-web/'))
            def incomplete(d):
                if d not in known:return True
                try:return not required.get(d,set()).issubset({m['model'] for m in validate(known[d],d)[1]})
                except ValueError:return True
            urls=[RADAR+'models.json',RADAR+'changelog.json']+[RADAR+'history/'+d.isoformat()+'.json' for d in sorted(days) if incomplete(d.isoformat())]
            errors=[];gaps=[];changed=checked=0;observed=datetime.now(timezone.utc).isoformat()
            def load(url):
                if check:check()
                old=prior.get(url,{});delay=min(86400,3600*2**min(old.get('failures',0),4)) if old.get('failures') else 3600
                if not force and loader is fetch and time.time()-old.get('attempt',0)<delay:return None
                try:
                    result=loader(url,old.get('etag','')) if loader is fetch else loader(url);body,etag=result if isinstance(result,tuple) else (result,'');parsed=None
                    if body is not None:
                        if url.endswith('changelog.json'):
                            if not isinstance(json.loads(body).get('history'),list):raise ValueError('变更日志不正确')
                        else:parsed=validate(body,url.rsplit('/',1)[-1][:-5] if '/history/' in url else None)
                    return url,body,etag,parsed,None
                except error.HTTPError as exc:
                    return url,None,old.get('etag',''),None,'snapshot_unavailable' if exc.code==404 and '/history/' in url else '价格网络读取失败'
                except ValueError:return url,None,old.get('etag',''),None,'snapshot_invalid' if '/history/' in url else '模型目录结构不正确'
                except Exception:return url,None,old.get('etag',''),None,'价格读取失败，未回填历史'
            responses=[]
            with ThreadPoolExecutor(max_workers=4) as pool:
                for result in pool.map(load,urls):
                    if check:check()
                    responses.append(result)
                    if progress:progress(phase='prices',completed=len(responses),total=len(urls))
            with self.monitor.db() as db:
                for result in responses:
                    if result is None:continue
                    url,body,etag,parsed,err=result;checked+=1;old=prior.get(url,{})
                    db.execute('INSERT OR REPLACE INTO radar_fetches VALUES(?,?,?,?,?,?)',(url,etag,time.time(),old.get('success',0) if err else time.time(),old.get('failures',0)+1 if err else 0,err))
                    if err:
                        (gaps if err in ('snapshot_unavailable','snapshot_invalid') else errors).append({'source':url,'error':err});continue
                    if body is not None:db.execute('INSERT OR IGNORE INTO radar_observations VALUES(?,?,?,?)',(url,hashlib.sha256(body.encode()).hexdigest(),cache.store(db,body),observed))
                    if parsed:
                        day,_=parsed;digest=hashlib.sha256(body.encode()).hexdigest();previous=db.execute('SELECT digest FROM radar_days WHERE day=?',(day,)).fetchone()
                        if not previous or previous[0]!=digest:db.execute('INSERT OR REPLACE INTO radar_days VALUES(?,?,?,?,?)',(day,cache.store(db,body),digest,url,observed));changed+=1
                if changed:db.execute('UPDATE radar_meta SET version=version+1 WHERE id=1')
            fx_days=0
            try:
                if check:check()
                if progress:progress(phase='fx',completed=0,total=1)
                result=loader(FX_URL+'?start_date='+(a-timedelta(days=10)).isoformat()+'&end_date='+b.isoformat());body=result[0] if isinstance(result,tuple) else result;rows=[];last=None
                for r in json.loads(body)['observations']:
                    day=date.fromisoformat(r['d']);usd=Decimal(r['FXUSDCAD']['v']);cny=Decimal(r['FXCNYCAD']['v'])
                    if not all(v.is_finite() and Decimal('.001')<v<100 for v in (usd,cny)) or last and day<=last or not a-timedelta(days=10)<=day<=b:raise ValueError('汇率响应不正确')
                    last=day;rows.append((day.isoformat(),str(usd),str(cny),FX_URL,observed,hashlib.sha256(body.encode()).hexdigest()))
                with self.monitor.db() as db:
                    for row in rows:
                        old=db.execute('SELECT usd_cad,cny_cad FROM value_fx WHERE day=?',(row[0],)).fetchone()
                        if not old or tuple(old)!=row[1:3]:fx_days+=1
                    db.executemany('INSERT OR REPLACE INTO value_fx VALUES(?,?,?,?,?,?)',rows)
                    if fx_days:db.execute('UPDATE radar_meta SET version=version+1 WHERE id=1')
            except Exception:errors.append({'source':FX_URL,'error':'历史汇率读取失败，保留已有数据'})
            if check:check()
            return dict(pricesChecked=checked,pricesAdded=changed,fxDays=fx_days,errors=errors,gaps=gaps,observed=observed)
    def rows(self,owner,rows,currency='USD'):
        if currency not in ('USD','CNY'):raise ValueError('等价值币种须为 USD 或 CNY')
        prices,fx,version=self._index()
        with self.monitor.db() as db:
            evidence={r['id']:json.loads(r['raw']) for r in db.execute('SELECT id,raw FROM codex_evidence WHERE owner=? AND verified=1',(owner,))}
            evidence.update({r['id']:json.loads(r['raw']) for r in db.execute('SELECT id,raw FROM agent_evidence WHERE owner=? AND verified=1',(owner,))})
            cached={r['id']:dict(r) for r in db.execute('SELECT * FROM radar_values WHERE owner=? AND currency=?',(owner,currency))}
        result=[];updates=[]
        with self.monitor.db() as db:
            proof_cache={}
            decoded={key:cache.expand(db,item['result'],{},proof_cache) for key,item in cached.items()}
        for row in rows:
            raw=evidence.get(row['id']);fingerprint=hashlib.sha256(json.dumps([version,row,raw],sort_keys=True,default=str).encode()).hexdigest();old=cached.get(row['id'])
            if old and old['fingerprint']==fingerprint:valued={**row,**{k:v for k,v in decoded[row['id']].items() if k in ('cost','currency','valueReason','valueProof','valueParts','valueVersion')}}
            else:
                amount,reason,proof,parts=self.evaluate(row,raw,prices,fx,currency);valued=dict(row,cost=None if amount is None else str(amount),currency=currency,valueReason=reason,valueProof=proof,valueParts=parts,valueVersion=version)
                updates.append((owner,row['id'],currency,fingerprint,valued))
            result.append(valued)
        if updates:
            with self.monitor.db() as db:
                db.executemany('INSERT OR REPLACE INTO radar_values VALUES(?,?,?,?,?)',[(o,i,c,f,cache.compact(db,v)) for o,i,c,f,v in updates])
        return result
    @staticmethod
    def evaluate(row,raw,prices,fx,currency):
        at=datetime.fromisoformat(row['at'].replace('Z','+00:00')).astimezone(timezone.utc);model=row['model'].removeprefix('chatgpt-web/');p=prices.get((at.date().isoformat(),model))
        if not p:return None,'missing_historical_price',{},{}
        if p['sourceType']!='provider':return None,'fallback_price',{},{}
        if p['unsupported'] or p['currency'] not in ('USD','CNY'):return None,'unsupported_pricing_rules',{},{}
        previous=prices.get(((at.date()-timedelta(days=1)).isoformat(),model))
        if previous and (previous['quote'],previous['currency'])!=(p['quote'],p['currency']):return None,'uncertain_price_transition',{},{}
        if not raw:return None,'missing_usage_evidence',{},{}
        u=raw.get('last_token_usage') or raw.get('usage') or {};written=u.get('cache_write_input_tokens',u.get('cache_creation_input_tokens',u.get('cacheWriteTokens')))
        if None in (row.get('input'),row.get('output'),row.get('cached'),written):return None,'missing_usage_details',{},{}
        if isinstance(written,bool) or not isinstance(written,int) or written<0 or row['cached']+written>row['input']:return None,'conflicting_usage_evidence',{},{}
        incoming=u.get('input_tokens',u.get('input',u.get('inputTokens')));outgoing=u.get('output_tokens',u.get('output',u.get('outputTokens')))
        cache=u.get('cached_input_tokens',u.get('cached',u.get('cacheReadTokens')));total=u.get('total_tokens',u.get('total',u.get('totalTokens')))
        if 'inputTokens' in u and None not in (incoming,cache,written):incoming+=cache+written
        elif None not in (incoming,outgoing,total,cache,written) and incoming+outgoing!=total and incoming+cache+written+outgoing==total:incoming+=cache+written
        if any(actual!=expected for actual,expected in zip((row['input'],row['output'],row['cached'],row['total']),(incoming,outgoing,cache,total))):return None,'conflicting_usage_evidence',{},{}
        if raw.get('model') and raw['model'].removeprefix('chatgpt-web/')!=model:return None,'conflicting_model_evidence',{},{}
        quantities={'input':row['input']-row['cached']-written,'cached':row['cached'],'write':written,'output':row['output']}
        if any(v and p['quote'][k] is None for k,v in quantities.items()):return None,'missing_component_price',{},{}
        proof=dict(model=model,source=p['source'],snapshotSource=p['snapshotSource'],priceDate=p['day'],priceCurrency=p['currency'],digest=p['digest'],scenario=SCENARIO)
        with localcontext() as ctx:
            ctx.prec=100;parts={k:Decimal(v)*Decimal(p['quote'][k] or '0')/MILLION for k,v in quantities.items()}
            if currency!=p['currency']:
                day=at.astimezone(timezone(timedelta(hours=8))).date();rate=next((fx[(day-timedelta(days=i)).isoformat()] for i in range(8) if (day-timedelta(days=i)).isoformat() in fx),None)
                if not rate:return None,'missing_historical_fx',proof,{}
                ratio=Decimal(rate['usd_cad'])/Decimal(rate['cny_cad']);parts={k:v*ratio if p['currency']=='USD' else v/ratio for k,v in parts.items()}
                proof['fx']=dict(rate=str(ratio),rateDate=rate['day'],usageDate=day.isoformat(),carried=rate['day']!=day.isoformat(),source=rate['source'],digest=rate['digest'])
            return sum(parts.values(),Decimal(0)),'priced',proof,{k:str(v) for k,v in parts.items()}
