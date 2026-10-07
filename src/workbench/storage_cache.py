"""Lossless content-addressed evidence and byte-budgeted response cache."""
import hashlib
import json
import time
import zlib
from collections import OrderedDict

LIMIT = 4 * 1024 * 1024
PREFIX = '@blob:'

def setup(db):
    db.execute('CREATE TABLE IF NOT EXISTS evidence_blobs(digest TEXT PRIMARY KEY,codec TEXT NOT NULL,raw_size INTEGER NOT NULL,body BLOB NOT NULL)')

def store(db, text):
    raw = text.encode('utf-8')
    if len(raw) > LIMIT:
        raise ValueError('证据超过保存限制')
    digest = hashlib.sha256(raw).hexdigest()
    db.execute('INSERT OR IGNORE INTO evidence_blobs VALUES(?,?,?,?)', (digest, 'zlib', len(raw), zlib.compress(raw, 6)))
    return PREFIX + digest

def read(db, value, memo=None):
    if not value.startswith(PREFIX):
        return value
    if memo is not None and value in memo:return memo[value]
    digest = value[len(PREFIX):]
    row = db.execute('SELECT codec,raw_size,body FROM evidence_blobs WHERE digest=?', (digest,)).fetchone()
    if row is None or row[0] != 'zlib' or not 0 <= row[1] <= LIMIT:
        raise ValueError('压缩证据不存在或结构错误')
    decoder = zlib.decompressobj()
    try:
        raw = decoder.decompress(row[2], row[1] + 1)
    except zlib.error:
        raise ValueError('压缩证据损坏') from None
    if len(raw) != row[1] or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail or hashlib.sha256(raw).hexdigest() != digest:
        raise ValueError('压缩证据摘要校验失败')
    text=raw.decode('utf-8')
    if memo is not None:memo[value]=text
    return text

def compact(db, result):
    value = {key: result.get(key) for key in ('cost','currency','valueReason','valueParts','valueVersion')}
    value['_proof'] = store(db, json.dumps(result.get('valueProof', {}), ensure_ascii=False, separators=(',',':')))
    return json.dumps(value, ensure_ascii=False, separators=(',',':'))

def expand(db, text, row, memo=None):
    value = json.loads(text)
    if '_proof' in value:
        value['valueProof'] = json.loads(read(db, value.pop('_proof'),memo))
    # Old full-row results remain readable, but current consumption is canonical.
    return {**value, **row, **{k:v for k,v in value.items() if k in ('cost','currency','valueReason','valueProof','valueParts','valueVersion')}}

def migrate(monitor, batch=24):
    """Idempotent, short transactions. Never discard original evidence."""
    with monitor.db() as db:
        setup(db)
    for table, keys, column in [('radar_days', ('day',), 'body'), ('radar_observations', ('url','digest'), 'body')]:
        while True:
            with monitor.db() as db:
                rows = db.execute(f"SELECT * FROM {table} WHERE body NOT LIKE '@blob:%' LIMIT ?", (batch,)).fetchall()
                if not rows:
                    break
                for row in rows:
                    ref = store(db, row[column])
                    if hashlib.sha256(read(db, ref).encode()).hexdigest() != row['digest']:
                        raise ValueError('原始价格证据摘要不一致，停止迁移')
                    db.execute(f"UPDATE {table} SET body=? WHERE " + ' AND '.join(k+'=?' for k in keys), (ref, *(row[k] for k in keys)))
            time.sleep(.005)
    while True:
        with monitor.db() as db:
            rows = db.execute("SELECT * FROM radar_values WHERE json_extract(result,'$._proof') IS NULL LIMIT ?", (batch*8,)).fetchall()
            if not rows:
                break
            for row in rows:
                db.execute('UPDATE radar_values SET result=? WHERE owner=? AND id=? AND currency=?', (compact(db,json.loads(row['result'])),row['owner'],row['id'],row['currency']))
        time.sleep(.005)

class ByteLRU(OrderedDict):
    def __init__(self, budget=32*1024*1024):
        super().__init__(); self.budget=budget; self.bytes=0
    def get(self,key,default=None):
        if key not in self:return default
        self.move_to_end(key);return super().__getitem__(key)
    def __setitem__(self,key,value):
        size=len(value.encode('utf-8'))
        if key in self:self.pop(key)
        if size>self.budget:return
        super().__setitem__(key,value);self.bytes+=size
        while self.bytes>self.budget:self.pop(next(iter(self)))
    def pop(self,key,*default):
        if key not in self:return super().pop(key,*default)
        value=super().pop(key);self.bytes-=len(value.encode('utf-8'));return value
    def clear(self):
        super().clear();self.bytes=0
