"""Read-only Harness v3/v4 usage, including concatenated Zstandard frames."""
from pathlib import Path
import hashlib
import json
import os
import sys
from workbench.ai_monitor import iso,tokens
from workbench.usage_evidence import encode,store

MAX_LINE = 8*1024*1024
MAX_DECODED = 256*1024*1024
MAX_COMPRESSED = 128*1024*1024


def default_path():
    return str(Path(os.environ.get('DSH_HOME') or Path.home()/'.dsh')/'sessions')


def lines(path):
    with path.open('rb') as raw:
        if raw.read(4) != b'\x28\xb5\x2f\xfd':
            raw.seek(0); stream=raw; reader=None
        else:
            raw.seek(0)
            from workbench.paths import resource
            dependency=resource('.runtime/deps')
            if dependency.is_dir() and str(dependency) not in sys.path:sys.path.insert(0,str(dependency))
            try:import zstandard
            except ImportError:raise ValueError('请安装 requirements.txt 中的 zstandard==0.25.0') from None
            # stream_reader crosses frames; single-shot decompress stops after frame one.
            reader=zstandard.ZstdDecompressor(max_window_size=64*1024*1024).stream_reader(raw,read_across_frames=True)
            stream=reader
        buffer=b''; consumed=0
        try:
            while consumed<MAX_DECODED:
                try:chunk=stream.read(min(128*1024,MAX_DECODED-consumed))
                except Exception as exc:
                    if reader and isinstance(exc,zstandard.ZstdError):
                        if 'memory' in str(exc).lower():raise ValueError('Harness 压缩帧超过解码内存限制') from None
                        return
                    raise
                if not chunk:return
                consumed+=len(chunk);buffer+=chunk
                while b'\n' in buffer:
                    line,buffer=buffer.split(b'\n',1)
                    if len(line)>MAX_LINE:raise ValueError('Harness 单条记录超过大小限制')
                    if line.strip():yield json.loads(line)
                if len(buffer)>MAX_LINE:raise ValueError('Harness 单条记录超过大小限制')
            raise ValueError('Harness 解压数据超过单次限制')
        finally:
            if reader:reader.close()


def parse(path):
    rows=list(lines(path));header=next((r for r in rows if r.get('type')=='session'),{})
    sid=header.get('id');version=header.get('version')
    if not isinstance(sid,str) or not sid or version not in (None,2,3,4):raise ValueError('Harness 会话头或版本不受支持')
    seeded=header.get('isSeeded') is True or header.get('seedLength') is not None
    cuts=[r.get('seq') for r in rows if r.get('type')=='session/end-seed' and r.get('data',{}).get('inherited') is True and isinstance(r.get('seq'),int)]
    cut=header.get('seedLength') if isinstance(header.get('seedLength'),int) else cuts[-1] if cuts else None
    if seeded and cut is None:raise ValueError('Harness 继承会话缺少可核验的边界')
    model=provider=None;settlements={};result=[];retry={}
    for r in rows:
        kind=r.get('type');d=r.get('data') or {}
        if kind=='request/header':
            config=d.get('header',{}).get('config',{});model=config.get('model');provider=config.get('provider');continue
        if kind=='llm/retry-started':
            slot=(d.get('turn'),d.get('step'));retry[slot]=retry.get(slot,0)+1;continue
        if kind not in ('assistant/message','assistant/attempt','compaction/summary'):continue
        if seeded and (not isinstance(r.get('seq'),int) or r['seq']<cut):continue
        message=d.get('message') or {};source=message.get('source') or d.get('source') or {}
        served=source.get('replayState',{}).get('response',{}).get('responseModel') or source.get('model') or model
        routed=source.get('provider') or provider
        usage=d.get('usage') if kind!='assistant/attempt' else None
        if not isinstance(usage,dict):
            chunks=[x.get('chunk',{}).get('usage') for x in d.get('stream',[]) if x.get('type')=='chunk' and x.get('chunk',{}).get('type')=='usage']
            usage=next((x for x in reversed(chunks) if isinstance(x,dict)),None)
        if not isinstance(usage,dict):continue
        slot=(d.get('turn'),d.get('step'));attempt=retry.get(slot,0)
        identity=d.get('attemptId') or d.get('retryId') if kind=='assistant/attempt' else message.get('id') or d.get('compactionId')
        if kind=='compaction/summary' and not identity:identity=['summary',r.get('seq'),r.get('time')]
        # Stable logical settlement slot permits a later final sample to correct it.
        stable=[sid,kind if kind=='compaction/summary' else 'settlement',slot,attempt,identity if slot==(None,None) or kind=='compaction/summary' else None]
        ident='dsh:'+hashlib.sha256(encode(stable).encode()).hexdigest()
        reason='verified';normalized=None
        usage={k:v for k,v in usage.items() if k in ('inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','reasoningTokens','totalTokens')}
        evidence={'kind':kind,'session':sid,'version':version,'time':r.get('time'),'seq':r.get('seq'),'turn':slot[0],'step':slot[1],'attempt':attempt,'identity':identity,'model':served,'provider':routed,'usage':usage,'seedCut':cut}
        try:
            stamp=r.get('time')
            if isinstance(stamp,bool) or not isinstance(stamp,(int,float)) or stamp<=0:raise ValueError('missing_timestamp')
            at=iso(stamp/1000)
            if not isinstance(served,str) or not served:raise ValueError('missing_model')
            for value in usage.values():
                if isinstance(value,bool) or not isinstance(value,int) or value<0:raise ValueError('invalid_usage')
            incoming=usage.get('inputTokens');cached=usage.get('cacheReadTokens');written=usage.get('cacheWriteTokens');out=usage.get('outputTokens')
            complete=None if None in (incoming,cached,written) else incoming+cached+written
            normalized=tokens({'input_tokens':complete,'output_tokens':out,'total_tokens':usage.get('totalTokens'),
                'cached_input_tokens':cached,'cache_write_input_tokens':written,'reasoning_output_tokens':usage.get('reasoningTokens')})
            if not normalized or normalized['total'] is None:raise ValueError('missing_usage')
        except ValueError as exc:reason=str(exc) if str(exc) in ('missing_timestamp','missing_model','invalid_usage','missing_usage') else 'conflicting_usage';at=iso(0)
        record=dict(id=ident,at=at,source='dsh',agent='DeepSeek Harness',provider=routed or '未标注',model=served or '未识别模型',session=sid,project=str(header.get('cwd') or ''),status='success',auth_mode='unconfirmed',usage=normalized,evidence=evidence,reason=reason)
        if ident in settlements:result[settlements[ident]]=record
        else:settlements[ident]=len(result);result.append(record)
    return result


def scan(monitor,owner,root):
    monitor.initialize();root=Path(root).resolve()
    if not root.is_dir():raise ValueError('Harness sessions 目录不存在')
    with monitor.db() as db:known={r['path']:json.loads(r['state']) for r in db.execute('SELECT path,state FROM agent_reads WHERE owner=? AND source=?',(owner,'dsh'))}
    files=sorted(p for p in root.rglob('session*.jsonl*') if p.is_file() and p.resolve().is_relative_to(root))
    records=[];reads=[];errors=[];scanned=0
    pending=0
    for path in files:
        stat=path.stat();fingerprint={'size':stat.st_size,'mtime':stat.st_mtime_ns}
        prior=known.get(str(path),{})
        if prior.get('size')==stat.st_size and prior.get('mtime')==stat.st_mtime_ns and not prior.get('error'):continue
        if len(reads)>=3000:pending+=1;continue
        try:
            if stat.st_size>MAX_COMPRESSED:raise ValueError('Harness 文件超过单次读取限制')
            records.extend(parse(path));scanned+=1
            after=path.stat()
            if (after.st_size,after.st_mtime_ns)!=(stat.st_size,stat.st_mtime_ns):fingerprint['error']='文件正在写入，将继续采集'
        except (ValueError,OSError,TypeError) as exc:fingerprint['error']='Harness 证据读取失败：'+str(exc)[:100];errors.append({'file':path.name,'error':fingerprint['error']})
        reads.append((path,fingerprint))
    added,updated=store(monitor,owner,'dsh',records,reads)
    return dict(files=len(files),scanned=scanned,imported=added,updated=updated,errors=errors[:100],truncated=bool(pending),pending=pending,syncedAt=iso(),coverage='Harness 本机真实用量；未含无 usage 的标题、搜索等调用，不自动归属 API Key')
