"""Local prompt library: revisions, FTS, templates and account-owned backups."""
import base64
import csv
import hashlib
import io
import json
import re
import time
import threading
import uuid
import zipfile
from collections import OrderedDict
from copy import deepcopy
from datetime import datetime, timezone
from html.parser import HTMLParser


FORMATS = ('text', 'markdown', 'rich', 'json', 'custom')

class Conflict(ValueError):
    def __init__(self, current):
        super().__init__('提示词已在其他窗口修改；你的草稿已保留')
        self.current = current


def uid(): return uuid.uuid4().hex
def stamp(): return datetime.now(timezone.utc).isoformat()
def encode(value): return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
def text(value, maximum=262144):
    if not isinstance(value, str) or len(value) > maximum:
        raise ValueError('文本格式不正确或内容过长')
    return value

def short_terms(value):
    terms=set()
    for word in re.findall(r'[\u3400-\u9fff]+',value):
        terms.update(word);terms.update(word[i:i+2] for i in range(len(word)-1))
    return ' '.join(sorted(terms))


class PlainHTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True); self.parts = []; self.blocked = 0
    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style', 'iframe', 'object'): self.blocked += 1
        if not self.blocked and tag in ('p','br','div','li','h1','h2','h3'): self.parts.append('\n')
    def handle_endtag(self, tag):
        if tag in ('script','style','iframe','object') and self.blocked: self.blocked -= 1
    def handle_data(self, data):
        if not self.blocked: self.parts.append(data)


def plain(content, fmt):
    if fmt != 'rich': return content
    try:
        doc = json.loads(content)
        if not isinstance(doc, dict) or doc.get('type') != 'doc': raise ValueError()
        parts = []
        def walk(node, depth=0):
            if depth > 30 or not isinstance(node, dict): raise ValueError()
            if node.get('type') == 'text': parts.append(text(node.get('text','')))
            for child in node.get('content', []): walk(child, depth + 1)
            if node.get('type') in ('paragraph','heading','listItem'): parts.append('\n')
        walk(doc); return ''.join(parts)
    except (TypeError, json.JSONDecodeError, ValueError): raise ValueError('富文本文档格式不正确') from None


def render_template(content, values):
    if not isinstance(values, dict) or len(values) > 100: raise ValueError('变量格式不正确')
    tokens = re.split(r'(\{\{.*?\}\})', content, flags=re.S)
    out, stack = [], []
    active = lambda: all(parent and branch for parent, branch, _ in stack)
    for token in tokens:
        if token.startswith('{{#if '):
            key = token[6:-2].strip()
            if len(stack) >= 8: raise ValueError('条件嵌套过多')
            value = values.get(key); truth = value not in (None, False, '', 0, 'false')
            stack.append((active(), truth, False))
        elif token == '{{else}}':
            if not stack or stack[-1][2]: raise ValueError('条件语法不正确')
            parent, branch, _ = stack.pop(); stack.append((parent, not branch, True))
        elif token == '{{/if}}':
            if not stack: raise ValueError('条件语法不正确')
            stack.pop()
        elif active():
            if token.startswith('{{') and token.endswith('}}'):
                key = token[2:-2].strip()
                if not re.fullmatch(r'[\w.-]{1,80}', key): raise ValueError('变量名称不正确')
                value = values.get(key)
                if isinstance(value, (dict,list)): raise ValueError('变量值需为文本、数字或布尔值')
                out.append('' if value is None else str(value))
            else: out.append(token)
    if stack: raise ValueError('条件没有结束')
    return ''.join(out)


class PromptStore:
    def __init__(self, documents):
        self.documents = documents
        self.ready = False
        self.search_cache=OrderedDict();self.facet_cache={}
        self.cache_lock=threading.RLock()

    def setup(self):
        self.documents.initialize()
        with self.documents.lock:
            if self.ready: return
            with self.documents.connect() as db:
                db.execute('''CREATE TABLE IF NOT EXISTS prompts(
                  rowid INTEGER PRIMARY KEY,owner TEXT NOT NULL,id TEXT NOT NULL,title TEXT NOT NULL,
                  content TEXT NOT NULL,format TEXT NOT NULL,folder TEXT NOT NULL DEFAULT '',tags TEXT NOT NULL,
                  variables TEXT NOT NULL,favorite INTEGER NOT NULL DEFAULT 0,pinned INTEGER NOT NULL DEFAULT 0,
                  revision INTEGER NOT NULL DEFAULT 1,created TEXT NOT NULL,updated TEXT NOT NULL,deleted TEXT,
                  origin TEXT NOT NULL,legacy_id TEXT,UNIQUE(owner,id),UNIQUE(owner,legacy_id))''')
                db.execute('CREATE INDEX IF NOT EXISTS prompt_owner_sort ON prompts(owner,deleted,pinned,updated)')
                db.execute('CREATE VIRTUAL TABLE IF NOT EXISTS prompt_fts USING fts5(title,body,tags,tokenize="trigram")')
                short_exists=db.execute("SELECT 1 FROM sqlite_master WHERE name='prompt_short_fts'").fetchone()
                db.execute('CREATE VIRTUAL TABLE IF NOT EXISTS prompt_short_fts USING fts5(terms)')
                if not short_exists:
                    db.executemany('INSERT INTO prompt_short_fts(rowid,terms) VALUES(?,?)',[(r['rowid'],short_terms(r['title']+'\n'+plain(r['content'],r['format'])+'\n'+r['tags'])) for r in db.execute('SELECT * FROM prompts WHERE deleted IS NULL').fetchall()])
                db.execute('CREATE TABLE IF NOT EXISTS prompt_folders(owner TEXT,id TEXT,name TEXT,parent TEXT,position INTEGER DEFAULT 0,PRIMARY KEY(owner,id))')
                db.execute('CREATE TABLE IF NOT EXISTS prompt_versions(owner TEXT,id TEXT,revision INTEGER,at TEXT,value TEXT,PRIMARY KEY(owner,id,revision))')
                db.execute('CREATE TABLE IF NOT EXISTS prompt_events(owner TEXT,event_id TEXT,id TEXT,revision INTEGER,action TEXT,at TEXT,details TEXT,PRIMARY KEY(owner,event_id))')
                db.execute('CREATE INDEX IF NOT EXISTS prompt_event_dates ON prompt_events(owner,at,id)')
                db.execute('CREATE INDEX IF NOT EXISTS prompt_event_usage ON prompt_events(owner,id,action)')
                db.execute('CREATE TABLE IF NOT EXISTS prompt_evaluations(owner TEXT,eval_id TEXT,id TEXT,revision INTEGER,kind TEXT,at TEXT,result TEXT,PRIMARY KEY(owner,eval_id))')
                db.execute('CREATE TABLE IF NOT EXISTS library_migrations(owner TEXT PRIMARY KEY,at TEXT,original TEXT)')
                db.execute('CREATE TABLE IF NOT EXISTS template_catalog(source TEXT,id TEXT,title TEXT,content TEXT,format TEXT,tags TEXT,origin TEXT,updated TEXT,PRIMARY KEY(source,id))')
                db.execute('CREATE TABLE IF NOT EXISTS template_sources(owner TEXT,id TEXT,config TEXT,PRIMARY KEY(owner,id))')
                db.execute('CREATE TABLE IF NOT EXISTS library_versions(owner TEXT PRIMARY KEY,version INTEGER NOT NULL)')
                for table in ('prompts','prompt_folders','prompt_events'):
                    for operation in ('INSERT','UPDATE','DELETE'):
                        owner='OLD.owner' if operation=='DELETE' else 'NEW.owner'
                        db.execute('CREATE TRIGGER IF NOT EXISTS '+table+'_'+operation.lower()+'_version AFTER '+operation+' ON '+table+' BEGIN INSERT INTO library_versions VALUES('+owner+',1) ON CONFLICT(owner) DO UPDATE SET version=version+1; END')
            self.ready = True

    @staticmethod
    def public(row, content=True):
        item = dict(row)
        for key in ('rowid','owner','legacy_id'): item.pop(key, None)
        for key in ('tags','variables','origin'): item[key] = json.loads(item[key])
        for key in ('favorite','pinned'): item[key] = bool(item[key])
        if not content: item['excerpt'] = plain(item.pop('content'), item['format'])[:180]
        return item

    def _index(self, db, row):
        db.execute('DELETE FROM prompt_fts WHERE rowid=?', (row['rowid'],))
        db.execute('DELETE FROM prompt_short_fts WHERE rowid=?', (row['rowid'],))
        if not row['deleted']:
            db.execute('INSERT INTO prompt_fts(rowid,title,body,tags) VALUES(?,?,?,?)', (row['rowid'],row['title'],plain(row['content'],row['format']),row['tags']))
            db.execute('INSERT INTO prompt_short_fts(rowid,terms) VALUES(?,?)',(row['rowid'],short_terms(row['title']+'\n'+plain(row['content'],row['format'])+'\n'+row['tags'])))

    def _get(self, db, owner, pid):
        row = db.execute('SELECT * FROM prompts WHERE owner=? AND id=?', (owner,pid)).fetchone()
        if not row: raise ValueError('提示词不存在')
        return row

    def get(self, owner, pid):
        self.setup()
        with self.documents.connect() as db: return self.public(self._get(db,owner,pid))

    def save(self, owner, body, connection=None):
        self.setup()
        if not isinstance(body,dict): raise ValueError('提示词格式不正确')
        title = text(body.get('title','未命名提示词'),160).strip() or '未命名提示词'
        content = text(body.get('content','')); fmt = body.get('format','markdown')
        if fmt not in FORMATS: raise ValueError('内容格式不支持')
        plain(content,fmt)
        tags = body.get('tags',[]); variables = body.get('variables',{})
        if not isinstance(tags,list) or len(tags)>50 or any(not isinstance(t,str) or not t.strip() or len(t)>60 for t in tags): raise ValueError('标签格式不正确')
        tags = list(dict.fromkeys(t.strip() for t in tags))
        if not isinstance(variables,dict) or len(encode(variables))>16000: raise ValueError('变量格式不正确')
        origin = body.get('origin',{})
        if not isinstance(origin,dict) or len(encode(origin))>16000: raise ValueError('来源格式不正确')
        folder = text(body.get('folder',''),100)
        pid = body.get('id') or uid()
        if not isinstance(pid,str) or not re.fullmatch(r'[\w-]{1,100}',pid): raise ValueError('标识格式不正确')
        def work(db):
            old = db.execute('SELECT * FROM prompts WHERE owner=? AND id=?',(owner,pid)).fetchone()
            if old and body.get('expectedRevision') != old['revision']: raise Conflict(self.public(old))
            if folder and not db.execute('SELECT 1 FROM prompt_folders WHERE owner=? AND id=?',(owner,folder)).fetchone(): raise ValueError('分类不存在')
            now = stamp(); revision = old['revision']+1 if old else 1
            if old:
                previous = db.execute('SELECT at FROM prompt_versions WHERE owner=? AND id=? ORDER BY revision DESC LIMIT 1',(owner,pid)).fetchone()
                checkpoint = body.get('checkpoint') or not previous or (datetime.now(timezone.utc)-datetime.fromisoformat(previous['at'])).total_seconds()>=60
                if checkpoint:
                    db.execute('INSERT OR IGNORE INTO prompt_versions VALUES(?,?,?,?,?)',(owner,pid,old['revision'],now,encode(self.public(old))))
                    db.execute('DELETE FROM prompt_versions WHERE owner=? AND id=? AND revision NOT IN (SELECT revision FROM prompt_versions WHERE owner=? AND id=? ORDER BY revision DESC LIMIT 50)',(owner,pid,owner,pid))
            values=(title,content,fmt,folder,encode(tags),encode(variables),int(bool(body.get('favorite',old['favorite'] if old else False))),int(bool(body.get('pinned',old['pinned'] if old else False))),revision,now,encode(origin))
            if old:
                db.execute('UPDATE prompts SET title=?,content=?,format=?,folder=?,tags=?,variables=?,favorite=?,pinned=?,revision=?,updated=?,origin=? WHERE owner=? AND id=?',values+(owner,pid))
            else:
                db.execute('INSERT INTO prompts(owner,id,title,content,format,folder,tags,variables,favorite,pinned,revision,created,updated,origin,legacy_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',(owner,pid,*values[:8],revision,now,now,encode(origin),body.get('_legacyId')))
            row=self._get(db,owner,pid);self._index(db,row);return self.public(row)
        if connection is not None: return work(connection)
        with self.documents.lock,self.documents.connect() as db: return work(db)

    def search(self, owner, params):
        self.setup(); args=[owner]; where=['p.owner=?']; trash=str(params.get('trash','')).lower() in ('1','true')
        where.append('p.deleted IS NOT NULL' if trash else 'p.deleted IS NULL')
        query=text(params.get('q',''),300).strip()
        if re.fullmatch(r'[\u3400-\u9fff]{1,2}',query) and not trash:
            where.append('p.rowid IN (SELECT rowid FROM prompt_short_fts WHERE prompt_short_fts MATCH ?)');args.append('"'+query+'"')
        elif len(query)>=3 and not trash:
            where.append('p.rowid IN (SELECT rowid FROM prompt_fts WHERE prompt_fts MATCH ?)');args.append('"'+query.replace('"','""')+'"')
        elif query:
            where.append('(p.title LIKE ? ESCAPE \'\\\' OR p.content LIKE ? ESCAPE \'\\\')');term='%'+query.replace('\\','\\\\').replace('%','\\%').replace('_','\\_')+'%';args += [term,term]
        for key,column in [('folder','folder'),('format','format')]:
            if params.get(key): where.append('p.'+column+'=?');args.append(params[key])
        for key in ('favorite','pinned'):
            if str(params.get(key,'')) in ('1','true'): where.append('p.'+key+'=1')
        tags=params.get('tags',[])
        if isinstance(tags,str): tags=[t for t in tags.split(',') if t]
        for tag in tags:
            where.append('EXISTS(SELECT 1 FROM json_each(p.tags) WHERE value=?)');args.append(tag)
        for key,op in [('start','>='),('end','<=')]:
            if params.get(key): where.append('substr(p.updated,1,10)'+op+'?');args.append(params[key])
        order={'updated':'p.updated DESC','created':'p.created DESC','name':'p.title COLLATE NOCASE','usage':'uses DESC,p.updated DESC'}.get(params.get('sort'),'p.updated DESC')
        limit=min(100,max(1,int(params.get('limit',40))));offset=max(0,int(params.get('offset',0)))
        sql=' FROM prompts p WHERE '+' AND '.join(where)
        with self.documents.connect() as db:
            db.execute('BEGIN')
            version_row=db.execute('SELECT version FROM library_versions WHERE owner=?',(owner,)).fetchone();version=version_row[0] if version_row else 0
            cache_key=(owner,version,encode(params))
            with self.cache_lock:cached=self.search_cache.get(cache_key)
            if cached is not None:return deepcopy(cached)
            count=db.execute('SELECT count(*)'+sql,args).fetchone()[0]
            page=db.execute('SELECT p.rowid,(SELECT count(*) FROM prompt_events e WHERE e.owner=p.owner AND e.id=p.id AND e.action IN (\'copy\',\'apply\')) uses'+sql+' ORDER BY p.pinned DESC,'+order+',p.id LIMIT ? OFFSET ?',args+[limit,offset]).fetchall()
            # Sort identities first; large prompt bodies never enter the temporary sorter.
            found={r['rowid']:dict(r) for r in db.execute('SELECT rowid,* FROM prompts WHERE rowid IN ('+','.join('?' for _ in page)+')',[r['rowid'] for r in page])} if page else {}
            rows=[dict(found[r['rowid']],uses=r['uses']) for r in page]
            facets=self.facet_cache.get(owner)
            if not facets or facets[0]!=version:
                tags=[r[0] for r in db.execute('SELECT DISTINCT j.value FROM prompts p,json_each(p.tags) j WHERE p.owner=? AND p.deleted IS NULL ORDER BY j.value',(owner,))]
                folders=[dict(r) for r in db.execute('SELECT id,name,parent,position FROM prompt_folders WHERE owner=? ORDER BY position,name',(owner,))]
                facets=(version,tags,folders);self.facet_cache[owner]=facets
        result=dict(items=[dict(self.public(r,False),uses=r['uses']) for r in rows],total=count,offset=offset,limit=limit,tags=facets[1],folders=facets[2],dataVersion=version)
        with self.cache_lock:
            self.search_cache[cache_key]=deepcopy(result)
            while len(self.search_cache)>128:self.search_cache.popitem(last=False)
        return result

    def folder(self,owner,body):
        self.setup();fid=body.get('id') or uid();name=text(body.get('name',''),100).strip();parent=text(body.get('parent',''),100)
        with self.documents.lock,self.documents.connect() as db:
            if body.get('delete'):
                db.execute('UPDATE prompts SET folder=\'\',revision=revision+1 WHERE owner=? AND folder=?',(owner,fid))
                db.execute('UPDATE prompt_folders SET parent=\'\' WHERE owner=? AND parent=?',(owner,fid))
                db.execute('DELETE FROM prompt_folders WHERE owner=? AND id=?',(owner,fid));return {'ok':True}
            if not name: raise ValueError('分类名称不能为空')
            seen={fid};ancestor=parent
            while ancestor:
                if ancestor in seen or len(seen)>8: raise ValueError('分类不能循环或嵌套过深')
                seen.add(ancestor);row=db.execute('SELECT parent FROM prompt_folders WHERE owner=? AND id=?',(owner,ancestor)).fetchone()
                if not row: raise ValueError('上级分类不存在')
                ancestor=row[0]
            db.execute('INSERT INTO prompt_folders VALUES(?,?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET name=excluded.name,parent=excluded.parent,position=excluded.position',(owner,fid,name,parent,int(body.get('position',0))))
        return dict(id=fid,name=name,parent=parent)

    def bulk(self,owner,body):
        self.setup();ids=body.get('ids',[]);action=body.get('action')
        if not isinstance(ids,list) or len(ids)>1000 or action not in ('trash','restore','favorite','pin','move','tag','purge'): raise ValueError('批量操作不正确')
        with self.documents.lock,self.documents.connect() as db:
            rows=[self._get(db,owner,pid) for pid in dict.fromkeys(ids)]
            for row in rows:
                if action in ('trash','restore'):
                    db.execute('UPDATE prompts SET deleted=?,revision=revision+1,updated=? WHERE owner=? AND id=?',(stamp() if action=='trash' else None,stamp(),owner,row['id']))
                elif action=='purge':
                    if not row['deleted']: raise ValueError('请先移入回收站')
                    for table in ('prompts','prompt_versions','prompt_events','prompt_evaluations'): db.execute('DELETE FROM '+table+' WHERE owner=? AND id=?',(owner,row['id']))
                    db.execute('DELETE FROM prompt_fts WHERE rowid=?',(row['rowid'],));continue
                else:
                    item=self.public(row);item.update(expectedRevision=row['revision'],checkpoint=True)
                    if action=='favorite': item['favorite']=bool(body.get('value',True))
                    if action=='pin': item['pinned']=bool(body.get('value',True))
                    if action=='move': item['folder']=body.get('folder','')
                    if action=='tag': item['tags']=list(dict.fromkeys(item['tags']+[text(body.get('tag',''),60)]))
                    self.save(owner,item,db)
                self._index(db,self._get(db,owner,row['id']))
        return dict(ok=True,count=len(rows))

    def versions(self,owner,pid):
        self.get(owner,pid)
        with self.documents.connect() as db: return [dict(revision=r['revision'],at=r['at'],value=json.loads(r['value'])) for r in db.execute('SELECT * FROM prompt_versions WHERE owner=? AND id=? ORDER BY revision DESC',(owner,pid))]

    def event(self,owner,body):
        item=self.get(owner,body.get('id'));action=body.get('action')
        if action not in ('copy','apply','evaluate','optimize','feedback'): raise ValueError('使用事件不正确')
        details=body.get('details',{})
        revision=body.get('revision',item['revision'])
        if isinstance(revision,bool) or not isinstance(revision,int) or not 1<=revision<=item['revision']:raise ValueError('事件版本不正确')
        if not isinstance(details,dict) or len(encode(details))>10000: raise ValueError('反馈格式不正确')
        if 'rating' in details and (isinstance(details['rating'],bool) or not isinstance(details['rating'],int) or not 1<=details['rating']<=5): raise ValueError('评分为 1–5')
        with self.documents.connect() as db: db.execute('INSERT OR IGNORE INTO prompt_events VALUES(?,?,?,?,?,?,?)',(owner,body.get('eventId') or uid(),item['id'],revision,action,stamp(),encode(details)))
        return {'ok':True}

    def stats(self,owner,params=None):
        self.setup();params=params or {};where='e.owner=?';args=[owner]
        for key,op in [('start','>='),('end','<=')]:
            if params.get(key):where+=' AND substr(e.at,1,10)'+op+'?';args.append(params[key])
        if params.get('folder'):where+=' AND p.folder=?';args.append(params['folder'])
        if params.get('tag'):where+=' AND EXISTS(SELECT 1 FROM json_each(p.tags) WHERE value=?)';args.append(params['tag'])
        joined=' FROM prompt_events e JOIN prompts p ON p.owner=e.owner AND p.id=e.id WHERE '+where
        with self.documents.connect() as db:
            actions=[dict(r) for r in db.execute('SELECT e.action,count(*) count'+joined+' GROUP BY e.action',args)]
            daily=[dict(r) for r in db.execute('SELECT substr(e.at,1,10) date,e.action,count(*) count'+joined+' GROUP BY date,e.action ORDER BY date',args)]
            by_prompt=[dict(r) for r in db.execute('SELECT e.id,p.title,p.folder,p.tags,count(*) count'+joined+" AND e.action IN ('copy','apply') GROUP BY e.id ORDER BY count DESC",args)]
            feedback=[dict(id=r['id'],at=r['at'],details=json.loads(r['details'])) for r in db.execute('SELECT e.id,e.at,e.details'+joined+" AND e.action='feedback' ORDER BY e.at DESC",args)]
            folders=[dict(r) for r in db.execute('SELECT id,name FROM prompt_folders WHERE owner=?',(owner,))]
            tags=[r[0] for r in db.execute('SELECT DISTINCT j.value FROM prompts p,json_each(p.tags) j WHERE p.owner=? ORDER BY j.value',(owner,))]
        category={};tag_counts={}
        for item in by_prompt:
            category[item['folder']]=category.get(item['folder'],0)+item['count']
            for tag in json.loads(item['tags']):tag_counts[tag]=tag_counts.get(tag,0)+item['count']
        return dict(actions=actions,daily=daily,prompts=by_prompt,feedback=feedback,folders=folders,tags=tags,categories=category,tagCounts=tag_counts)

    def evaluation(self,owner,pid,revision,kind,result):
        self.get(owner,pid);eid=uid()
        with self.documents.connect() as db: db.execute('INSERT INTO prompt_evaluations VALUES(?,?,?,?,?,?,?)',(owner,eid,pid,revision,kind,stamp(),encode(result)))
        return dict(id=eid,promptId=pid,revision=revision,kind=kind,result=result)

    def evaluations(self,owner,pid):
        self.get(owner,pid)
        with self.documents.connect() as db: return [dict(id=r['eval_id'],revision=r['revision'],kind=r['kind'],at=r['at'],result=json.loads(r['result'])) for r in db.execute('SELECT * FROM prompt_evaluations WHERE owner=? AND id=? ORDER BY at DESC',(owner,pid))]

    def migrate_commands(self,owner,control,db):
        marker=db.execute('SELECT 1 FROM library_migrations WHERE owner=?',(owner,)).fetchone()
        pending=[]
        for command in control.get('resources',{}).get('commands',[]):
            legacy_id=command.get('id') or hashlib.sha256(encode(command).encode()).hexdigest()
            if not db.execute('SELECT 1 FROM prompts WHERE owner=? AND legacy_id=?',(owner,legacy_id)).fetchone():pending.append((command,legacy_id))
        if not marker:db.execute('INSERT INTO library_migrations VALUES(?,?,?)',(owner,stamp(),encode(control)))
        for command,legacy_id in pending:
            self.save(owner,dict(title=command.get('name') or '旧命令',content=command.get('content',''),format='markdown',tags=['旧命令'],origin={'kind':'legacy-command','id':command.get('id')},_legacyId=legacy_id),db)
        return not marker or bool(pending)

    def migrate(self,owner,control):
        self.setup()
        path=self.documents.data/'users'/owner/'control.json'
        with self.documents.lock:
            original=path.read_bytes() if path.exists() else None;mirrored=False
            try:
                with self.documents.connect() as db:
                    changed=self.migrate_commands(owner,control,db)
                    needs_pause=control.get('config',{}).get('memoryEnabled',False) or any(row.get('enabled') for rows in control.get('resources',{}).values() for row in rows)
                    if not changed and not needs_pause:return False
                    archived=json.loads(encode(control))
                    for rows in archived.get('resources',{}).values():
                        for row in rows:row['enabled']=False
                    archived.setdefault('config',{})['memoryEnabled']=False
                    self.documents._put(db,self.documents.namespace(path),'control',archived)
                    self.documents.mirror(path,archived);mirrored=True
            except Exception:
                if mirrored:
                    if original is None:path.unlink(missing_ok=True)
                    else:path.write_bytes(original)
                raise
        return True

    def snapshot(self,owner):
        self.setup()
        with self.documents.connect() as db:
            result={}
            for table in ('prompts','prompt_folders','prompt_versions','prompt_events','prompt_evaluations','template_sources','library_migrations'):
                result[table]=[{k:v for k,v in dict(r).items() if k not in ('owner','rowid')} for r in db.execute('SELECT * FROM '+table+' WHERE owner=?',(owner,))]
            return result

    def restore(self,owner,payload,db):
        self.setup()
        allowed={'prompts','prompt_folders','prompt_versions','prompt_events','prompt_evaluations','template_sources','library_migrations'}
        if not isinstance(payload,dict) or set(payload)-allowed: raise ValueError('提示词备份格式不正确')
        for table,rows in payload.items():
            if not isinstance(rows,list) or any(not isinstance(r,dict) for r in rows):raise ValueError('备份记录格式不正确')
            for row in rows:
                for field in ('id','parent','folder'):
                    if row.get(field) and not re.fullmatch(r'[A-Za-z0-9_-]{1,100}',str(row[field])):raise ValueError('备份编号不正确')
                if table=='prompts':
                    if row.get('format') not in FORMATS:raise ValueError('备份内容格式不支持')
                    text(row.get('title'),160);text(row.get('content'))
                    if isinstance(row.get('revision'),bool) or not isinstance(row.get('revision'),int) or row['revision']<1:raise ValueError('备份版本不正确')
                    tags=json.loads(row.get('tags','[]'));variables=json.loads(row.get('variables','{}'));origin=json.loads(row.get('origin','{}'))
                    if not isinstance(tags,list) or any(not isinstance(t,str) or len(t)>80 for t in tags) or not isinstance(variables,dict) or not isinstance(origin,dict):raise ValueError('备份标签或变量不正确')
        for row in db.execute('SELECT rowid FROM prompts WHERE owner=?',(owner,)):
            db.execute('DELETE FROM prompt_fts WHERE rowid=?',(row[0],));db.execute('DELETE FROM prompt_short_fts WHERE rowid=?',(row[0],))
        for table in allowed:
            db.execute('DELETE FROM '+table+' WHERE owner=?',(owner,))
            columns={r[1] for r in db.execute('PRAGMA table_info('+table+')')} - {'owner','rowid'}
            for item in payload.get(table,[]):
                if not isinstance(item,dict) or set(item)-columns: raise ValueError('备份字段不正确')
                keys=list(item);db.execute('INSERT INTO '+table+'(owner,'+','.join(keys)+') VALUES('+','.join('?' for _ in range(len(keys)+1))+')',[owner]+[item[k] for k in keys])
        for row in db.execute('SELECT * FROM prompts WHERE owner=?',(owner,)).fetchall():
            plain(row['content'],row['format']);self._index(db,row)

    def import_preview(self,filename,raw,_depth=0,_budget=None):
        if len(raw)>20*1024*1024: raise ValueError('文件最多 20 MB')
        if _depth>3:raise ValueError('压缩文件嵌套过深')
        if _budget is None:_budget=[0]
        suffix=filename.rsplit('.',1)[-1].lower();items=[]
        if suffix=='zip':
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                entries=archive.infolist()
                _budget[0]+=sum(e.file_size for e in entries)
                if len(entries)>1000 or _budget[0]>50*1024*1024: raise ValueError('压缩文件过大')
                for entry in entries:
                    if entry.filename.startswith(('/', '\\')) or '..' in entry.filename.replace('\\','/').split('/'): raise ValueError('压缩文件包含非法路径')
                canonical=next((e for e in entries if e.filename=='prompts.json'),None)
                # Our ZIP also carries readable Markdown views of the same records.
                # Import its canonical manifest once instead of duplicating those views.
                for entry in ([canonical] if canonical else entries):
                    if entry.is_dir():continue
                    if entry.file_size>20*1024*1024:raise ValueError('压缩文件内单个文件最多 20 MB')
                    items += self.import_preview(entry.filename,archive.read(entry),_depth+1,_budget)['items']
        else:
            try: value=raw.decode('utf-8-sig')
            except UnicodeDecodeError: raise ValueError('请导入 UTF-8 文件') from None
            if suffix=='json':
                data=json.loads(value);items=data.get('items',[]) if isinstance(data,dict) and 'items' in data else data if isinstance(data,list) else [data]
            elif suffix=='csv':
                for row in csv.DictReader(io.StringIO(value)):
                    tags=row.get('tags','').strip()
                    tags=json.loads(tags) if tags.startswith('[') else [t.strip() for t in tags.split(',') if t.strip()]
                    items.append(dict(title=row.get('title') or row.get('act') or row.get('name') or '导入提示词',content=row.get('content') or row.get('prompt') or row.get('body') or '',format=row.get('format') or 'markdown',tags=tags,variables=json.loads(row.get('variables') or '{}'),origin=json.loads(row.get('origin') or '{}')))
            elif suffix in ('html','htm'):
                parser=PlainHTML();parser.feed(value);items=[dict(title=filename.rsplit('.',1)[0],content=''.join(parser.parts).strip(),format='text')]
            else:items=[dict(title=filename.rsplit('.',1)[0],content=value,format='markdown' if suffix in ('md','markdown') else 'text' if suffix=='txt' else 'custom')]
        if len(items)>10000: raise ValueError('每次最多一万条提示词')
        clean=[]
        for item in items:
            if not isinstance(item,dict):raise ValueError('提示词数据应为对象')
            body=dict(title=text(item.get('title',item.get('name','导入提示词')),160),content=text(item.get('content',item.get('prompt',''))),format=item.get('format','markdown'),tags=item.get('tags',[]),variables=item.get('variables',{}),origin=item.get('origin',{}))
            if body['format'] not in FORMATS: raise ValueError('内容格式不支持')
            plain(body['content'],body['format']);body['digest']=hashlib.sha256((body['format']+'\0'+body['content']).encode()).hexdigest();clean.append(body)
        return dict(items=clean,total=len(clean))

    def import_items(self,owner,body):
        items=body.get('items',[])
        if not isinstance(items,list) or len(items)>1000: raise ValueError('每批最多一千条')
        saved=[];duplicates=0
        with self.documents.lock,self.documents.connect() as db:
            known={(r['format'],r['content']) for r in db.execute('SELECT format,content FROM prompts WHERE owner=? AND deleted IS NULL',(owner,))}
            for item in items:
                if (item.get('format','markdown'),item.get('content','')) in known and not body.get('allowDuplicates'):duplicates+=1;continue
                item={k:v for k,v in item.items() if k not in ('id','owner','revision','expectedRevision','digest')}
                if body.get('folder'):item['folder']=body['folder']
                saved.append(self.save(owner,item,db));known.add((item.get('format','markdown'),item.get('content','')))
        return dict(items=saved,imported=len(saved),duplicates=duplicates)

    def export(self,owner,ids=None,fmt='json'):
        self.setup()
        with self.documents.connect() as db:
            rows=db.execute('SELECT * FROM prompts WHERE owner=? AND deleted IS NULL ORDER BY title',(owner,)).fetchall()
            if ids:rows=[r for r in rows if r['id'] in ids]
            items=[self.public(r) for r in rows]
        if fmt=='json':return dict(filename='prompts.json',mime='application/json',content=json.dumps({'schemaVersion':1,'items':items},ensure_ascii=False,indent=2))
        if fmt=='csv':
            out=io.StringIO();writer=csv.writer(out);writer.writerow(['title','content','format','tags','variables','origin'])
            for r in items:writer.writerow([r['title'],r['content'],r['format'],encode(r['tags']),encode(r['variables']),encode(r['origin'])])
            return dict(filename='prompts.csv',mime='text/csv',content=out.getvalue())
        def rendered(r):return plain(r['content'],r['format'])
        if fmt in ('txt','md'):return dict(filename='prompts.'+fmt,mime='text/plain',content='\n\n'.join(('# '+r['title']+'\n\n' if fmt=='md' else r['title']+'\n\n')+rendered(r) for r in items))
        if fmt=='html':
            from html import escape
            body=''.join('<article><h2>'+escape(r['title'])+'</h2><pre>'+escape(rendered(r))+'</pre></article>' for r in items)
            return dict(filename='prompts.html',mime='text/html',content='<!doctype html><meta charset="utf-8"><title>提示词库</title><style>body{font:14px/1.6 system-ui;max-width:960px;margin:40px auto;color:#172033}article{border:1px solid #e1e5eb;border-radius:16px;padding:24px;margin:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>'+body)
        if fmt=='zip':
            out=io.BytesIO()
            with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as archive:
                archive.writestr('prompts.json',json.dumps({'schemaVersion':1,'items':items},ensure_ascii=False,indent=2))
                for r in items:archive.writestr(r['id']+'.md','# '+r['title']+'\n\n'+rendered(r))
            return dict(filename='prompts.zip',mime='application/zip',base64=base64.b64encode(out.getvalue()).decode())
        raise ValueError('导出格式不支持')
