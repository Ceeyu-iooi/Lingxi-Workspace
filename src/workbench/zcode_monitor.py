"""Read-only ZCode request ledger with exact legacy-cache normalization."""
from contextlib import closing
from pathlib import Path
import hashlib,json,os,shutil,sqlite3,tempfile
from workbench.ai_monitor import iso,tokens
from workbench.usage_evidence import encode,store

def default_path():return str(Path(os.environ.get('ZCODE_DATA_BASE_DIR') or Path.home()/'.zcode')/'cli')

def normalize(u):
    incoming=u.get('input_tokens');out=u.get('output_tokens');cached=u.get('cached_input_tokens');written=u.get('cache_write_input_tokens');total=u.get('total_tokens')
    if None not in (incoming,out,cached,written,total) and total!=incoming+out:
        if total==incoming+cached+written+out:u=dict(u,input_tokens=incoming+cached+written)
        else:raise ValueError('ZCode 完整输入、缓存与总 Token 冲突')
    return tokens(u)

def scan(monitor,owner,root):
    monitor.initialize();root=Path(root).resolve()
    if not root.exists():raise ValueError('ZCode 用量目录不存在')
    database=root if root.is_file() and root.suffix in ('.sqlite','.db') else root/'db'/'db.sqlite'
    if not database.exists() and root.is_dir() and (root/'db.sqlite').exists():database=root/'db.sqlite'
    with monitor.db() as db:known={r['path']:json.loads(r['state']) for r in db.execute('SELECT path,state FROM agent_reads WHERE owner=? AND source=?',(owner,'zcode'))}
    records={};reads=[];errors=[];files=scanned=0;database_identity=False;pending=0
    def accept(r,origin):
        nonlocal scanned
        scanned+=1;ident='zcode:'+hashlib.sha256((str(r.get('session_id',''))+':'+str(r['request_id'])).encode()).hexdigest()
        reason='verified';u=r['usage']
        try:
            if r.get('stamp') is None:raise ValueError('缺少原始消费时间')
            stamp=iso(r['stamp']);counts=normalize(u)
            if counts is None or counts['total'] is None:raise ValueError('缺少真实用量')
            if not r.get('model_id'):raise ValueError('缺少真实模型')
        except (ValueError,TypeError):reason='conflicting_or_missing_usage';counts=None;stamp=iso(0)
        if origin=='model_io' and database.exists() and not database_identity:reason='unverified_source_overlap'
        raw=dict(usage={k:u.get(k) for k in ('input_tokens','output_tokens','total_tokens','cached_input_tokens','cache_write_input_tokens','reasoning_output_tokens')},
            request=r['request_id'],model=r.get('model_id'),provider=r.get('provider_id'),timestamp=r.get('stamp'),origin=origin)
        record=dict(id=ident,at=stamp,source='zcode',agent=r.get('agent') or 'ZCode',provider=r.get('provider_id') or '未标注',model=r.get('model_id') or '未识别模型',session=r.get('session_id') or '',project=r.get('project') or '',status=r.get('status') or 'success',duration_ms=r.get('duration_ms'),auth_mode='unconfirmed',usage=counts,evidence=raw,reason=reason)
        # Database is authoritative only for this same logical request/attempt.
        if ident not in records or origin=='database':records[ident]=record
    if database.exists():
        files+=1;sources=[database,Path(str(database)+'-wal')]
        state={'files':[(p.stat().st_size,p.stat().st_mtime_ns) if p.exists() else None for p in sources]}
        previous=known.get(str(database),{})
        database_identity=previous.get('identity',False)
        if previous.get('files')!=[list(x) if x else None for x in state['files']] or previous.get('error'):
            try:
                with tempfile.TemporaryDirectory(prefix='zcode-read-',dir=monitor.path.parent) as tmp:
                    target=Path(tmp)/'db.sqlite';stable=False
                    for _ in range(3):
                        before=[(p.stat().st_size,p.stat().st_mtime_ns) if p.exists() else None for p in sources]
                        for p in sources:
                            dest=Path(str(target)+('-wal' if p.name.endswith('-wal') else ''))
                            if p.exists():shutil.copyfile(p,dest)
                            elif dest.exists():dest.unlink()
                        after=[(p.stat().st_size,p.stat().st_mtime_ns) if p.exists() else None for p in sources]
                        if before==after:stable=True;state['files']=after;break
                    if not stable:raise ValueError('ZCode 正在写入，请稍后同步')
                    with closing(sqlite3.connect(target)) as db:
                        db.row_factory=sqlite3.Row;columns={r[1] for r in db.execute('PRAGMA table_info(model_usage)')}
                        database_identity='logical_request_id' in columns;state['identity']=database_identity
                        required={'id','model_id','started_at','input_tokens','output_tokens','computed_total_tokens'}
                        if not required<=columns:raise ValueError('数据库缺少受支持的 model_usage 表')
                        names=[k for k in ('id','logical_request_id','attempt_index','session_id','model_id','provider_id','agent','status','started_at','duration_ms','input_tokens','output_tokens','reasoning_tokens','cache_read_input_tokens','cache_creation_input_tokens','provider_total_tokens','computed_total_tokens') if k in columns]
                        cursor=db.execute('SELECT '+','.join(names)+' FROM model_usage ORDER BY started_at,id')
                        while True:
                            batch=cursor.fetchmany(1000)
                            if not batch:break
                            for row in batch:
                                r=dict(row);u=dict(input_tokens=r['input_tokens'],output_tokens=r['output_tokens'],total_tokens=r.get('provider_total_tokens') if r.get('provider_total_tokens') is not None else r['computed_total_tokens'],cached_input_tokens=r.get('cache_read_input_tokens'),cache_write_input_tokens=r.get('cache_creation_input_tokens'),reasoning_output_tokens=r.get('reasoning_tokens'))
                                r.update(usage=u,request_id=str(r.get('logical_request_id') or r['id'])+':'+str(r.get('attempt_index') or 0),stamp=r['started_at']/1000 if isinstance(r['started_at'],(int,float)) else None)
                                accept(r,'database')
            except (ValueError,OSError,sqlite3.Error) as exc:state['error']='ZCode 证据读取失败：'+str(exc)[:100];errors.append({'file':database.name,'error':state['error']})
            reads.append((database,state))
    for path in (sorted(root.rglob('model-io-*.jsonl')) if root.is_dir() else []):
        if not path.resolve().is_relative_to(root):continue
        files+=1;stat=path.stat();state={'size':stat.st_size,'mtime':stat.st_mtime_ns,'databaseMode':database_identity if database.exists() else None}
        if known.get(str(path))==state:continue
        if len(reads)>=3000:pending+=1;continue
        try:
            with path.open('rb') as stream:
                while True:
                    line=stream.readline(8*1024*1024+1)
                    if not line:break
                    if len(line)>8*1024*1024:raise ValueError('单条证据过大')
                    if not line.endswith(b'\n'):state['error']='尾行尚未完成';break
                    x=json.loads(line)
                    if x.get('type')!='model_io':continue
                    response=x.get('response') or {};u=response.get('usage') or {};model=x.get('model') or {}
                    accept(dict(request_id=str(x['requestId'])+':'+str(x.get('attempt',0)),stamp=x.get('startedAt')/1000 if isinstance(x.get('startedAt'),(int,float)) else x.get('startedAt'),session_id=x.get('sessionId',''),model_id=response.get('modelId') or model.get('modelId'),provider_id=model.get('providerId'),status='error' if x.get('error') else 'success',duration_ms=x.get('durationMs'),usage=dict(input_tokens=u.get('inputTokens'),output_tokens=u.get('outputTokens'),total_tokens=u.get('totalTokens'),cached_input_tokens=u.get('cacheReadTokens'),cache_write_input_tokens=u.get('cacheWriteTokens',u.get('cacheCreationTokens')),reasoning_output_tokens=u.get('reasoningTokens'))),'model_io')
        except (ValueError,OSError,KeyError,TypeError):state['error']='ZCode JSONL 证据读取失败';errors.append({'file':path.name,'error':state['error']})
        reads.append((path,state))
    added,updated=store(monitor,owner,'zcode',list(records.values()),reads)
    return dict(files=files,scanned=scanned,imported=added,updated=updated,errors=errors[:100],truncated=bool(pending),pending=pending,syncedAt=iso(),coverage='ZCode 数据库／响应日志；同一请求只计一次，缺失或冲突未补数')
