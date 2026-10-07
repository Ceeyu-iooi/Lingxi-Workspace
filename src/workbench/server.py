#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""个人总控台本地服务（v1.1：多账号登录 + AI 待办识别）。

仅使用 Python 标准库。账号存 SQLite（PBKDF2 密码哈希），
各账号业务数据隔离在 data/users/<用户名>/ 下的 JSON 文件，
每次写入后自动生成滚动 zip 快照到 backups/（保留最近 10 份）。
AI 识别默认本地解析引擎；可选配置外部 AI API（Key 仅存服务端 data/secrets.json，
不进前端、不进备份与导出信封）。
"""
from __future__ import annotations

import hashlib
import hmac
import base64
import binascii
import csv
import io
import json
import os
import re
import shutil
import sqlite3
import sys
from pathlib import Path as _BootstrapPath
_runtime_dependencies = _BootstrapPath(__file__).resolve().parents[2] / '.runtime/deps'
if _runtime_dependencies.is_dir():sys.path.insert(0,str(_runtime_dependencies))

if '--profile-maintenance' in sys.argv:
    from workbench.profile_store import main as profile_main
    raise SystemExit(profile_main(sys.argv[sys.argv.index('--profile-maintenance') + 1:]))
if '--desktop-check' in sys.argv:
    import ssl as desktop_ssl
    import sqlite3 as desktop_sqlite
    import zstandard as desktop_zstd
    import yaml as desktop_yaml
    from PIL import __version__ as desktop_pillow
    print(json.dumps({'zstandard': desktop_zstd.__version__, 'sqlite': desktop_sqlite.sqlite_version,
                      'ssl': desktop_ssl.OPENSSL_VERSION, 'PyYAML':desktop_yaml.__version__,'Pillow':desktop_pillow,'frozen': bool(getattr(sys, 'frozen', False))}))
    raise SystemExit(0)
import threading
import time
import uuid
import zipfile
from contextlib import closing, contextmanager
import webbrowser
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from email.utils import parsedate_to_datetime
from http import cookies as http_cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib import request as urlrequest
from urllib.parse import urlparse, parse_qs, quote

from workbench import ai_parser
from workbench import bill_parser
from workbench.document_store import DocumentStore
from workbench.ai_monitor import AIMonitor
from workbench.ai_control import AIControl,validate_state
from workbench.usage_accounts import UsageAccounts
from workbench.usage_import import parse_file as parse_usage_file

from workbench.paths import project_root
BASE = project_root()
if os.environ.get('WORKBENCH_DESKTOP') != '1' and not os.environ.get('WORKBENCH_DATA'):
    from workbench.profile_store import web_layout,environment
    os.environ.update(environment(web_layout(BASE)))
PROFILE_ROOT = Path(os.environ.get('WORKBENCH_PROFILE', str(BASE))).resolve()
WORKSPACE = Path(os.environ.get("WORKBENCH_WORKSPACE", str(PROFILE_ROOT/'workspace'))).resolve()
DATA = Path(os.environ.get("WORKBENCH_DATA", str(BASE / "data"))).resolve()
USERS = DATA / "users"
BACKUPS = Path(os.environ.get("WORKBENCH_BACKUPS", str(BASE / "backups"))).resolve()
STATIC = BASE / "static"
DB = Path(os.environ.get("WORKBENCH_DB", str(BASE / "accounts.db")))
SECRETS = DATA / "secrets.json"
PORT = int(os.environ.get("WORKBENCH_PORT", "8765"))
HOST = os.environ.get("WORKBENCH_HOST", "0.0.0.0")
DESKTOP = os.environ.get('WORKBENCH_DESKTOP') == '1'
DESKTOP_INSTANCE = os.environ.get('WORKBENCH_INSTANCE', '') if DESKTOP else ''
from workbench.shared_runtime import ProfileLock, identity
PROFILE_LOCK = ProfileLock(DATA) if __name__ == '__main__' else None
SHARED_IDENTITY = identity(DATA)
DOCUMENTS = DocumentStore(DATA)
AI_MONITOR = AIMonitor(DATA)
AI_CONTROL = AIControl(DATA,DOCUMENTS,AI_MONITOR)
USAGE_ACCOUNTS = UsageAccounts(AI_MONITOR, AI_CONTROL)
from workbench.api_value import APIValue
from workbench.codex_sources import CodexSources
API_VALUE = APIValue(AI_MONITOR)
AI_MONITOR.value_reader = API_VALUE
AI_MONITOR.agent_value_enabled = os.environ.get('WORKBENCH_AGENT_VALUE_ENABLED','0')=='1'
RUNTIME_VERSION = (BASE/'VERSION').read_text(encoding='utf-8').strip()
RUNTIME_STARTED = datetime.now(timezone.utc).isoformat()
CODEX_SOURCES = CodexSources(AI_MONITOR)
from workbench.provider_relay import ProviderRelay
PROVIDER_RELAY = ProviderRelay(USAGE_ACCOUNTS)
AI_CONTROL.usage_response_hook = PROVIDER_RELAY.capture_agent

def usage_import_connection(owner, body, records):
    cid=body.get('connectionId')
    if not cid:return records
    row=next((r for r in USAGE_ACCOUNTS.list(owner)['connections'] if r['id']==cid),None)
    if not row or row['kind']!='deepseek':raise ValueError('请选择自己的 DeepSeek 用量账户')
    identity=row.get('providerId') or cid
    return [{**r,'connection_id':identity,'provider':row['name'],'source':'import','auth_mode':'api_key'} for r in records]

SCHEMA_VERSION = 2
BACKUP_KEEP = 10
NEWS_TTL = 30 * 60
NEWS_FAILURE_RETRY = 5 * 60
NEWS_FETCH_TIMEOUT = 6  # 单源超时秒数（源间并行，最坏约 6 秒）
NEWS_KEEP_DAYS = 7
SESSION_TTL = 30 * 86400
PBKDF2_ITERS = 120_000
AI_TIMEOUT = 20

USER_ENTITIES = ("projects", "tasks", "summaries", "activities", "settings", "transactions", "preferences", "control")
# news_cache 全局共享；secrets.json 永不进备份/导出
GLOBAL_ENTITIES = ("news_cache",)
BACKUP_SKIP = {"secrets.json"}

def validate_account_data(data):
    for name,value in data.items():
        if name=='avatar':continue
        if name not in USER_ENTITIES:raise ValueError('备份资料不支持')
        expected=dict if name in ('settings','preferences','control') else list
        if not isinstance(value,expected):raise ValueError('备份资料类型不正确')
        if name=='control':validate_state(value)

from workbench.workbench_services import Services,RETIRED
from workbench.prompt_store import Conflict
SERVICES = Services(DOCUMENTS,AI_CONTROL,AI_MONITOR,USAGE_ACCOUNTS,API_VALUE,WORKSPACE,BACKUPS,USER_ENTITIES,validate_account_data)

_lock = threading.RLock()

DEFAULT_SETTINGS = {
    "demo_seeded": False,
    "news_sources_version": 2,
    "news_sources": [
        {"id": "baidu", "name": "百度热搜", "ranking": True, "feeds": [
            "https://top.baidu.com/board?tab=realtime",
        ], "links": [
            {"name": "百度热搜", "url": "https://top.baidu.com/board?tab=realtime"},
            {"name": "微博热搜", "url": "https://s.weibo.com/top/summary?cate=realtime"},
            {"name": "知乎热榜", "url": "https://www.zhihu.com/hot"},
        ]},
        {"id": "bili", "name": "B站热门", "ranking": True, "feeds": [
            "https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1",
        ], "links": [
            {"name": "哔哩哔哩热门", "url": "https://www.bilibili.com/v/popular/all"},
        ]},
        {"id": "tech", "name": "科技资讯", "feeds": [
            "https://www.ifanr.com/feed",
            "https://www.ithome.com/rss/",
        ], "links": [
            {"name": "36氪", "url": "https://36kr.com/"},
            {"name": "爱范儿", "url": "https://www.ifanr.com/"},
            {"name": "少数派", "url": "https://sspai.com/"},
            {"name": "IT之家", "url": "https://www.ithome.com/"},
        ]},
        {"id": "world", "name": "新闻时事", "feeds": [
            "https://www.chinanews.com.cn/rss/scroll-news.xml",
            "https://www.chinanews.com.cn/rss/china.xml",
        ], "links": [
            {"name": "人民网", "url": "https://www.people.com.cn/"},
            {"name": "澎湃新闻", "url": "https://www.thepaper.cn/"},
            {"name": "央视新闻", "url": "https://news.cctv.com/"},
        ]},
        {"id": "study", "name": "教育升学", "feeds": [
            "https://www.chinanews.com.cn/rss/edu.xml",
        ], "links": [
            {"name": "研招网", "url": "https://yz.chsi.com.cn/"},
            {"name": "中国教育在线考研", "url": "https://kaoyan.eol.cn/"},
        ]},
    ],
}


# ---------------------------------------------------------------- 数据层

def uroot(username: str) -> Path:
    return USERS / username


def _entity_path(name: str, root: Path) -> Path:
    if name not in USER_ENTITIES + GLOBAL_ENTITIES:
        raise ValueError(f"unknown entity {name}")
    if name in GLOBAL_ENTITIES:
        return DATA / f"{name}.json"
    return root / f"{name}.json"


def read_entity(name: str, default, root: Path = DATA):
    path = _entity_path(name, root)
    return DOCUMENTS.read(path, default)


def write_entity(name: str, value, backup: bool = True, root: Path = DATA):
    path = _entity_path(name, root)
    DOCUMENTS.write(path, value)
    if backup:
        make_backup(reason="auto")


def log_activity(text: str, root: Path = DATA):
    acts = read_entity("activities", [], root=root)
    acts.insert(0, {"id": new_id(), "text": text, "at": now_iso()})
    write_entity("activities", acts[:200], backup=False, root=root)


def new_id() -> str:
    return f"{int(time.time() * 1000):x}-{os.urandom(3).hex()}"


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


# ---------------------------------------------------------------- 账号与会话

@contextmanager
def _db():
    with closing(sqlite3.connect(DB, timeout=15)) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA busy_timeout=15000')
        with conn:
            yield conn


def init_db():
    with _db() as conn:
        conn.execute('PRAGMA journal_mode=WAL')
        conn.execute("""CREATE TABLE IF NOT EXISTS users(
            id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,
            pass_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at TEXT NOT NULL)""")
        conn.execute("""CREATE TABLE IF NOT EXISTS sessions(
            token TEXT PRIMARY KEY, user_id TEXT NOT NULL,
            created_at TEXT NOT NULL, expires_at REAL NOT NULL)""")


def _hash_pw(password: str, salt: bytes) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERS).hex()


def user_count() -> int:
    with _db() as conn:
        return conn.execute("SELECT COUNT(*) c FROM users").fetchone()["c"]


def create_user(username: str, password: str) -> dict:
    salt = os.urandom(16)
    with _db() as conn:
        conn.execute("INSERT INTO users(id, username, pass_hash, salt, created_at) VALUES(?,?,?,?,?)",
                     (uuid.uuid4().hex, username, _hash_pw(password, salt), salt.hex(), now_iso()))
    return {"username": username}


def verify_user(username: str, password: str):
    with _db() as conn:
        row = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    if not row:
        return None
    if not hmac.compare_digest(row["pass_hash"], _hash_pw(password, bytes.fromhex(row["salt"]))):
        return None
    return {"username": row["username"]}


def create_session(username: str) -> str:
    token = os.urandom(32).hex()
    with _db() as conn:
        conn.execute("INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES(?,?,?,?)",
                     (token, username, now_iso(), time.time() + SESSION_TTL))
    return token


def resolve_session(token: str):
    if not token:
        return None
    with _db() as conn:
        row = conn.execute("SELECT * FROM sessions WHERE token=?", (token,)).fetchone()
    if not row or row["expires_at"] < time.time():
        return None
    return {"username": row["user_id"]}


def drop_session(token: str):
    with _db() as conn:
        conn.execute("DELETE FROM sessions WHERE token=?", (token,))


USERNAME_RE = re.compile(r"^[\w\u4e00-\u9fa5]{2,20}$")


def _migrate_legacy_data_to(username: str):
    """首个账号注册时，把旧版顶层数据迁入该账号命名空间（迁移前全局备份）。"""
    legacy = [n for n in USER_ENTITIES if (DATA / f"{n}.json").exists()]
    if not legacy:
        return []
    make_backup(reason="pre-migration")
    root = uroot(username)
    root.mkdir(parents=True, exist_ok=True)
    moved = []
    for n in legacy:
        shutil.move(str(DATA / f"{n}.json"), str(root / f"{n}.json"))
        DOCUMENTS.relocate(DATA / f'{n}.json', root / f'{n}.json')
        moved.append(n)
    return moved


# ---------------------------------------------------------------- 备份 / 恢复

def make_backup(reason: str = "manual") -> str:
    BACKUPS.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    path = BACKUPS / f"backup-{stamp}-{reason}.zip"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        meta = {
            "format": "personal-workbench-backup",
            "formatVersion": 1,
            "appId": "personal-command-center",
            "appVersion": "1.2.0",
            "schemaVersion": SCHEMA_VERSION,
            "exportedAt": now_iso(),
            "reason": reason,
        }
        zf.writestr("manifest.json", json.dumps(meta, ensure_ascii=False, indent=1))
        entries = {}
        if DATA.exists():
            for p in sorted(DATA.rglob("*.json")):
                if p.name in BACKUP_SKIP or '.corrupt-' in p.name:
                    continue
                entries[p.relative_to(DATA).as_posix()] = p.read_bytes()
        for relative, payload in DOCUMENTS.snapshot():
            entries[relative] = payload.encode('utf-8')
        for relative, payload in entries.items():
            zf.writestr('data/' + relative, payload)
    _prune_backups()
    return path.name


def _prune_backups():
    zips = sorted(BACKUPS.glob("backup-*.zip"))
    for old in zips[:-BACKUP_KEEP]:
        try:
            old.unlink()
        except OSError:
            pass


def list_backups():
    out = []
    for p in sorted(BACKUPS.glob("backup-*.zip"), reverse=True):
        try:
            with zipfile.ZipFile(p) as zf:
                meta = json.loads(zf.read("manifest.json").decode("utf-8"))
            out.append({"file": p.name, "exportedAt": meta.get("exportedAt"),
                        "reason": meta.get("reason"), "schemaVersion": meta.get("schemaVersion")})
        except Exception:
            out.append({"file": p.name, "exportedAt": None, "reason": "unknown",
                        "schemaVersion": None})
    return out


def restore_backup(filename: str):
    safe = Path(filename).name
    path = BACKUPS / safe
    if not path.exists() or not safe.startswith("backup-") or not safe.endswith(".zip"):
        raise ValueError("备份文件不存在或名称不合法")
    with zipfile.ZipFile(path) as zf:
        meta = json.loads(zf.read("manifest.json").decode("utf-8"))
        if meta.get("format") != "personal-workbench-backup" or meta.get("formatVersion", 99) > 1:
            raise ValueError("备份格式不受支持")
        if meta.get("schemaVersion", 0) > SCHEMA_VERSION:
            raise ValueError("备份来自更高数据版本，无法在当前版本恢复")
        names = zf.namelist()
        # 校验通过后再动盘：先全部读入内存
        payload = {}
        for n in names:
            if not n.startswith("data/") or n.endswith("/"):
                continue
            rel = n[len("data/"):]
            target = (DATA / rel).resolve()
            if not target.is_relative_to(DATA.resolve()) or target.suffix != '.json':
                raise ValueError('备份包含不合法的数据路径')
            if Path(rel).name in BACKUP_SKIP:
                continue
            blob = zf.read(n)
            value = json.loads(blob.decode('utf-8'))
            if target.stem not in USER_ENTITIES + GLOBAL_ENTITIES:
                continue
            payload[rel] = value
    make_backup(reason="pre-restore")
    DOCUMENTS.write_many([(DATA / rel, value) for rel, value in payload.items()])
    return {"restored": safe, "files": len(payload)}


def export_envelope(root: Path) -> dict:
    return {
        "format": "personal-workbench-backup",
        "formatVersion": 1,
        "appId": "personal-command-center",
        "appVersion": "1.2.0",
        "schemaVersion": SCHEMA_VERSION,
        "exportedAt": now_iso(),
        "user": root.name,
        "data": {n: read_entity(n, {} if n in ('settings', 'preferences', 'control') else [], root=root) for n in USER_ENTITIES},
    }


def import_envelope(envelope: dict, root: Path) -> dict:
    if envelope.get("format") != "personal-workbench-backup" or envelope.get("formatVersion", 99) > 1:
        raise ValueError("不支持的导入格式")
    if envelope.get("schemaVersion", 0) > SCHEMA_VERSION:
        raise ValueError("数据来自更高版本，拒绝导入")
    data = envelope.get("data") or {}
    if not isinstance(data, dict):
        raise ValueError('导入数据必须是对象')
    counts = {}
    replacements = []
    for name in USER_ENTITIES:
        if name in data and data[name] is not None:
            expected = dict if name in ('settings','preferences','control') else list
            if not isinstance(data[name], expected) or (expected is list and any(not isinstance(row, dict) for row in data[name])):
                raise ValueError(f'{name} 数据格式不正确')
            if name=='control':
                validate_state(data[name])
                AI_CONTROL.update_config(root.name,data[name].get('config',{}),validate_only=True)
            replacements.append((_entity_path(name, root),data[name]))
            counts[name] = len(data[name]) if isinstance(data[name], list) else 1
        elif name == "transactions":
            replacements.append((_entity_path(name, root),[]))
            counts[name] = 0
    make_backup(reason="pre-import")
    DOCUMENTS.write_many(replacements)
    return {"overwritten": sum(counts.values()), "counts": counts}


# ---------------------------------------------------------------- 业务逻辑

def _ensure_settings(root: Path):
    s = read_entity("settings", None, root=root)
    if not s:
        write_entity("settings", dict(DEFAULT_SETTINGS), backup=False, root=root)
        return dict(DEFAULT_SETTINGS)
    old_sources = s.get("news_sources", [])
    legacy_layout = ([src.get("id") for src in old_sources if isinstance(src, dict)]
                     == ["tech", "world", "ee", "study", "game"]
                     and sum(not src.get("feeds") for src in old_sources) >= 3)
    if "news_sources" not in s or legacy_layout or any(
        "news.ycombinator.com" in json.dumps(src) or "feedx.net/rss/bbc" in json.dumps(src)
        or "c114.com.cn/rss/news.asp" in json.dumps(src) or "36kr.com/feed" in json.dumps(src)
        or "people.com.cn/rss/politics.xml" in json.dumps(src)
        for src in old_sources
    ):
        s["news_sources"] = DEFAULT_SETTINGS["news_sources"]
        s["news_sources_version"] = 2
        write_entity("settings", s, backup=False, root=root)
    return s


def save_profile(root: Path, display_name: str):
    name = display_name.strip()
    if len(name) > 30:
        raise ValueError("昵称不能超过 30 字")
    settings = _ensure_settings(root)
    settings["display_name"] = name
    write_entity("settings", settings, root=root)
    return name


def change_password(username: str, current: str, new: str):
    if not verify_user(username, current):
        raise ValueError("当前密码不正确")
    if len(new) < 8:
        raise ValueError("新密码至少 8 位")
    salt = os.urandom(16)
    with _db() as db:
        db.execute("UPDATE users SET salt=?, pass_hash=? WHERE username=?",
                   (salt.hex(), _hash_pw(new, salt), username))


def _valid_transaction(row):
    if not isinstance(row,dict):raise ValueError('交易记录必须是对象')
    date = str(row.get("date", ""))
    date = datetime.strptime(date, "%Y-%m-%d").strftime('%Y-%m-%d')
    try:
        value=Decimal(str(row.get('amount',0)))
        if not value.is_finite() or value<=0 or value>1_000_000_000:raise InvalidOperation()
        amount=float(value.quantize(Decimal('0.01'),rounding=ROUND_HALF_UP))
        if amount<=0:raise InvalidOperation()
    except (InvalidOperation,ValueError,TypeError):raise ValueError('金额需为 0.01 到 1,000,000,000 的有效数字') from None
    kind = row.get("kind")
    if kind not in ("income", "expense"):
        raise ValueError("收支类型无效")
    title = str(row.get("title", "")).strip()[:120] or "未命名交易"
    category = str(row.get("category", "")).strip()[:20] or ("收入" if kind == "income" else bill_parser.category_for(title))
    source_id = str(row.get("sourceId", ""))[:100]
    occurred_at = str(row.get("occurredAt", ""))[:40]
    fingerprint = hashlib.sha256(f"{source_id or occurred_at or date}|{amount:.2f}|{kind}|{title}".encode()).hexdigest()
    return {"id": new_id(), "date": date, "amount": amount, "kind": kind,
            "title": title, "category": category, "fingerprint": fingerprint, "createdAt": now_iso()}


def add_transactions(root: Path, rows: list, allow_duplicate: bool = False):
    if not isinstance(rows, list) or len(rows) > 5000:
        raise ValueError("单次最多导入 5000 条")
    clean = [_valid_transaction(row) for row in rows]
    existing = read_entity("transactions", [], root=root)
    known = {r.get("fingerprint") for r in existing}
    inserted = []
    for row in clean:
        if allow_duplicate or row["fingerprint"] not in known:
            inserted.append(row)
            known.add(row["fingerprint"])
    if inserted:
        write_entity("transactions", inserted + existing, root=root)
        log_activity(f"导入账单 {len(inserted)} 条", root=root)
    return {"added": len(inserted), "duplicates": len(clean) - len(inserted)}


def _workspace_path(relative: str):
    target = (WORKSPACE / relative).resolve()
    if not target.is_relative_to(WORKSPACE) or not target.is_file():
        raise ValueError("文件不在工作区内")
    parts = set(target.relative_to(WORKSPACE).parts)
    if parts & {".git", "node_modules", "backups", "data", "outputs", "code-snapshots", "migration-backups", "reference", ".venv", "__pycache__", "private", ".build-cache", ".desktop-build", "dist-desktop", ".runtime-deps"}:
        raise ValueError("该目录不在可读取范围内")
    if target.name.lower().startswith('.env') or target.name.lower() in {"accounts.db", "secrets.json"} or target.suffix.lower() not in {
        ".py", ".js", ".ts", ".tsx", ".jsx", ".html", ".css", ".json", ".md", ".txt", ".yml", ".yaml", ".toml", ".xml", ".svg"
    }:
        raise ValueError("仅可读取工作区内的普通文本文件")
    if target.stat().st_size > 1024 * 1024:
        raise ValueError("文件超过 1 MB")
    return target


def workspace_tree(owner=None):
    import fnmatch
    ignored=AI_CONTROL.state(owner)["config"].get("workspaceIgnore",[]) if owner else []
    items = []
    for directory, dirs, files in os.walk(WORKSPACE):
        dirs[:] = sorted(d for d in dirs if d not in {".git", "node_modules", "backups", "data", "outputs", "code-snapshots", "migration-backups", "reference", ".venv", "__pycache__", "private", ".build-cache", ".desktop-build", "dist-desktop", ".runtime-deps"})
        for name in sorted(files):
            if len(items) >= 1200:
                break
            path = Path(directory) / name
            try:
                target = _workspace_path(str(path.relative_to(WORKSPACE)))
                if any(fnmatch.fnmatch(str(target.relative_to(WORKSPACE)).replace("\\","/"),pattern) for pattern in ignored):continue
                stat = target.stat()
                items.append({"path": str(target.relative_to(WORKSPACE)).replace("\\", "/"), "size": stat.st_size, "modifiedAt": datetime.fromtimestamp(stat.st_mtime).astimezone().isoformat(timespec='seconds')})
            except (ValueError, OSError):
                continue
        if len(items) >= 1200:
            break
    try:
        disk = shutil.disk_usage(WORKSPACE)
        storage = {"total": disk.total, "used": disk.used, "free": disk.free}
    except OSError:
        storage = None
    return {"root": str(WORKSPACE), "files": items, "truncated": len(items) >= 1200, "storage": storage}


def workspace_read(relative: str):
    target = _workspace_path(relative)
    content = target.read_text(encoding="utf-8")
    return {"path": str(target.relative_to(WORKSPACE)).replace("\\", "/"),
            "content": content, "revision": hashlib.sha256(content.encode()).hexdigest()}


def workspace_context(current: str, limit: int = 60000, owner=None):
    """Collect readable workspace text within a transparent model-context budget."""
    paths = [item["path"] for item in workspace_tree(owner)["files"] if item["path"] != current]
    current_group = current.split("/")[0]
    paths.sort(key=lambda path: (path.split("/")[0] != current_group, path))
    pieces = []
    used = 0
    for path in paths:
        if used >= limit:
            break
        try:
            content = workspace_read(path)["content"]
        except (ValueError, OSError, UnicodeError):
            continue
        if not content or len(content) > limit - used:
            continue
        pieces.append(f"文件：{path}\n{content}")
        used += len(content)
    return {"text": "\n\n".join(pieces), "fileCount": len(pieces),
            "charCount": used, "totalFiles": len(paths), "truncated": len(pieces) < len(paths)}


def workspace_save(relative: str, content: str, revision: str):
    target = _workspace_path(relative)
    if len(content.encode("utf-8")) > 1024 * 1024:
        raise ValueError("内容超过 1 MB")
    before = target.read_text(encoding="utf-8")
    if hashlib.sha256(before.encode()).hexdigest() != revision:
        raise ValueError("文件已被其他程序修改，请重新读取后再保存")
    backup = target.with_name(target.name + ".wb-prev")
    backup.write_text(before, encoding="utf-8")
    target.write_text(content, encoding="utf-8")
    return {"ok": True, "revision": hashlib.sha256(content.encode()).hexdigest()}


def workspace_suggest(relative: str, instruction: str, include_workspace: bool = False, owner=None):
    if not instruction.strip():
        raise ValueError("请先写明希望 AI 怎样修改文件")
    file = workspace_read(relative)
    if len(file["content"]) > 30000:
        raise ValueError("文件超过 AI 建议的 3 万字符上限，请先选择较小文件")
    cfg = read_ai_config(owner)
    if not all(cfg.get(k) for k in ("apiKey", "baseUrl", "model")):
        raise ValueError("请先在设置中配置兼容的 AI API")
    tree = workspace_tree(owner)["files"]
    context = workspace_context(file["path"],owner=owner) if include_workspace else {"text": "", "fileCount": 0, "charCount": 0, "totalFiles": len(tree) - 1, "truncated": False}
    payload = {"model": cfg["model"], "temperature": 0.1,
               "messages": [
                   {"role": "system", "content": "你是本地代码工作区的编辑助手。仅根据提供的项目文件目录和当前文件修改。只返回 JSON：{\"summary\":\"修改摘要\",\"content\":\"当前文件修改后的完整内容\"}。保留与要求无关的功能。不要写入密钥。"},
                   {"role": "user", "content": f"工作区目录：\n{chr(10).join(x['path'] for x in tree)[:16000]}\n\n其他文件上下文（部分内容可能因长度限制省略）：\n{context['text']}\n\n当前文件：{file['path']}\n\n修改要求：{instruction[:2000]}\n\n文件内容：\n{file['content']}"},
               ]}
    data = AI_CONTROL.request(owner or 'legacy',cfg,payload,agent='工作区修改助手',project=str(WORKSPACE))
    content = data["choices"][0]["message"]["content"]
    try:
        proposal = json.loads(content)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", content, re.S)
        if not match:
            raise ValueError("AI 未返回可编辑内容，请重试")
        proposal = json.loads(match.group(0))
    revised = proposal.get("content")
    if not isinstance(revised, str) or len(revised) > 1000000:
        raise ValueError("AI 返回的文件内容无效")
    return {"summary": str(proposal.get("summary", ""))[:500], "content": revised,
            "path": file["path"], "revision": file["revision"],
            "context": {k: context[k] for k in ("fileCount", "charCount", "totalFiles", "truncated")}}


def seed_demo(root: Path):
    make_backup(reason="pre-seed")
    today = datetime.now()
    d = lambda delta: (today + timedelta(days=delta)).isoformat(timespec="seconds")
    projects = [
        {"id": "p1", "name": "保研材料准备", "status": "active", "createdAt": d(-40), "note": "简历、成绩单、推荐信"},
        {"id": "p2", "name": "考研 · 数学一轮", "status": "active", "createdAt": d(-30), "note": "高数+线代"},
        {"id": "p3", "name": "电子设计竞赛", "status": "waiting", "createdAt": d(-20), "note": "等队友确认选题"},
        {"id": "p4", "name": "数电课程设计", "status": "done", "createdAt": d(-60), "note": "已完成并提交"},
    ]
    tasks = [
        {"id": "t1", "projectId": "p1", "title": "给张老师发开题邮件", "done": False, "createdAt": d(-1), "completedAt": None, "dueAt": None, "location": None},
        {"id": "t2", "projectId": "p1", "title": "更新个人简历第二版", "done": True, "createdAt": d(-2), "completedAt": d(-1), "dueAt": None, "location": None},
        {"id": "t3", "projectId": "p2", "title": "复习通信原理第 4 章", "done": True, "createdAt": d(-1), "completedAt": d(0), "dueAt": None, "location": None},
        {"id": "t4", "projectId": "p2", "title": "线性代数习题 6.2", "done": False, "createdAt": d(0), "completedAt": None, "dueAt": None, "location": None},
        {"id": "t5", "projectId": None, "title": "打两把王者放松 😄", "done": False, "createdAt": d(0), "completedAt": None, "dueAt": None, "location": None},
    ]
    activities = [
        {"id": new_id(), "text": "完成了「复习通信原理第 4 章」", "at": d(0)},
        {"id": new_id(), "text": "在「保研材料准备」新增待办「给张老师发开题邮件」", "at": d(-1)},
        {"id": new_id(), "text": "新建项目「电子设计竞赛」", "at": d(-20)},
    ]
    write_entity("projects", projects, backup=False, root=root)
    write_entity("tasks", tasks, backup=False, root=root)
    write_entity("activities", activities, backup=False, root=root)
    write_entity("summaries", [], backup=False, root=root)
    write_entity("transactions", [], backup=False, root=root)
    s = _ensure_settings(root)
    s["demo_seeded"] = True
    write_entity("settings", s, backup=False, root=root)
    make_backup(reason="seed")


def clear_demo(root: Path):
    make_backup(reason="pre-clear")
    for name in USER_ENTITIES:
        if name == "settings":
            write_entity("settings", dict(DEFAULT_SETTINGS), backup=False, root=root)
        elif name in ("preferences", "control"):
            write_entity(name, {}, backup=False, root=root)
        else:
            write_entity(name, [], backup=False, root=root)
    make_backup(reason="clear")


def add_task(root: Path, title: str, project_id=None, due_at=None, location=None, keywords=None):
    tasks = read_entity("tasks", [], root=root)
    task = {"id": new_id(), "projectId": project_id or None, "title": title.strip(),
            "done": False, "createdAt": now_iso(), "completedAt": None,
            "dueAt": due_at or None, "location": (location or "").strip() or None,
            "keywords": [str(k)[:20] for k in (keywords or [])[:5]]}
    tasks.insert(0, task)
    write_entity("tasks", tasks, root=root)
    if project_id:
        projects = read_entity("projects", [], root=root)
        name = next((p["name"] for p in projects if p["id"] == project_id), "项目")
        log_activity(f"在「{name}」新增待办「{task['title']}」", root=root)
    return task


def add_project(root: Path, name: str, note: str = ""):
    projects = read_entity("projects", [], root=root)
    proj = {"id": new_id(), "name": name.strip(), "status": "active",
            "createdAt": now_iso(), "note": note.strip()}
    projects.insert(0, proj)
    write_entity("projects", projects, root=root)
    log_activity(f"新建项目「{proj['name']}」", root=root)
    return proj


def update_project(root: Path, pid: str, patch: dict):
    projects = read_entity("projects", [], root=root)
    for p in projects:
        if p["id"] == pid:
            for k in ("name", "status", "note"):
                if k in patch and patch[k] not in (None, ""):
                    p[k] = patch[k]
            write_entity("projects", projects, root=root)
            return p
    raise ValueError("项目不存在")


def delete_project(root: Path, pid: str):
    projects = read_entity("projects", [], root=root)
    write_entity("projects", [p for p in projects if p["id"] != pid], root=root)
    tasks = read_entity("tasks", [], root=root)
    write_entity("tasks", [t for t in tasks if t["projectId"] != pid], root=root)


def update_task(root: Path, tid: str, patch: dict):
    tasks = read_entity("tasks", [], root=root)
    for t in tasks:
        if t["id"] == tid:
            if "done" in patch:
                new_done = bool(patch["done"])
                if new_done != t["done"]:
                    t["done"] = new_done
                    t["completedAt"] = now_iso() if new_done else None
                    log_activity(("完成了「%s」" if new_done else "重新打开了「%s」") % t["title"], root=root)
            if "title" in patch and patch["title"].strip():
                t["title"] = patch["title"].strip()
            if "projectId" in patch:
                t["projectId"] = patch["projectId"] or None
            if "dueAt" in patch:
                t["dueAt"] = patch["dueAt"] or None
            if "location" in patch:
                t["location"] = (patch["location"] or "").strip() or None
            write_entity("tasks", tasks, root=root)
            return t
    raise ValueError("待办不存在")


def delete_task(root: Path, tid: str):
    tasks = read_entity("tasks", [], root=root)
    write_entity("tasks", [t for t in tasks if t["id"] != tid], root=root)


def generate_summary(root: Path, month: str | None = None) -> dict:
    month = month or datetime.now().strftime("%Y-%m")
    prefix = month + "-"
    tasks = read_entity("tasks", [], root=root)
    projects = read_entity("projects", [], root=root)
    done = [t for t in tasks if t.get("done") and (t.get("completedAt") or "").startswith(prefix)]
    created = [t for t in tasks if (t.get("createdAt") or "").startswith(prefix)]
    pname = {p["id"]: p["name"] for p in projects}
    by_project = {}
    for t in done:
        key = pname.get(t.get("projectId")) or "未归组"
        by_project.setdefault(key, []).append(t["title"])
    active = [p for p in projects if p.get("createdAt", "").startswith(prefix)]
    draft_lines = [f"{month} 月度复盘", "", "一、本月完成", f"完成待办 {len(done)} 项；新增待办 {len(created)} 项；新建项目 {len(active)} 个。"]
    for pname_, items in by_project.items():
        draft_lines.append(f"• {pname_}：{'；'.join(items)}")
    if not done:
        draft_lines.append("• 本月没有已完成待办记录，请补充实际成果。")
    draft_lines += ["", "二、关键成果与证据", "• [写下结果、文件或可核验的数据]",
                    "", "三、遇到的问题与原因", "• [写下问题、影响及原因]",
                    "", "四、下月计划", "• [写下具体行动和截止日期]"]
    return {
        "month": month,
        "stats": {"done": len(done), "created": len(created), "newProjects": len(active)},
        "draft": "\n".join(draft_lines),
        "byProject": {k: v for k, v in by_project.items()},
    }


def save_summary(root: Path, month: str, content: str, stats: dict) -> dict:
    summaries = read_entity("summaries", [], root=root)
    entry = {"id": new_id(), "month": month, "content": content,
             "stats": stats or {}, "savedAt": now_iso()}
    summaries = [s for s in summaries if s["month"] != month]
    summaries.append(entry)
    summaries.sort(key=lambda s: s["month"], reverse=True)
    write_entity("summaries", summaries, root=root)
    log_activity(f"保存了 {month} 月度总结", root=root)
    return entry


def delete_summary(root: Path, month: str):
    summaries = read_entity("summaries", [], root=root)
    write_entity("summaries", [s for s in summaries if s["month"] != month], root=root)


# ---------------------------------------------------------------- 热点抓取

_TITLE_RE = re.compile(r"<[^>]+>")


def _clean(text: str) -> str:
    from html import unescape
    return unescape(_TITLE_RE.sub("", text or "")).strip()


def _parse_feed(xml_bytes: bytes, limit: int = 6):
    items = []
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        return items
    for item in root.iter():
        tag = item.tag.rsplit("}", 1)[-1]
        if tag not in ("item", "entry"):
            continue
        title, link, date = "", "", ""
        for child in item:
            ctag = child.tag.rsplit("}", 1)[-1]
            if ctag == "title":
                title = _clean(child.text or "")
            elif ctag == "link":
                link = (child.get("href") or child.text or "").strip()
            elif ctag in ("pubDate", "published", "updated", "date"):
                date = (child.text or "").strip()
        if title and link.startswith(("https://", "http://")):
            items.append({"title": title, "link": link, "date": date})
        if len(items) >= limit:
            break
    return items


def _fetch_feed(url: str):
    req = urlrequest.Request(url, headers={"User-Agent": "Mozilla/5.0 (personal-workbench; RSS reader)"})
    with urlrequest.urlopen(req, timeout=NEWS_FETCH_TIMEOUT) as resp:
        items = _parse_feed(resp.read(1024 * 1024), limit=12)
    host = urlparse(url).hostname or ""
    names = {"www.ithome.com": "IT之家", "www.ifanr.com": "爱范儿",
             "www.chinanews.com.cn": "中国新闻网"}
    return [{**item, "source": names.get(host, host)} for item in items]


def _fetch_baidu_hot(url: str):
    """从百度公开热搜页的服务端数据读取当前榜单；榜单没有逐条发布时间。"""
    req = urlrequest.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept-Language": "zh-CN,zh;q=0.9"})
    with urlrequest.urlopen(req, timeout=NEWS_FETCH_TIMEOUT) as resp:
        page = resp.read(1024 * 1024).decode("utf-8", errors="replace")
    match = re.search(r"<!--s-data:(.*?)-->", page, re.DOTALL)
    if not match:
        raise ValueError("百度热搜页面没有榜单数据")
    cards = json.loads(match.group(1)).get("data", {}).get("cards", [])
    rows = next((card.get("content", []) for card in cards if card.get("component") == "hotList"), [])
    if not rows:
        raise ValueError("百度热搜榜单为空")
    captured_at = datetime.now().astimezone().isoformat(timespec="seconds")
    items = []
    for row in rows:
        title = str(row.get("word") or row.get("query") or "").strip()
        if not title or row.get("isTop"):
            continue
        link = str(row.get("url") or "")
        host = urlparse(link).hostname or ""
        if not (host == "baidu.com" or host.endswith(".baidu.com")):
            link = "https://www.baidu.com/s?wd=" + quote(title)
        items.append({"title": title, "link": link, "source": "百度热搜",
                      "capturedAt": captured_at, "rank": len(items) + 1})
        if len(items) == 20:
            break
    return items


def _fetch_bilibili_hot(url: str):
    """B站公开热门接口含视频发布时间，按近 7 天过滤。"""
    req = urlrequest.Request(url, headers={"User-Agent": "Mozilla/5.0",
                                        "Referer": "https://www.bilibili.com/"})
    with urlrequest.urlopen(req, timeout=NEWS_FETCH_TIMEOUT) as resp:
        payload = json.load(resp)
    if payload.get("code") != 0:
        raise ValueError("B站热门接口未返回有效榜单")
    rows = payload.get("data", {}).get("list", [])
    if not isinstance(rows, list):
        raise ValueError("B站热门榜单格式不正确")
    items = []
    for row in rows:
        bvid = str(row.get("bvid") or "")
        title = _clean(str(row.get("title") or ""))
        published = row.get("pubdate")
        if not re.fullmatch(r"BV[A-Za-z0-9]+", bvid) or not title or not isinstance(published, int):
            continue
        items.append({"title": title, "link": f"https://www.bilibili.com/video/{bvid}/",
                      "date": datetime.fromtimestamp(published).astimezone().isoformat(timespec="seconds"),
                      "source": "哔哩哔哩", "rank": len(items) + 1})
    return items


def _fetch_news_source(url: str):
    host = urlparse(url).hostname
    if host == "top.baidu.com":
        return _fetch_baidu_hot(url)
    if host == "api.bilibili.com":
        return _fetch_bilibili_hot(url)
    return _fetch_feed(url)


def _published_timestamp(value: str):
    """RSS/Atom 发布时间；无法解析的条目不充当‘今日热点’。"""
    if not value:
        return None
    try:
        parsed = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.astimezone()
    return parsed.timestamp()


def _recent_news(items, now):
    latest = {}
    for item in items:
        captured = item.get("capturedAt")
        published = _published_timestamp(captured or item.get("date", ""))
        max_age = NEWS_TTL * 2 if captured else NEWS_KEEP_DAYS * 86400
        if published is None or not (now - max_age <= published <= now + 3600):
            continue
        link = item.get("link", "")
        if not link.startswith(("https://", "http://")):
            continue
        enriched = dict(item)
        if not captured:
            enriched["publishedAt"] = datetime.fromtimestamp(published).astimezone().isoformat(timespec="seconds")
        if link not in latest or published > _published_timestamp(latest[link].get("capturedAt") or latest[link].get("date", "")):
            latest[link] = enriched
    values = list(latest.values())
    if values and all("rank" in item for item in values):
        return sorted(values, key=lambda item: item["rank"])[:20]
    return sorted(values, key=lambda item: _published_timestamp(item.get("capturedAt") or item.get("date", "")), reverse=True)[:20]


def fetch_news(force: bool = False) -> dict:
    settings = read_entity("settings", dict(DEFAULT_SETTINGS))
    cache = read_entity("news_cache", {})
    now = time.time()

    # 并行抓取所有需要刷新的源，单源超时不叠加
    stale = []
    for src in settings.get("news_sources", DEFAULT_SETTINGS["news_sources"]):
        entry = cache.get(src["id"]) or {}
        fresh = (entry.get("fetchedAt") and entry.get("feeds") == src.get("feeds")
                 and (now - entry["fetchedAt"] < NEWS_TTL))
        recent_failure = (entry.get("lastAttemptAt") and entry.get("feeds") == src.get("feeds")
                          and now - entry["lastAttemptAt"] < NEWS_FAILURE_RETRY)
        if (force or not (fresh or recent_failure)) and src.get("feeds"):
            stale.append(src)
    if stale:
        from concurrent.futures import ThreadPoolExecutor
        jobs = [(src["id"], url) for src in stale for url in src["feeds"]]
        results2 = {}
        with ThreadPoolExecutor(max_workers=min(8, len(jobs) or 1)) as pool:
            fetched = list(pool.map(lambda j: (j[0], _try_fetch(j[1])), jobs))
        for sid, items in fetched:
            results2.setdefault(sid, []).extend(items or [])
        changed = False
        for src in stale:
            items = _recent_news(results2.get(src["id"], []), now)
            entry = cache.get(src["id"]) or {}
            if results2.get(src["id"]):
                cache[src["id"]] = {"fetchedAt": now, "lastAttemptAt": now,
                                    "feeds": src.get("feeds"), "items": items}
            else:
                previous = entry if entry.get("feeds") == src.get("feeds") else {"items": []}
                cache[src["id"]] = {**previous, "lastAttemptAt": now, "feeds": src.get("feeds")}
            changed = True
        if changed:
            write_entity("news_cache", cache)

    result = {}
    for src in settings.get("news_sources", DEFAULT_SETTINGS["news_sources"]):
        entry = cache.get(src["id"]) or {}
        items = _recent_news(entry.get("items", []), now)
        result[src["id"]] = {
            "name": src["name"],
            "ok": bool(items),
            "fetchedAt": entry.get("fetchedAt"),
            "items": items,
            "links": src.get("links", []),
            "hasFeeds": bool(src.get("feeds")),
            "ranking": bool(src.get("ranking")),
        }
    return result


def _try_fetch(url: str):
    try:
        return _fetch_news_source(url)
    except Exception:
        return []  # 单源失败静默降级


# ---------------------------------------------------------------- AI 配置与解析

def read_ai_config(owner=None) -> dict:
    if owner:
        try:
            cfg=AI_CONTROL.config_for(owner)
            return dict(cfg,provider=cfg['name'])
        except ValueError:pass
    if not SECRETS.exists():
        return {}
    try:
        return json.loads(SECRETS.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def save_ai_config(cfg: dict, owner=None):
    if owner:
        previous=AI_CONTROL.state(owner)['config'].get('defaultProvider')
        AI_CONTROL.provider(owner,{'id':previous,'name':cfg.get('provider') or '兼容 API','baseUrl':cfg.get('baseUrl',''),'model':cfg.get('model',''),'apiKey':cfg.get('apiKey','')})
        return
    clean = {k: str(cfg.get(k, "") or "").strip() for k in ("provider", "baseUrl", "apiKey", "model")}
    if not clean["apiKey"]:
        clean["apiKey"] = read_ai_config().get("apiKey", "")
    DATA.mkdir(exist_ok=True)
    SECRETS.write_text(json.dumps(clean, ensure_ascii=False, indent=1), encoding="utf-8")


def _ai_parse_external(text: str, owner=None) -> dict | None:
    cfg = read_ai_config(owner)
    if not cfg.get("apiKey") or not cfg.get("baseUrl") or not cfg.get("model"):
        return None
    url = cfg["baseUrl"].rstrip("/") + "/chat/completions"
    payload = {
        "model": cfg["model"],
        "messages": [
            {"role": "system", "content": "你是通知信息抽取器。从用户粘贴的通知中提取 JSON："
             '{"title":"主题(简短)","dueAt":"ISO日期时间或null","location":"地点或null","keywords":["关键词"]}。'
             "只返回 JSON，不要多余文字。dueAt 用 24 小时制本地时间。"},
            {"role": "user", "content": text[:2000]},
        ],
        "temperature": 0,
    }
    data = AI_CONTROL.request(owner or 'legacy',cfg,payload,agent='待办提取')
    content = data["choices"][0]["message"]["content"]
    m = re.search(r"\{.*\}", content, re.S)
    if not m:
        return None
    parsed = json.loads(m.group(0))
    return {
        "title": str(parsed.get("title") or "").strip(),
        "dueAt": parsed.get("dueAt") or None,
        "dueText": None,
        "location": str(parsed.get("location") or "").strip() or None,
        "keywords": [str(k)[:20] for k in (parsed.get("keywords") or [])[:5]],
    }


def ai_parse(text: str, owner=None) -> dict:
    text = (text or "").strip()
    if not text:
        raise ValueError("通知内容为空")
    try:
        result = _ai_parse_external(text,owner)
        if result and result["title"]:
            result["engine"] = "ai"
            return result
    except Exception:
        pass  # 任何外部失败都回退本地引擎
    result = ai_parser.parse_notification(text)
    result["engine"] = "local"
    return result


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "Workbench/1.1"

    def log_message(self, fmt, *args):
        pass

    # ---- 认证上下文 ----
    @property
    def session_token(self):
        try:
            c = http_cookies.SimpleCookie(self.headers.get("Cookie", ""))
            return c["wb_session"].value if "wb_session" in c else ""
        except Exception:
            return ""

    def current_user(self):
        return resolve_session(self.session_token)

    def _require_user(self):
        user = self.current_user()
        if not user:
            self._json({"error": "未登录"}, 401)
            return None
        return user

    # ---- 基础 ----
    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        route=urlparse(self.path).path
        limit=100 if route=='/api/import' else 32 if route in ('/api/prompts/import','/api/prompts/import/preview') else 24 if route in ('/api/usage/import','/api/usage/import/preview','/api/usage/sources/import') else 8
        if length > limit * 1024 * 1024:
            raise ValueError("请求超过允许大小")
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def _static(self, path: str):
        if path == "/":
            path = "/index.html"
        target = (STATIC / path.lstrip("/")).resolve()
        if not target.is_relative_to(STATIC.resolve()) or not target.is_file():
            self.send_error(404)
            return
        ctype = {"html": "text/html; charset=utf-8", "css": "text/css; charset=utf-8",
                 "js": "application/javascript; charset=utf-8", "svg": "image/svg+xml",
                 "png": "image/png", "ico": "image/x-icon"}.get(target.suffix.lstrip("."), "application/octet-stream")
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ---- 路由 ----
    # 网络密集型路由（RSS 抓取 / 外部 AI 调用）不持有全局锁，
    # 否则 8-20 秒的外部超时会阻塞所有其他请求；其内部文件写入均为原子替换。
    UNLOCKED_ROUTES = ("/api/news", "/api/ai/parse", "/api/workspace/suggest", "/api/agent/chat", "/api/control/provider/test", "/api/control/mcp/test", "/api/usage/sync", "/api/usage/zcode/sync", "/api/usage/dsh/sync", "/api/usage/connection/sync", "/api/usage/connection/test", "/api/usage/value/sync", "/api/usage/sources/import", "/api/usage/sources/ssh")

    def _desktop_origin_ok(self):
        if not DESKTOP:
            return True
        origin = f'http://127.0.0.1:{self.server.server_address[1]}'
        if self.headers.get('Host') != origin.removeprefix('http://') or self.headers.get('Origin', origin) != origin:
            self._json({'error': '请求来源不正确'}, 403)
            return False
        return True

    def do_GET(self):
        if not self._desktop_origin_ok():
            return
        parsed = urlparse(self.path)
        route, qs = parsed.path, parse_qs(parsed.query,keep_blank_values=True)
        try:
            if route in self.UNLOCKED_ROUTES or route in ('/api/usage','/api/usage/export','/api/usage/value','/api/usage/sources','/api/usage/chart') or route.startswith(('/api/prompts','/api/skills','/api/pricing','/api/jobs','/api/valuation')):
                self._api_get(route, qs)
            elif route.startswith("/api/"):
                with _lock:
                    self._api_get(route, qs)
            else:
                self._static(route)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except PermissionError as exc:
            self._json({'error':str(exc)},403)
        except ValueError as exc:
            self._json({"error": str(exc)}, 400)
        except Exception as exc:  # noqa: BLE001
            self._json({"error": str(exc)}, 500)

    def do_POST(self):
        if not self._desktop_origin_ok():
            return
        parsed = urlparse(self.path)
        try:
            if parsed.path in ('/api/import','/api/prompts/import','/api/prompts/import/preview') and not self.current_user():
                self._json({'error':'请先登录'},401);return
            body = self._read_body()
            relay_match=re.fullmatch(r'/api/usage/relay/([a-zA-Z0-9_-]+)/(chat/completions|responses)',parsed.path)
            if relay_match:
                from workbench.provider_relay import ProviderRelay
                ProviderRelay(USAGE_ACCOUNTS).handle(self,*relay_match.groups(),body)
                return
            if parsed.path in self.UNLOCKED_ROUTES or parsed.path.startswith(('/api/prompts','/api/skills','/api/pricing','/api/valuation')):
                self._api_post(parsed.path, body)
            else:
                with _lock:
                    self._api_post(parsed.path, body)
        except Conflict as exc:
            self._json({'error':str(exc),'current':exc.current,'conflict':True},409)
        except PermissionError as exc:
            self._json({'error':str(exc)},403)
        except ValueError as exc:
            self._json({"error": str(exc)}, 400)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception as exc:  # noqa: BLE001
            self._json({"error": str(exc)}, 500)

    def _api_get(self, route, qs):
        if route == '/api/runtime':
            self._json({'version':RUNTIME_VERSION,'startedAt':RUNTIME_STARTED,'pid':os.getpid(),'instance':DESKTOP_INSTANCE,'desktop':DESKTOP,'preview':os.environ.get('WORKBENCH_PREVIEW')=='1','agentPriceCalculation':AI_MONITOR.agent_value_enabled,'pricePolicy':'per-account-agent-opt-in','priceEngine':'ModelRadar/native-currency/text','sharedService':not DESKTOP,**SHARED_IDENTITY})
            return
        # ---- 无需登录 ----
        if route == "/api/auth/me":
            user = self.current_user()
            self._json({"user": user} if user else {"user": None})
            return
        if route == "/api/news":
            self._json(fetch_news(force=qs.get("force") == ["1"]))
            return
        if route == "/api/ai/config":
            user = self._require_user()
            if not user:return
            cfg = read_ai_config(user['username'])
            self._json({"configured": bool(cfg.get("apiKey")), "provider": cfg.get("provider", ""),
                        "baseUrl": cfg.get("baseUrl", ""), "model": cfg.get("model", "")})
            return
        # ---- 需要登录 ----
        user = self._require_user()
        if not user:
            return
        root = uroot(user["username"])
        from workbench.profile_maintenance import dispatch
        if dispatch(self,SERVICES,BASE,PROFILE_ROOT,route):return
        if route.startswith('/api/skills') and self.client_address[0] not in ('127.0.0.1','::1'):
            self._json({'error':'技能目录仅允许本机认证访问'},403);return
        if route.startswith(RETIRED):
            self._json({'error':'此独立功能已停用，历史资料保留'},410);return
        if route=='/api/profile/avatar':
            avatar=DOCUMENTS.read(root/'avatar.json',{})
            if not avatar.get('png'):self._json({'error':'尚未设置头像'},404);return
            raw=base64.b64decode(avatar['png']);self.send_response(200);self.send_header('Content-Type','image/png');self.send_header('Cache-Control','private, no-store');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw);return
        result=SERVICES.get(user['username'],route,qs)
        if result is not None:self._json(result);return
        if route == '/api/control':
            self._json(AI_CONTROL.public(user['username']))
        elif route == '/api/usage/value':
            self._json(API_VALUE.state())
        elif route == '/api/usage/sources':
            self._json(CODEX_SOURCES.state(user['username']))
        elif route == '/api/usage':
            reader=USAGE_ACCOUNTS.provider_snapshot if qs.get('scope',[''])[0]=='api' else USAGE_ACCOUNTS.codex_snapshot if qs.get('scope',[''])[0]=='codex' else AI_MONITOR.browser_snapshot
            params={k:qs.get(k,[''])[0] for k in ('source','provider','model','project','scope','connection_id','period','start_date','end_date')}
            if 'models' in qs:params['models']=qs['models']
            if reader==USAGE_ACCOUNTS.provider_snapshot:params.update({k:qs.get(k,[''])[0] for k in ('supplier','connection_ids')})
            elif params['scope'] in ('codex','zcode','dsh'):params['value_currency']=qs.get('value_currency',['USD'])[0]
            if params['scope'] in ('codex','zcode','dsh') and params['source']!='official':params['valuation_enabled']=SERVICES.valuation(user['username'],params['scope'])
            result=reader(user['username'],int(qs.get('days',['30'])[0]),**params)
            result['query']={k:v for k,v in params.items() if k!='valuation_enabled'}
            self._json(result)
        elif route == '/api/usage/connections':
            self._json(USAGE_ACCOUNTS.list(user['username']))
        elif route == '/api/usage/export':
            reader=USAGE_ACCOUNTS.provider_snapshot if qs.get('scope',[''])[0]=='api' else USAGE_ACCOUNTS.codex_snapshot if qs.get('scope',[''])[0]=='codex' else AI_MONITOR.snapshot
            params={k:qs.get(k,[''])[0] for k in ('source','provider','model','project','scope','connection_id','period','start_date','end_date')}
            if 'models' in qs:params['models']=qs['models']
            if reader==USAGE_ACCOUNTS.provider_snapshot:params.update({k:qs.get(k,[''])[0] for k in ('supplier','connection_ids')})
            elif params['scope'] in ('codex','zcode','dsh') and params['source']!='official':params['valuation_enabled']=SERVICES.valuation(user['username'],params['scope'])
            elif params['scope'] in ('codex','zcode','dsh'):params['value_currency']=qs.get('value_currency',['USD'])[0]
            from workbench.codex_ledger import visible
            result=reader(user['username'],int(qs.get('days',['30'])[0]),include_all=True,**params) if qs else None
            records=result['events'] if result else [{k:v for k,v in row.items() if k!='owner'} for row in AI_MONITOR.events(user['username']) if visible(row)]
            payload={'format':'workbench-ai-usage','version':2,'records':records}
            if result and result.get('valuation'):payload['valuation']={'experimental':True,'currency':result['valuation']['costCurrency'],'records':result['valuation']['events'],'summary':result['valuation']['summary'],'assumptions':result['valuation']['assumptions']}
            self._json(payload)
        elif route == "/api/state":
            self._json({
                "projects": read_entity("projects", [], root=root),
                "tasks": read_entity("tasks", [], root=root),
                "activities": read_entity("activities", [], root=root),
                "summaries": read_entity("summaries", [], root=root),
                "transactions": read_entity("transactions", [], root=root),
                "settings": _ensure_settings(root),
                "serverTime": now_iso(),
            })
        elif route == '/api/preferences':
            self._json({'values': read_entity('preferences', {}, root=root)})
        elif route == '/api/storage/info':
            self._json(DOCUMENTS.info())
        elif route == "/api/summary/draft":
            self._json(generate_summary(root, qs.get("month", [None])[0]))
        elif route == "/api/backups":
            self._json({"backups": list_backups()})
        elif route == "/api/export":
            self._json(export_envelope(root))
        elif route == "/api/workspace/tree":
            self._json(workspace_tree(user['username']))
        elif route == "/api/workspace/file":
            self._json(workspace_read(qs.get("path", [""])[0]))
        else:
            self._json({"error": "not found"}, 404)

    def _api_post(self, route, body):
        # ---- 认证端点 ----
        if route == "/api/auth/register":
            username = str(body.get("username", "")).strip()
            password = str(body.get("password", ""))
            if not USERNAME_RE.match(username):
                raise ValueError("用户名需 2-20 位，仅限中英文、数字、下划线")
            if len(password) < 4:
                raise ValueError("密码至少 4 位")
            first = user_count() == 0
            try:
                create_user(username, password)
            except sqlite3.IntegrityError:
                raise ValueError("用户名已被注册")
            moved = _migrate_legacy_data_to(username) if first else []
            token = create_session(username)
            self._send_session(token, {"user": {"username": username}, "migrated": moved})
            return
        if route == "/api/auth/login":
            username = str(body.get("username", "")).strip()
            password = str(body.get("password", ""))
            user = verify_user(username, password)
            if not user:
                self._json({"error": "用户名或密码错误"}, 401)
                return
            token = create_session(username)
            self._send_session(token, {"user": user})
            return
        if route == "/api/auth/logout":
            drop_session(self.session_token)
            self._send_session("", {"ok": True})
            return
        # ---- 需要登录 ----
        user = self._require_user()
        if not user:
            return
        root = uroot(user["username"])
        from workbench.profile_maintenance import dispatch
        if dispatch(self,SERVICES,BASE,PROFILE_ROOT,route,body):return
        if route.startswith('/api/skills') and self.client_address[0] not in ('127.0.0.1','::1'):
            self._json({'error':'技能目录仅允许本机认证访问'},403);return
        if route.startswith(RETIRED):
            self._json({'error':'此独立功能已停用，历史资料保留'},410);return
        result=SERVICES.post(user['username'],route,body)
        if result is not None:self._json(result,202 if isinstance(result,dict) and result.get('status')=='running' else 200);return
        if route == '/api/control/config':
            if any(body.get(scope+'ValuationEnabled') for scope in ('codex','zcode','dsh')):raise ValueError('请通过滑动确认准备并开启计价')
            AI_CONTROL.update_config(user['username'],body,validate_only=True)
            for scope in ('codex','zcode','dsh'):
                if body.get(scope+'ValuationEnabled') is False:
                    SERVICES.valuation_tasks.disable(user['username'],scope)
            if body.get('dshEnabled'):
                AI_CONTROL.update_config(user['username'],body,validate_only=True)
                USAGE_ACCOUNTS.claim_dsh(user['username'],body.get('dshPath') or AI_CONTROL.public(user['username'])['defaultDshPath'])
            if body.get('zcodeEnabled'):
                AI_CONTROL.update_config(user['username'],body,validate_only=True)
                USAGE_ACCOUNTS.claim_zcode(user['username'])
            if body.get('codexEnabled'):
                AI_CONTROL.update_config(user['username'],body,validate_only=True)
                USAGE_ACCOUNTS.claim_codex(user['username'],body.get('codexPath') or AI_CONTROL.public(user['username'])['defaultCodexPath'])
            self._json(AI_CONTROL.update_config(user['username'],body))
        elif route == '/api/control/provider':
            self._json(AI_CONTROL.provider(user['username'],body))
        elif route == '/api/control/provider/test':
            self._json(AI_CONTROL.test_provider(user['username'],body.get('id')))
        elif route == '/api/control/resource':
            self._json(AI_CONTROL.resource(user['username'],body.get('section'),body))
        elif route == '/api/control/mcp/test':
            self._json(AI_CONTROL.mcp_test(user['username'],body.get('id')))
        elif route == '/api/control/automation/run':
            self._json(AI_CONTROL.run_automation(user['username'],body.get('id'),lambda:{'tasks':read_entity('tasks',[],root=root)},lambda:generate_summary(root)))
        elif route == '/api/agent/session':
            self._json(AI_CONTROL.session(user['username'],body))
        elif route == '/api/agent/chat':
            self._json(AI_CONTROL.chat(user['username'],body))
        elif route == '/api/usage/import':
            if 'text' in body:
                parsed=parse_usage_file(body)
                if parsed['needsMapping']:raise ValueError('请先映射时间、模型和 Token 字段')
                records=parsed['records']
            else:records=body.get('records')
            self._json(AI_MONITOR.import_records(user['username'],usage_import_connection(user['username'],body,records)))
        elif route == '/api/usage/import/preview':
            parsed=parse_usage_file(body)
            if not parsed['needsMapping']:
                parsed.update(AI_MONITOR.import_records(user['username'],usage_import_connection(user['username'],body,parsed['records']),validate_only=True))
            self._json(parsed)
        elif route == '/api/usage/agent/connect':
            self._json(PROVIDER_RELAY.connect_agent(user['username'],body.get('id'),body.get('model')))
        elif route == '/api/usage/relay/config':
            from workbench.provider_relay import ProviderRelay
            self._json(ProviderRelay(USAGE_ACCOUNTS).configure(user['username'],body.get('id'),body.get('revoke') is True))
        elif route == '/api/usage/lmu/authorize':
            from workbench.provider_lmu import Client
            rows=[r for r in USAGE_ACCOUNTS._rows(user['username']) if r['kind']=='lmu']
            self._json(Client(AI_CONTROL,user['username']).authorize(body,rows))
        elif route == '/api/usage/connection':
            self._json(USAGE_ACCOUNTS.save(user['username'],body))
        elif route in ('/api/usage/connection/sync','/api/usage/connection/test'):
            self._json(USAGE_ACCOUNTS.sync(user['username'],body.get('id')))
        elif route == '/api/usage/dsh/sync':
            from workbench.dsh_monitor import scan,default_path
            cfg=AI_CONTROL.state(user['username'])['config']
            if not cfg.get('dshEnabled'):raise ValueError('请先连接 Harness 本机来源')
            path=cfg.get('dshPath') or default_path()
            USAGE_ACCOUNTS.claim_dsh(user['username'],path)
            self._json(scan(AI_MONITOR,user['username'],path))
        elif route == '/api/usage/zcode/sync':
            from workbench.zcode_monitor import scan,default_path
            cfg=AI_CONTROL.state(user['username'])['config']
            if not cfg.get('zcodeEnabled'):raise ValueError('请先连接 ZCode 本机来源')
            USAGE_ACCOUNTS.claim_zcode(user['username'])
            self._json(scan(AI_MONITOR,user['username'],cfg.get('zcodePath') or default_path()))
        elif route == '/api/usage/sync':
            cfg=AI_CONTROL.state(user['username'])['config']
            if not cfg.get('codexEnabled'):raise ValueError('请先启用 Codex 本机日志来源')
            USAGE_ACCOUNTS.claim_codex(user['username'],cfg.get('codexPath') or AI_CONTROL.public(user['username'])['defaultCodexPath'])
            self._json(CODEX_SOURCES.sync(user['username'],cfg.get('codexPath') or os.environ.get('WORKBENCH_CODEX_SESSIONS') or Path.home()/'.codex'/'sessions'))
        elif route == '/api/usage/sources/import':
            self._json(CODEX_SOURCES.import_files(user['username'],body))
        elif route == '/api/usage/sources/ssh':
            self._json(CODEX_SOURCES.ssh(user['username'],body.get('host')))
        elif route == '/api/usage/value/sync':
            SERVICES.require_price(user['username'])
            today=datetime.utcnow().date().isoformat()
            self._json(API_VALUE.start_sync(body.get('start') or (datetime.utcnow().date()-timedelta(days=365)).isoformat(),body.get('end') or today))
        elif route == '/api/preferences':
            changes = body.get('changes')
            if not isinstance(changes, dict) or len(changes) > 100:
                raise ValueError('布局偏好格式不正确')
            for key, value in changes.items():
                if not re.fullmatch(r'wb-[a-z0-9:-]{1,90}', key) or (value is not None and (not isinstance(value, str) or len(value) > 32000)):
                    raise ValueError('布局偏好包含无效值')
            values = read_entity('preferences', {}, root=root)
            if not isinstance(values, dict): values = {}
            for key, value in changes.items():
                if value is None: values.pop(key, None)
                else: values[key] = value
            write_entity('preferences', values, backup=False, root=root)
            self._json({'ok':True, 'values':values})
        elif route == "/api/ai/parse":
            self._json(ai_parse(str(body.get("text", "")),user['username']))
        elif route == "/api/ai/config":
            save_ai_config(body,user['username'])
            self._json({"ok": True, "configured": bool(str(body.get("apiKey", "")).strip())})
        elif route == "/api/profile":
            self._json({"displayName": save_profile(root, str(body.get("displayName", "")))})
        elif route == "/api/profile/password":
            change_password(user["username"], str(body.get("current", "")), str(body.get("new", "")))
            self._json({"ok": True})
        elif route == "/api/bills/preview":
            filename = str(body.get("filename", ""))
            try:
                raw = base64.b64decode(body.get("data", ""), validate=True)
            except (ValueError, TypeError, binascii.Error):
                raise ValueError("账单文件无法读取")
            self._json(bill_parser.parse_bill(filename, raw))
        elif route == "/api/transactions":
            self._json(add_transactions(root, body.get("rows", []), body.get("allowDuplicate") is True))
        elif route.startswith("/api/transactions/"):
            tid = route.rsplit("/", 1)[1]
            current = read_entity("transactions", [], root=root)
            write_entity("transactions", [r for r in current if r["id"] != tid], root=root)
            self._json({"ok": True})
        elif route == "/api/workspace/save":
            self._json(workspace_save(str(body.get("path", "")), str(body.get("content", "")), str(body.get("revision", ""))))
        elif route == "/api/workspace/suggest":
            self._json(workspace_suggest(str(body.get("path", "")), str(body.get("instruction", "")), body.get("includeWorkspace") is True,user['username']))
        elif route == "/api/projects":
            if not body.get("name", "").strip():
                raise ValueError("项目名称不能为空")
            self._json({"project": add_project(root, body["name"], body.get("note", ""))})
        elif route.startswith("/api/projects/"):
            pid = route.rsplit("/", 1)[1]
            if body.get("_method") == "DELETE":
                delete_project(root, pid)
                self._json({"ok": True})
            else:
                self._json({"project": update_project(root, pid, body)})
        elif route == "/api/tasks":
            if not body.get("title", "").strip():
                raise ValueError("待办内容不能为空")
            self._json({"task": add_task(root, body["title"], body.get("projectId"),
                                         body.get("dueAt"), body.get("location"), body.get("keywords"))})
        elif route.startswith("/api/tasks/"):
            tid = route.rsplit("/", 1)[1]
            if body.get("_method") == "DELETE":
                delete_task(root, tid)
                self._json({"ok": True})
            else:
                self._json({"task": update_task(root, tid, body)})
        elif route == "/api/summary/save":
            if not body.get("month"):
                raise ValueError("缺少月份")
            self._json({"summary": save_summary(root, body["month"], body.get("content", ""), body.get("stats"))})
        elif route.startswith("/api/summary/"):
            delete_summary(root, route.rsplit("/", 1)[1])
            self._json({"ok": True})
        elif route == "/api/backup":
            self._json({"file": make_backup()})
        elif route == "/api/restore":
            self._json(restore_backup(body.get("file", "")))
        elif route == "/api/import":
            self._json(import_envelope(body, root))
        elif route == "/api/demo/seed":
            seed_demo(root)
            self._json({"ok": True})
        elif route == "/api/demo/clear":
            clear_demo(root)
            self._json({"ok": True})
        else:
            self._json({"error": "not found"}, 404)

    def _send_session(self, token: str, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if token:
            self.send_header("Set-Cookie", f"wb_session={token}; Path=/; Max-Age={SESSION_TTL}; HttpOnly; SameSite=Strict")
        else:
            self.send_header("Set-Cookie", "wb_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def main():
    global PROFILE_LOCK
    if PROFILE_LOCK is None:PROFILE_LOCK=ProfileLock(DATA)
    DATA.mkdir(parents=True, exist_ok=True)
    BACKUPS.mkdir(parents=True, exist_ok=True)
    init_db()
    DOCUMENTS.initialize()
    _ensure_settings(DATA)  # 初始化并迁移全局热点源
    port = PORT
    try:
        server = ThreadingHTTPServer((HOST, port), Handler)
    except OSError as error:
        raise SystemExit(f"无法监听 {HOST}:{port}：{error}") from None
    SERVICES.initialize()
    stop_background=threading.Event()
    if (DESKTOP and os.environ.get('WORKBENCH_SHARED_SERVICE') != '1') or os.environ.get('WORKBENCH_MANAGED_WEB') == '1':
        from workbench.runtime_lifecycle import watch_parent
        def pause_preparation():
            for path in (DATA/'users').glob('*/control.json'):
                for scope in ('codex','zcode','dsh'):
                    if SERVICES.valuation_tasks.status(path.parent.name,scope).get('status')=='running':
                        SERVICES.valuation_tasks.disable(path.parent.name,scope)
            worker=getattr(API_VALUE,'migration_thread',None)
            if worker:worker.join(timeout=20)
        watch_parent(server, stop_background, DESKTOP_INSTANCE, pause_preparation)
    def background():
        while not stop_background.wait(30):
            for path in (DATA/'users').glob('*/control.json'):
                owner=path.parent.name
                try:
                    state=AI_CONTROL.state(owner)
                    if state['config'].get('codexEnabled') and USAGE_ACCOUNTS.codex_bound(owner):
                        try:
                            USAGE_ACCOUNTS.claim_codex(owner,state['config'].get('codexPath') or AI_CONTROL.public(owner)['defaultCodexPath'])
                            CODEX_SOURCES.sync(owner,state['config'].get('codexPath') or AI_CONTROL.public(owner)['defaultCodexPath'])
                        except (ValueError,OSError) as error:print('Codex 采集异常: '+str(error),flush=True)
                    USAGE_ACCOUNTS.tick(owner)
                    if state['config'].get('zcodeEnabled'):
                        try:
                            from workbench.zcode_monitor import scan,default_path
                            USAGE_ACCOUNTS.claim_zcode(owner)
                            scan(AI_MONITOR,owner,state['config'].get('zcodePath') or default_path())
                        except (ValueError,OSError):pass
                    if state['config'].get('dshEnabled'):
                        try:
                            from workbench.dsh_monitor import scan,default_path
                            path=state['config'].get('dshPath') or default_path()
                            USAGE_ACCOUNTS.claim_dsh(owner,path);scan(AI_MONITOR,owner,path)
                        except (ValueError,OSError):pass
                except Exception as error:
                    print('后台采集 / 自动化异常: '+str(error),flush=True)
    if os.environ.get('WORKBENCH_PREVIEW')!='1':threading.Thread(target=background,daemon=True).start()
    port = server.server_address[1]
    url = f"http://127.0.0.1:{port}"
    if DESKTOP:
        from workbench.runtime_lifecycle import announce
        announce(server, RUNTIME_VERSION, DESKTOP_INSTANCE)
    print(f"灵犀工作坊已启动: {url}  （监听 {HOST}:{port}，Ctrl+C 退出）", flush=True)
    if os.environ.get("WORKBENCH_OPEN_BROWSER") == "1":
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已退出。")
    finally:
        stop_background.set()
        server.server_close()


if __name__ == "__main__":
    main()
