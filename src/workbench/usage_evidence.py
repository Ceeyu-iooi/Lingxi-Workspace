"""Minimal, credential-free consumption evidence shared by local adapters."""
import hashlib
import json
from collections import Counter
from datetime import datetime, timezone

VERSION = 'usage-v18'


def migrate_codex_details(db,normalize):
    """Reconcile saved raw evidence before changing counters; preserve v4 identities."""
    db.execute('CREATE TABLE IF NOT EXISTS usage_migrations(name TEXT PRIMARY KEY,at TEXT)')
    if db.execute('SELECT 1 FROM usage_migrations WHERE name=?',(VERSION,)).fetchone():return
    from workbench.codex_ledger import decode,real,difference
    for row in db.execute('SELECT * FROM codex_evidence WHERE verified=1').fetchall():
        try:
            raw=json.loads(row['raw']);previous=json.loads(row['usage'])
            current=decode(raw.get('total_token_usage'),normalize);last=decode(raw.get('last_token_usage'),normalize)
            counts=last if real(last) else dict(previous,cached=None,reasoning=None)
            if not real(counts) or any(counts[k]!=previous[k] for k in ('input','output','total')):raise ValueError()
            baseline=difference(current,last) if current and real(last) else json.loads(row['baseline'])
            db.execute('UPDATE codex_evidence SET usage=?,cumulative=?,last_usage=?,baseline=? WHERE owner=? AND id=?',
                (encode(counts),encode(current),encode(last),encode(baseline),row['owner'],row['id']))
            db.execute('UPDATE events SET cached=?,reasoning=? WHERE owner=? AND id=?',(counts['cached'],counts['reasoning'],row['owner'],row['id']))
        except (ValueError,TypeError,KeyError):
            event=db.execute('SELECT * FROM events WHERE owner=? AND id=?',(row['owner'],row['id'])).fetchone()
            if event:db.execute('INSERT OR REPLACE INTO codex_retired VALUES(?,?,?,?,?)',(row['owner'],row['id'],encode(dict(event)),'v18_migration_unverified',datetime.now(timezone.utc).isoformat()))
            db.execute('DELETE FROM events WHERE owner=? AND id=?',(row['owner'],row['id']))
            db.execute("UPDATE codex_evidence SET verified=0,reason='migration_unverified_usage' WHERE owner=? AND id=?",(row['owner'],row['id']))
    db.execute('INSERT INTO usage_migrations VALUES(?,?)',(VERSION,datetime.now(timezone.utc).isoformat()))


def encode(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'))


def setup(db):
    db.execute('''CREATE TABLE IF NOT EXISTS agent_evidence(
        owner TEXT,id TEXT,source TEXT,raw TEXT,digest TEXT,version TEXT,
        verified INTEGER,reason TEXT,PRIMARY KEY(owner,id))''')
    db.execute('CREATE TABLE IF NOT EXISTS agent_reads(owner TEXT,source TEXT,path TEXT,state TEXT,PRIMARY KEY(owner,source,path))')
    db.execute('CREATE TABLE IF NOT EXISTS agent_retired(owner TEXT,id TEXT,record TEXT,reason TEXT,PRIMARY KEY(owner,id))')
    db.execute('CREATE TABLE IF NOT EXISTS usage_versions(owner TEXT PRIMARY KEY,version INTEGER NOT NULL DEFAULT 0)')
    db.execute('CREATE INDEX IF NOT EXISTS agent_evidence_scope ON agent_evidence(owner,source,verified,reason)')
    for table in ('agent_evidence','agent_reads','codex_evidence','codex_reads'):
        for operation,prefix in (('INSERT','NEW'),('UPDATE','NEW'),('DELETE','OLD')):
            db.execute('CREATE TRIGGER IF NOT EXISTS version_'+table+'_'+operation+' AFTER '+operation+' ON '+table+' BEGIN INSERT INTO usage_versions VALUES('+prefix+'.owner,1) ON CONFLICT(owner) DO UPDATE SET version=version+1; END')
    db.execute('''CREATE TRIGGER IF NOT EXISTS usage_event_insert AFTER INSERT ON events BEGIN
        INSERT INTO usage_versions VALUES(NEW.owner,1) ON CONFLICT(owner) DO UPDATE SET version=version+1; END''')
    db.execute('''CREATE TRIGGER IF NOT EXISTS usage_event_update AFTER UPDATE ON events BEGIN
        INSERT INTO usage_versions VALUES(NEW.owner,1) ON CONFLICT(owner) DO UPDATE SET version=version+1; END''')
    db.execute('''CREATE TRIGGER IF NOT EXISTS usage_event_delete AFTER DELETE ON events BEGIN
        INSERT INTO usage_versions VALUES(OLD.owner,1) ON CONFLICT(owner) DO UPDATE SET version=version+1; END''')


def store(monitor, owner, source, records, reads=(), retire_legacy=True):
    """Commit evidence, rows, corrections and progress together. Never erase missing logs."""
    monitor.initialize()
    added = updated = 0
    with monitor.lock, monitor.db() as db:
        db.execute('BEGIN IMMEDIATE')
        if retire_legacy:
            legacy = db.execute('''SELECT * FROM events WHERE owner=? AND source=?
                AND id NOT IN (SELECT id FROM agent_evidence WHERE owner=?)''', (owner,source,owner)).fetchall()
            for row in legacy:
                db.execute('INSERT OR IGNORE INTO agent_retired VALUES(?,?,?,?)', (owner,row['id'],encode(dict(row)),'unverified_legacy'))
                db.execute('DELETE FROM events WHERE owner=? AND id=?',(owner,row['id']))
        for record in records:
            raw = record['evidence']; serialized = encode(raw)
            reason = record.get('reason','verified'); verified = reason == 'verified'
            ident = record['id']
            prior = db.execute('SELECT * FROM agent_evidence WHERE owner=? AND id=?',(owner,ident)).fetchone()
            if prior and source=='zcode' and json.loads(prior['raw']).get('origin')=='database' and raw.get('origin')!='database':continue
            if prior and prior['raw'] == serialized and prior['reason'] == reason:continue
            old = db.execute('SELECT * FROM events WHERE owner=? AND id=?',(owner,ident)).fetchone()
            if old:
                db.execute('INSERT OR REPLACE INTO agent_retired VALUES(?,?,?,?)',(owner,ident,encode(dict(old)),'corrected_evidence'))
                db.execute('DELETE FROM events WHERE owner=? AND id=?',(owner,ident)); updated += 1
            db.execute('INSERT OR REPLACE INTO agent_evidence VALUES(?,?,?,?,?,?,?,?)',
                (owner,ident,source,serialized,hashlib.sha256(serialized.encode()).hexdigest(),VERSION,int(verified),reason))
            if verified:
                meta={k:v for k,v in record.items() if k not in ('evidence','reason','usage')}
                added += monitor.record(owner,record['usage'],_db=db,**meta) if not old else 0
                if old:monitor.record(owner,record['usage'],_db=db,**meta)
        for path,state in reads:
            db.execute('INSERT OR REPLACE INTO agent_reads VALUES(?,?,?,?)',(owner,source,str(path),encode(state)))
    return added,updated


def coverage(monitor,owner,source):
    with monitor.db() as db:
        reasons=Counter({r[0]:r[1] for r in db.execute('SELECT reason,count(*) FROM agent_evidence WHERE owner=? AND source=? GROUP BY reason',(owner,source))})
        reads=[json.loads(r[0]) for r in db.execute('SELECT state FROM agent_reads WHERE owner=? AND source=?',(owner,source))]
        legacy=db.execute('SELECT count(*) FROM agent_retired WHERE owner=? AND reason=? AND json_extract(record,\'$.source\')=? AND id NOT IN (SELECT id FROM agent_evidence WHERE owner=? AND verified=1)',(owner,'unverified_legacy',source,owner)).fetchone()[0]
        legacy+=db.execute('SELECT count(*) FROM events WHERE owner=? AND source=? AND id NOT IN (SELECT id FROM agent_evidence WHERE owner=? AND verified=1)',(owner,source,owner)).fetchone()[0]
    errors=sum(bool(r.get('error')) for r in reads)
    return dict(incomplete=bool(errors or legacy or any(k!='verified' and v for k,v in reasons.items())),
        reasons=dict(reasons),readErrors=errors,unverifiedLegacy=legacy,
        message='仅统计已核验的本机消费证据；缺失与冲突记录未补数',source=source,parserVersion=VERSION)
