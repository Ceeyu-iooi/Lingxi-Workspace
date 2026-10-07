from contextlib import closing
from datetime import datetime
from pathlib import Path
import hashlib
import json
import re
import sqlite3

VERSION = 4
SCAN_LIMIT = 3000
FIELDS = ('input', 'output', 'cached', 'reasoning', 'total')


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def identity_counts(counts):
    # Preserve v4 identities through the missing-subset migration. These sentinels
    # are used only for hashing, never as reported counts or pricing evidence.
    return None if counts is None else {k:0 if k in ('cached','reasoning') and v is None else v for k,v in counts.items()}


def setup(db):
    db.execute('CREATE TABLE IF NOT EXISTS codex_meta(owner TEXT PRIMARY KEY,version INTEGER)')
    db.execute('''CREATE TABLE IF NOT EXISTS codex_evidence(
        owner TEXT,id TEXT,session TEXT,at TEXT,provider TEXT,model TEXT,
        cumulative TEXT,last_usage TEXT,usage TEXT,baseline TEXT,reason TEXT,
        verified INTEGER,PRIMARY KEY(owner,id))''')
    db.execute('CREATE INDEX IF NOT EXISTS codex_evidence_origin ON codex_evidence(owner,session,at)')
    if 'raw' not in {r[1] for r in db.execute('PRAGMA table_info(codex_evidence)')}:
        db.execute("ALTER TABLE codex_evidence ADD COLUMN raw TEXT NOT NULL DEFAULT '{}'")
    if 'lineage' not in {r[1] for r in db.execute('PRAGMA table_info(codex_evidence)')}:
        db.execute("ALTER TABLE codex_evidence ADD COLUMN lineage TEXT NOT NULL DEFAULT '{}'")
    db.execute('CREATE TABLE IF NOT EXISTS codex_links(owner TEXT,path TEXT,id TEXT,PRIMARY KEY(owner,path,id))')
    db.execute('CREATE TABLE IF NOT EXISTS codex_retired(owner TEXT,id TEXT,record TEXT,reason TEXT,at TEXT,PRIMARY KEY(owner,id))')
    db.execute('CREATE TABLE IF NOT EXISTS codex_reads(owner TEXT,path TEXT,error TEXT,PRIMARY KEY(owner,path))')


def real(counts):
    return bool(counts and all(counts.get(k) is not None for k in ('input','output','total'))
        and counts['input'] + counts['output'] == counts['total']
        and counts['total'] > 0 and (counts['cached'] is None or counts['cached'] <= counts['input'])
        and (counts['reasoning'] is None or counts['reasoning'] <= counts['output']))


def decode(raw, normalize):
    if not isinstance(raw, dict):
        return None
    incoming = raw.get('input_tokens'); outgoing = raw.get('output_tokens'); total = raw.get('total_tokens')
    cached = raw.get('cached_input_tokens', 0); written = raw.get('cache_write_input_tokens', 0)
    if any(value is None for value in (cached,written,raw.get('reasoning_output_tokens',0))):
        raise ValueError('日志 Token 明细不能是 null')
    for value in (incoming, outgoing, total, cached, written, raw.get('reasoning_output_tokens', 0)):
        if value is not None and (isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > 9223372036854775807):
            raise ValueError('日志 Token 必须是有效范围内的非负整数')
    values = dict(raw)
    if incoming is not None and outgoing is not None and total is not None:
        if total != incoming+outgoing and total == incoming+cached+written+outgoing:
            values['input_tokens'] = incoming+cached+written
    if incoming==0 and outgoing==0 and total and total>0:
        return dict(input=0,output=0,total=total,cached=cached,reasoning=raw.get('reasoning_output_tokens'))
    result = normalize(values)
    if result and ((cached > (result['input'] or 0)) or (raw.get('reasoning_output_tokens',0) > (result['output'] or 0))):
        result['cached'] = cached; result['reasoning'] = raw.get('reasoning_output_tokens',0)
    return result


def difference(current, previous):
    if not previous or any(current[k] is None or previous[k] is None or current[k] < previous[k] for k in ('input','output','total')):
        return None
    return {k: current[k]-previous[k] if current[k] is not None and previous[k] is not None and current[k]>=previous[k] else None for k in FIELDS}


def roots_for(root):
    root = Path(root).resolve()
    if not root.is_dir():
        raise ValueError('Codex sessions 目录不存在')
    roots = [root]
    if root.name in ('sessions', 'archived_sessions'):
        sibling = root.parent/('archived_sessions' if root.name == 'sessions' else 'sessions')
        if sibling.is_dir() and sibling.resolve().parent == root.parent:
            roots.append(sibling.resolve())
    return roots


def read_file(path, cursor, normalize, stamp):
    state = json.loads(cursor['state']) if cursor else {}
    offset = cursor['offset'] if cursor else 0
    stat = path.stat()
    if state.get('scannerVersion') == VERSION and stat.st_size == offset and stat.st_mtime_ns == state.get('mtime'):
        return None
    digest = hashlib.sha256()
    observations = []
    with path.open('rb') as stream:
        if state.get('scannerVersion') == VERSION and offset <= stat.st_size:
            remaining = offset
            while remaining:
                chunk = stream.read(min(1024*1024, remaining))
                if not chunk:
                    break
                digest.update(chunk); remaining -= len(chunk)
            if remaining or digest.hexdigest() != state.get('digest'):
                state = {}; offset = 0; digest = hashlib.sha256()
        else:
            state = {}; offset = 0
        stream.seek(offset)
        while stream.tell() < stat.st_size:
            start = stream.tell(); before = digest.copy()
            line = stream.readline(min(8*1024*1024, stat.st_size-start))
            digest.update(line)
            if not line.endswith(b'\n'):
                if len(line) >= 8*1024*1024:
                    try:
                        header = json.loads(re.split(br'"payload"\s*:', line, maxsplit=1)[0]+b'"payload":null}')
                    except (ValueError, UnicodeError):
                        header = {}
                    if header.get('type') != 'response_item':
                        raise ValueError('单条用量或元数据记录超过 8 MB')
                    while line and not line.endswith(b'\n') and stream.tell() < stat.st_size:
                        line = stream.readline(min(1024*1024, stat.st_size-stream.tell())); digest.update(line)
                    if line.endswith(b'\n'):
                        continue
                stream.seek(start); digest = before; break
            try:
                record = json.loads(line)
            except (ValueError, UnicodeError):
                if b'"token_count"' in line[:500]:
                    raise ValueError('用量记录 JSON 损坏')
                continue
            if not isinstance(record, dict):
                continue
            payload = record.get('payload') or {}
            if not isinstance(payload, dict):
                continue
            if record.get('type') == 'session_meta':
                state.update(session=str(payload.get('id') or payload.get('session_id') or ''),
                    provider=str(payload.get('model_provider') or '未标注'), project=str(payload.get('cwd') or ''))
                state['lineage']={}
                if payload.get('forked_from_id') and payload.get('timestamp'):
                    try:
                        if datetime.fromisoformat(str(payload['timestamp']).replace('Z','+00:00')).tzinfo:
                            state['lineage']=dict(parent=str(payload['forked_from_id']),before=stamp(payload['timestamp']))
                    except (ValueError,TypeError,OverflowError):pass
            elif record.get('type') == 'turn_context':
                state['model'] = str(payload.get('model') or '未识别模型')
            elif record.get('type') == 'event_msg' and payload.get('type') == 'token_count':
                info = payload.get('info') or {}
                if not isinstance(info, dict):
                    raise ValueError('用量信息结构不正确')
                current = decode(info.get('total_token_usage'), normalize)
                if current is None or current['total'] is None:
                    continue
                previous = state.get('counts'); state['counts'] = current
                response = payload.get('response_id') or info.get('response_id') or record.get('response_id')
                if previous == current and not response:
                    continue
                last_raw = info.get('last_token_usage')
                last = decode(last_raw, normalize)
                context = bool(last and last['input'] == 0 and last['output'] == 0 and (last['total'] or 0) > 0)
                delta = difference(current, previous)
                baseline = difference(current, last) if real(last) else None
                usage = last if real(last) else delta if last_raw is None and real(delta) else None
                reason = 'verified' if usage else 'empty_snapshot' if current['total']==0 else 'context_estimate' if context else 'unverifiable_usage'
                if context:
                    usage = None
                elif real(last) and delta != last and baseline and any(baseline.values()):
                    reason = 'history_gap'
                elif real(last) and delta != last and baseline is None:
                    reason = 'counter_mismatch'
                at = ''
                try:
                    raw_time = record.get('timestamp')
                    if not raw_time or not datetime.fromisoformat(str(raw_time).replace('Z', '+00:00')).tzinfo:
                        raise ValueError()
                    at = stamp(raw_time)
                except (ValueError, TypeError, OverflowError):
                    reason = 'missing_timestamp'; usage = None
                session = state.get('session')
                model = state.get('model')
                if not session:
                    reason = 'missing_session'; usage = None
                elif model in (None, '', '未识别模型', '未标注'):
                    reason = 'missing_model'; usage = None
                identity = [session, 'response', str(response)] if response else [session, at or record.get('timestamp'), identity_counts(current), identity_counts(last)]
                identity = 'codex:v4:'+('r:' if response else 's:')+hashlib.sha256(encode(identity).encode()).hexdigest()
                observations.append(dict(id=identity, session=session or '', at=at, provider=state.get('provider', '未标注'),
                    model=model or '未识别模型', cumulative=current, last_usage=last, usage=usage, baseline=baseline,
                    reason=reason, verified=int(usage is not None), project=state.get('project', ''),
                    lineage=state.get('lineage',{}),
                    raw={kind:{k:v for k,v in (info.get(kind) or {}).items() if k in ('input_tokens','output_tokens','cached_input_tokens','cache_write_input_tokens','reasoning_output_tokens','total_tokens')}
                        for kind in ('total_token_usage','last_token_usage') if isinstance(info.get(kind),dict)}))
        offset = stream.tell()
        state.update(scannerVersion=VERSION, digest=digest.hexdigest(), mtime=stat.st_mtime_ns)
    return dict(path=str(path), offset=offset, state=state, observations=observations)


def retire(db, owner, rows, reason, stamp):
    for row in rows:
        db.execute('INSERT OR IGNORE INTO codex_retired VALUES(?,?,?,?,?)',
            (owner, row['id'], encode(dict(row)), reason, stamp()))
        db.execute('DELETE FROM events WHERE owner=? AND id=?', (owner, row['id']))


def scan(monitor, owner, root):
    from workbench.ai_monitor import tokens, iso
    monitor.initialize(); roots = list({p for item in (root if isinstance(root,(list,tuple)) else [root]) for p in roots_for(item)})
    files = sorted({p.resolve() for directory in roots for p in directory.rglob('*.jsonl')
        if p.resolve().is_relative_to(directory) and p.is_file()})
    with monitor.db() as db:
        version = db.execute('SELECT version FROM codex_meta WHERE owner=?', (owner,)).fetchone()
        old = [dict(r) for r in db.execute("SELECT * FROM events WHERE owner=? AND source='codex' AND id LIKE 'codex:%'", (owner,))] if not version else []
        cursors = {r['path']:dict(r) for r in db.execute('SELECT * FROM cursors WHERE owner=?', (owner,))}
    rebuilding = bool(old)
    parsed = []; errors = []; failed = []; pending = 0
    for path in files:
        try:
            cursor = None if rebuilding else cursors.get(str(path))
            if not rebuilding and len(parsed) >= SCAN_LIMIT:
                state = json.loads(cursor['state']) if cursor else {}
                stat = path.stat()
                if not cursor or cursor['offset'] != stat.st_size or state.get('mtime') != stat.st_mtime_ns:
                    pending += 1
                continue
            item = read_file(path, cursor, tokens, iso)
            if item:
                parsed.append(item)
        except (OSError, ValueError) as error:
            errors.append(dict(file=path.name, error=str(error)[:160]))
            failed.append((owner,str(path),str(error)[:160]))
    if rebuilding and errors:
        with monitor.db() as db:
            db.executemany('INSERT OR REPLACE INTO codex_reads VALUES(?,?,?)',failed)
        return dict(imported=0, corrected=0, scanned=len(parsed), files=len(files), errors=errors, truncated=bool(pending), syncedAt=iso())
    backup = ''
    if rebuilding:
        target = monitor.path.with_name('ai-monitor.pre-v4.sqlite')
        if not target.exists():
            with monitor.db() as source, closing(sqlite3.connect(target)) as destination:
                source.backup(destination)
        backup = str(target)
    added = 0; corrected = 0; old_points = {(r['session'], r['at']) for r in old}
    with monitor.lock, monitor.db() as db:
        db.execute('BEGIN IMMEDIATE')
        evidence_pool=[dict(r) for r in db.execute('SELECT session,at,cumulative,last_usage,lineage FROM codex_evidence WHERE owner=?',(owner,))] if parsed else []
        evidence_pool.extend(dict(session=e['session'],at=e['at'],cumulative=encode(e['cumulative']),last_usage=encode(e['last_usage']),lineage=encode(e['lineage'])) for item in parsed for e in item['observations'])
        inherited={};ancestors={}
        for e in evidence_pool:
            inherited.setdefault((e['session'],e['cumulative'],e['last_usage']),[]).append(e['at'])
            relation=json.loads(e['lineage'])
            if relation:ancestors[e['session']]=relation
        def shared(e):
            relation=e['lineage'];seen={e['session']}
            while relation and relation['parent'] not in seen:
                parent=relation['parent'];seen.add(parent)
                if any(at and at<=relation['before'] for at in inherited.get((parent,encode(e['cumulative']),encode(e['last_usage'])),[])):return True
                relation=ancestors.get(parent)
            return False
        if rebuilding:
            retire(db, owner, old, 'recomputed_v4', iso); corrected = len(old)
        for item in parsed:
            db.execute('DELETE FROM codex_reads WHERE owner=? AND path=?',(owner,item['path']))
            for evidence in item['observations']:
                if shared(evidence):
                    evidence.update(usage=None,verified=0,reason='inherited_copy')
                    rows=db.execute('SELECT * FROM events WHERE owner=? AND id=?',(owner,evidence['id'])).fetchall()
                    retire(db,owner,rows,'inherited_copy',iso)
                existing = db.execute('SELECT * FROM codex_evidence WHERE owner=? AND id=?', (owner, evidence['id'])).fetchone()
                if existing and existing['verified'] and evidence['verified']:
                    if existing['usage'] != encode(evidence['usage']) or existing['model'] != evidence['model']:
                        evidence.update(usage=None, verified=0, reason='conflicting_evidence')
                        rows = db.execute('SELECT * FROM events WHERE owner=? AND id=?', (owner, evidence['id'])).fetchall()
                        retire(db, owner, rows, 'conflicting_evidence', iso)
                    else:
                        db.execute('INSERT OR IGNORE INTO codex_links VALUES(?,?,?)', (owner, item['path'], evidence['id']))
                        continue
                elif existing and evidence['reason']!='inherited_copy' and (existing['verified'] or existing['reason'] in ('conflicting_evidence','conflicting_snapshot')):
                    db.execute('INSERT OR IGNORE INTO codex_links VALUES(?,?,?)', (owner, item['path'], evidence['id']))
                    continue
                if evidence['id'].startswith('codex:v4:s:') and evidence['verified'] and evidence['at']:
                    candidates = db.execute("SELECT id,cumulative,last_usage FROM codex_evidence WHERE owner=? AND session=? AND at=? AND id<>? AND id LIKE 'codex:v4:s:%' AND (verified=1 OR reason='conflicting_snapshot')",
                        (owner, evidence['session'], evidence['at'], evidence['id'])).fetchall()
                    end=evidence['cumulative']['total'];start=end-evidence['usage']['total']
                    conflicts=[c for c in candidates if (old:=json.loads(c['last_usage'])) and max(start,json.loads(c['cumulative'])['total']-old['total'])<min(end,json.loads(c['cumulative'])['total'])]
                    for conflict in conflicts:
                        rows = db.execute('SELECT * FROM events WHERE owner=? AND id=?', (owner, conflict['id'])).fetchall()
                        retire(db, owner, rows, 'conflicting_snapshot', iso)
                        db.execute("UPDATE codex_evidence SET verified=0,reason='conflicting_snapshot' WHERE owner=? AND id=?", (owner, conflict['id']))
                    if conflicts:
                        evidence.update(usage=None, verified=0, reason='conflicting_snapshot')
                columns=('id','session','at','provider','model','cumulative','last_usage','usage','baseline','reason','verified','raw','lineage')
                values = [owner]+[encode(evidence[k]) if k in ('cumulative','last_usage','usage','baseline','raw','lineage') else evidence[k] for k in columns]
                db.execute('INSERT OR REPLACE INTO codex_evidence VALUES('+','.join('?' for _ in values)+')', values)
                db.execute('INSERT OR IGNORE INTO codex_links VALUES(?,?,?)', (owner, item['path'], evidence['id']))
                if evidence['verified']:
                    inserted = monitor.record(owner, evidence['usage'], _db=db, id=evidence['id'], at=evidence['at'],
                        source='codex', agent='Codex', provider=evidence['provider'], model=evidence['model'],
                        session=evidence['session'], project=evidence['project'], auth_mode='unconfirmed')
                    added += inserted if not rebuilding or (evidence['session'], evidence['at']) not in old_points else 0
            db.execute('INSERT OR REPLACE INTO cursors VALUES(?,?,?,?)',
                (owner, item['path'], item['offset'], encode(item['state'])))
        db.executemany('INSERT OR REPLACE INTO codex_reads VALUES(?,?,?)',failed)
        if parsed:
            for prior in db.execute("SELECT * FROM codex_evidence WHERE owner=? AND lineage<>'{}' AND reason<>'inherited_copy'",(owner,)).fetchall():
                e={k:json.loads(prior[k]) if k in ('cumulative','last_usage','lineage') else prior[k] for k in ('id','session','cumulative','last_usage','lineage')}
                if shared(e):
                    rows=db.execute('SELECT * FROM events WHERE owner=? AND id=?',(owner,e['id'])).fetchall()
                    retire(db,owner,rows,'inherited_copy',iso);corrected+=len(rows)
                    db.execute("UPDATE codex_evidence SET usage='null',verified=0,reason='inherited_copy' WHERE owner=? AND id=?",(owner,e['id']))
        db.execute('INSERT OR REPLACE INTO codex_meta VALUES(?,?)', (owner, VERSION))
    return dict(imported=added, corrected=corrected, updated=corrected, scanned=len(parsed), files=len(files),
        errors=errors, truncated=bool(pending), backup=backup, syncedAt=iso())


def coverage(monitor, owner):
    with monitor.db() as db:
        rows = [dict(r) for r in db.execute('SELECT session,cumulative,baseline,reason FROM codex_evidence WHERE owner=?', (owner,))]
        retired = db.execute("SELECT COUNT(*) FROM codex_retired WHERE owner=? AND reason='recomputed_v4' AND json_extract(record,'$.session') NOT IN (SELECT session FROM codex_evidence WHERE owner=?)", (owner, owner)).fetchone()[0]
        pending = db.execute("SELECT COUNT(*) FROM events WHERE owner=? AND source='codex' AND id LIKE 'codex:%' AND id NOT LIKE 'codex:v4:%'",(owner,)).fetchone()[0]
        failed = db.execute('SELECT COUNT(*) FROM codex_reads WHERE owner=?',(owner,)).fetchone()[0]
    known = {(r['session'], r['cumulative']) for r in rows}
    issues = {}
    for row in rows:
        reason = row['reason']
        if reason == 'history_gap' and (row['session'], row['baseline']) in known:
            continue
        if reason not in ('verified', 'context_estimate', 'empty_snapshot','inherited_copy'):
            issues[reason] = issues.get(reason, 0)+1
    if retired:
        issues['unverifiable_legacy'] = retired
    if pending:
        issues['pending_migration'] = pending
    if failed:
        issues['unreadable_sources'] = failed
    return dict(version=VERSION, incomplete=bool(issues), issues=issues,
        message='历史记录不完整，仅统计已核验用量' if issues else '')


def visible(row):
    return not (row['source']=='codex' and row['id'].startswith('codex:') and not row['id'].startswith('codex:v4:'))
