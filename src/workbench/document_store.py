"""Local document database with versioned migrations and recoverable JSON mirrors.

Adapted architecture: ZCode keeps durable indexes in SQLite and portable content
on disk. This store uses account namespaces rather than coding workspace IDs.
"""
from contextlib import closing, contextmanager
from pathlib import Path
import hashlib
import json
import os
import sqlite3
import threading
import time


class DocumentStore:
    def __init__(self, data):
        self.data = Path(data).resolve()
        self.path = self.data / 'storage' / 'workbench.sqlite'
        self.lock = threading.RLock()
        self.ready = False

    @contextmanager
    def connect(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.path, timeout=15)) as db:
            db.row_factory = sqlite3.Row
            db.execute('PRAGMA busy_timeout=15000')
            db.execute('PRAGMA foreign_keys=ON')
            with db:
                yield db

    def initialize(self):
        with self.lock:
            if self.ready:
                return
            with self.connect() as db:
                db.execute('PRAGMA journal_mode=WAL')
                version = db.execute('PRAGMA user_version').fetchone()[0]
                if version > 2:
                    raise RuntimeError('数据存储版本高于当前应用版本')
                db.execute('''CREATE TABLE IF NOT EXISTS documents (
                    namespace TEXT NOT NULL, entity TEXT NOT NULL,
                    payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
                    content_hash TEXT NOT NULL, updated_at INTEGER NOT NULL,
                    PRIMARY KEY(namespace,entity))''')
                db.execute('CREATE INDEX IF NOT EXISTS documents_updated ON documents(namespace,updated_at DESC)')
                db.execute('PRAGMA user_version=2')
            self.ready = True

    def namespace(self, path):
        relative = Path(path).resolve().relative_to(self.data)
        return relative.parent.as_posix()

    @staticmethod
    def encode(value):
        return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)

    def _put(self, db, namespace, entity, value):
        payload = self.encode(value)
        digest = hashlib.sha256(payload.encode()).hexdigest()
        db.execute('''INSERT INTO documents(namespace,entity,payload,content_hash,updated_at)
            VALUES(?,?,?,?,?) ON CONFLICT(namespace,entity) DO UPDATE SET
            payload=excluded.payload,content_hash=excluded.content_hash,
            revision=documents.revision+1,updated_at=excluded.updated_at
            WHERE documents.content_hash != excluded.content_hash''',
            (namespace, entity, payload, digest, time.time_ns()))

    def read(self, path, default):
        self.initialize()
        path = Path(path)
        namespace, entity = self.namespace(path), path.stem
        with self.lock, self.connect() as db:
            row = db.execute('SELECT * FROM documents WHERE namespace=? AND entity=?', (namespace, entity)).fetchone()
            if path.exists():
                try:
                    value = json.loads(path.read_text(encoding='utf-8'))
                    digest = hashlib.sha256(self.encode(value).encode()).hexdigest()
                    if not row or row['content_hash'] != digest:
                        self._put(db, namespace, entity, value)
                    return value
                except (json.JSONDecodeError, UnicodeDecodeError):
                    quarantine = path.with_name(f'{entity}.corrupt-{time.time_ns()}.json')
                    os.replace(path, quarantine)
                    if row:
                        value = json.loads(row['payload'])
                        self.mirror(path, value)
                        return value
                    return default
            if row:
                return json.loads(row['payload'])
            return default

    @staticmethod
    def mirror(path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix('.tmp')
        temp.write_text(json.dumps(value, ensure_ascii=False, indent=1, allow_nan=False), encoding='utf-8')
        os.replace(temp, path)

    def write(self, path, value):
        self.initialize()
        path = Path(path)
        with self.lock, self.connect() as db:
            self._put(db, self.namespace(path), path.stem, value)
            self.mirror(path, value)

    def write_many(self, items):
        """Import/restore all entities in one transaction, restoring mirrors on failure."""
        self.initialize()
        clean = [(Path(path), value) for path, value in items]
        for path, value in clean:
            self.namespace(path)
            self.encode(value)
        with self.lock:
            original = {path: path.read_bytes() if path.exists() else None for path, _ in clean}
            changed = []
            try:
                with self.connect() as db:
                    for path, value in clean:
                        self._put(db, self.namespace(path), path.stem, value)
                    for path, value in clean:
                        self.mirror(path, value)
                        changed.append(path)
            except Exception:
                for path in changed:
                    if original[path] is None:
                        path.unlink(missing_ok=True)
                    else:
                        path.write_bytes(original[path])
                raise

    def snapshot(self):
        self.initialize()
        with self.lock, self.connect() as db:
            return [(f"{row['namespace']}/{row['entity']}.json".removeprefix('./'), row['payload'])
                    for row in db.execute('SELECT namespace,entity,payload FROM documents ORDER BY namespace,entity')]

    def info(self):
        self.initialize()
        with self.connect() as db:
            return {'engine':'SQLite', 'schemaVersion':db.execute('PRAGMA user_version').fetchone()[0],
                    'journalMode':db.execute('PRAGMA journal_mode').fetchone()[0],
                    'documents':db.execute('SELECT COUNT(*) FROM documents').fetchone()[0]}

    def relocate(self, source, target):
        self.initialize()
        source, target = Path(source), Path(target)
        with self.lock, self.connect() as db:
            value = json.loads(target.read_text(encoding='utf-8'))
            self._put(db, self.namespace(target), target.stem, value)
            db.execute('DELETE FROM documents WHERE namespace=? AND entity=?', (self.namespace(source), source.stem))
