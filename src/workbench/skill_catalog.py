"""Read-only local SKILL.md index, with bounded traversal and canonical aliases."""
from pathlib import Path
import hashlib
import json
import os
import time
import yaml


class Skills:
    def __init__(self, documents, jobs, workspace):
        self.documents, self.jobs, self.workspace = documents, jobs, Path(workspace).resolve()
        self.ready = False

    def setup(self):
        self.documents.initialize()
        with self.documents.lock:
            if self.ready: return
            with self.documents.connect() as db:
                db.execute('CREATE TABLE IF NOT EXISTS skill_sources(owner TEXT,id TEXT,config TEXT,PRIMARY KEY(owner,id))')
                db.execute('CREATE TABLE IF NOT EXISTS skill_catalog(owner TEXT,id TEXT,title TEXT,description TEXT,body TEXT,meta TEXT,fingerprint TEXT,PRIMARY KEY(owner,id))')
                db.execute('CREATE TABLE IF NOT EXISTS skill_scan_state(owner TEXT PRIMARY KEY,value TEXT)')
                db.execute('CREATE INDEX IF NOT EXISTS skill_catalog_owner ON skill_catalog(owner,title)')
            self.ready = True

    def defaults(self):
        configured=os.environ.get('WORKBENCH_SKILL_ROOTS')
        if configured:
            return json.loads(configured)
        home=Path(os.environ.get('USERPROFILE') or Path.home())
        rows=[('shared','共享 Agent',home/'.agents/skills','user'),('codex','Codex',home/'.codex/skills','user'),
              ('claude','Claude Code',home/'.claude/skills','user'),('cursor','Cursor',home/'.cursor/skills','user'),
              ('gemini','Gemini CLI',home/'.gemini/skills','user'),('dsh','DeepSeek Harness',home/'.dsh/skills','user'),
              ('codex-cache','Codex 插件缓存',home/'.codex/plugins/cache','cache'),('claude-cache','Claude 插件缓存',home/'.claude/plugins/cache','cache')]
        for agent in ('agents','codex','claude','cursor','gemini'):
            rows.append(('project-'+agent,agent.capitalize(),self.workspace/('.'+agent)/'skills','project'))
        return [dict(id=i,name=n,path=str(p),kind=k,project=self.workspace.name if k=='project' else '',enabled=True) for i,n,p,k in rows]

    def sources(self,owner):
        self.setup()
        with self.documents.connect() as db:
            rows=[json.loads(r[0]) for r in db.execute('SELECT config FROM skill_sources WHERE owner=?',(owner,))]
        values=rows or self.defaults()
        return [dict(r,exists=Path(r['path']).is_dir()) for r in values]

    def source(self,owner,body):
        self.setup()
        if body.get('id') and set(body)<= {'id','enabled'}:
            if not isinstance(body.get('enabled'),bool):raise ValueError('来源开关不正确')
            row=next((s for s in self.sources(owner) if s['id']==body['id']),None)
            if not row:raise ValueError('来源不存在')
            row={k:v for k,v in row.items() if k!='exists'};row['enabled']=body['enabled']
            with self.documents.connect() as db:
                if not db.execute('SELECT 1 FROM skill_sources WHERE owner=?',(owner,)).fetchone():db.executemany('INSERT INTO skill_sources VALUES(?,?,?)',[(owner,r['id'],json.dumps(r)) for r in self.defaults()])
                db.execute('INSERT INTO skill_sources VALUES(?,?,?) ON CONFLICT(owner,id) DO UPDATE SET config=excluded.config',(owner,row['id'],json.dumps(row)))
            return dict(id=row['id'],enabled=row['enabled'])
        if body.get('delete'):
            with self.documents.connect() as db:db.execute('DELETE FROM skill_sources WHERE owner=? AND id=?',(owner,body.get('id')))
            return dict(id=body.get('id'))
        path=Path(str(body.get('path',''))).expanduser()
        if not path.is_absolute() or str(path).startswith(('\\\\','//')):raise ValueError('请选择本机绝对目录')
        resolved=path.resolve()
        if not resolved.is_dir() or resolved==Path(resolved.anchor) or len(resolved.parts)<3:raise ValueError('请选择具体的技能目录')
        name=str(body.get('name','自定义技能来源')).strip()[:80]
        sid=body.get('id') or hashlib.sha256(str(resolved).encode()).hexdigest()[:20]
        with self.documents.connect() as db:
            if not db.execute('SELECT 1 FROM skill_sources WHERE owner=?',(owner,)).fetchone():
                db.executemany('INSERT INTO skill_sources VALUES(?,?,?)',[(owner,r['id'],json.dumps(r)) for r in self.defaults()])
            if body.get('delete'):db.execute('DELETE FROM skill_sources WHERE owner=? AND id=?',(owner,sid))
            else:db.execute('INSERT INTO skill_sources VALUES(?,?,?) ON CONFLICT(owner,id) DO UPDATE SET config=excluded.config',(owner,sid,json.dumps(dict(id=sid,name=name,path=str(resolved),kind='custom',enabled=bool(body.get('enabled',True))))))
        return dict(id=sid)

    def scan(self,owner):
        self.setup();sources=self.sources(owner)
        def work(update):
            allowed=[Path(r['path']).resolve() for r in sources if r.get('enabled',True)]
            found={};coverage=[];visited=0
            with self.documents.connect() as db:old={r['id']:dict(r) for r in db.execute('SELECT * FROM skill_catalog WHERE owner=?',(owner,))}
            for i,source in enumerate(sources):
                if not source.get('enabled',True):continue
                root=Path(source['path']);count=0;errors=0;seen=set();limited=False
                if not root.is_dir():coverage.append(dict(id=source['id'],status='missing',count=0));continue
                def error(_):
                    nonlocal errors
                    errors+=1
                for parent,dirs,files in os.walk(root,followlinks=True,onerror=error):
                    canonical=Path(parent).resolve()
                    if canonical in seen or not any(canonical.is_relative_to(r) for r in allowed):dirs[:]=[];continue
                    seen.add(canonical);visited+=1
                    if visited>50000 or len(found)>=10000:limited=True;dirs[:]=[];break
                    dirs[:]=[d for d in dirs if d not in ('.git','node_modules','sessions','archived_sessions','dist','__pycache__') and len(Path(parent).relative_to(root).parts)<12]
                    if 'SKILL.md' not in files:continue
                    file=Path(parent)/'SKILL.md';real=file.resolve()
                    if not any(real.is_relative_to(r) for r in allowed):errors+=1;continue
                    try:
                        stat=real.stat()
                        if stat.st_size>1024*1024:errors+=1;continue
                        sid=hashlib.sha256(str(real).casefold().encode()).hexdigest()[:24]
                        fingerprint=str(stat.st_mtime_ns)+':'+str(stat.st_size)
                        if sid in found:
                            found[sid]['meta']['sources'].append(dict(id=source['id'],agent=source['name'],kind=source['kind'],project=source.get('project',''),path=str(file)));count+=1;continue
                        previous=old.get(sid)
                        if previous and previous['fingerprint']==fingerprint:
                            body=previous['body'];meta=json.loads(previous['meta']);title=previous['title'];description=previous['description']
                        else:
                            body=real.read_text(encoding='utf-8-sig');title=real.parent.name;description='';fields={};warning=''
                            if body.startswith('---'):
                                parts=body.split('---',2)
                                try:
                                    fields=yaml.safe_load(parts[1]) if len(parts)==3 else {}
                                    if not isinstance(fields,dict):raise ValueError()
                                except (yaml.YAMLError,ValueError):fields={};warning='元数据无法解析；仍可查看原文'
                            if isinstance(fields.get('name'),str):title=fields['name'][:160]
                            if isinstance(fields.get('description'),str):description=fields['description'][:2000]
                            meta=dict(path=str(real),modified=stat.st_mtime,size=stat.st_size,digest=hashlib.sha256(body.encode()).hexdigest(),version=str(fields.get('version','')),warning=warning,status='未核验启用状态')
                        meta['sources']=[dict(id=source['id'],agent=source['name'],kind=source['kind'],project=source.get('project',''),path=str(file))]
                        found[sid]=dict(id=sid,title=title,description=description,body=body,meta=meta,fingerprint=fingerprint);count+=1
                    except (OSError,UnicodeDecodeError):errors+=1
                coverage.append(dict(id=source['id'],status='limited' if limited else 'partial' if errors else 'complete',count=count,errors=errors))
                update(progress=dict(done=i+1,total=len(sources),skills=len(found)))
            hashes={}
            for item in found.values():hashes.setdefault(item['meta']['digest'],[]).append(item['id'])
            for item in found.values():item['meta']['duplicateCount']=len(hashes[item['meta']['digest']])
            result=dict(count=len(found),coverage=coverage,at=time.time(),version=str(time.time_ns()))
            if [{k:r.get(k) for k in ('id','path','kind','enabled')} for r in self.sources(owner)]!=[{k:r.get(k) for k in ('id','path','kind','enabled')} for r in sources]:raise ValueError('扫描期间来源发生变化，请刷新索引')
            with self.documents.lock,self.documents.connect() as db:
                db.execute('DELETE FROM skill_catalog WHERE owner=?',(owner,))
                db.executemany('INSERT INTO skill_catalog VALUES(?,?,?,?,?,?,?)',[(owner,r['id'],r['title'],r['description'],r['body'],json.dumps(r['meta'],ensure_ascii=False),r['fingerprint']) for r in found.values()])
                db.execute('INSERT INTO skill_scan_state VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET value=excluded.value',(owner,json.dumps(result)))
            return result
        return self.jobs.start(owner,'skills-scan',work)

    def search(self,owner,params):
        self.setup();query=str(params.get('q','')).casefold();agent=params.get('agent');source=params.get('source');duplicates=str(params.get('duplicates','')) in ('true','1');items=[]
        registered=self.sources(owner);allowed=[Path(r['path']).resolve() for r in registered if r.get('enabled',True)]
        active_ids={r['id'] for r in registered if r.get('enabled',True)}
        with self.documents.connect() as db:
            for row in db.execute('SELECT * FROM skill_catalog WHERE owner=? ORDER BY title COLLATE NOCASE',(owner,)):
                meta=json.loads(row['meta'])
                # Paths were canonicalized during scanning. Search reads that snapshot;
                # resolve links again only when opening a single detail or rescanning.
                if not any(Path(meta['path']).is_relative_to(r) for r in allowed):continue
                meta['sources']=[s for s in meta['sources'] if s['id'] in active_ids]
                if query and query not in (row['title']+'\n'+row['description']+'\n'+row['body']).casefold():continue
                if agent and not any(s['agent']==agent for s in meta['sources']):continue
                if source and not any(s['kind']==source or s['id']==source for s in meta['sources']):continue
                if params.get('project') and not any(s.get('project')==params['project'] for s in meta['sources']):continue
                if duplicates and meta['duplicateCount']<2:continue
                items.append(dict(id=row['id'],title=row['title'],description=row['description'],meta=meta))
            status=db.execute('SELECT value FROM skill_scan_state WHERE owner=?',(owner,)).fetchone()
        offset=max(0,int(params.get('offset',0)));limit=min(100,max(1,int(params.get('limit',40))))
        return dict(items=items[offset:offset+limit],total=len(items),offset=offset,limit=limit,scan=json.loads(status[0]) if status else None,sources=self.sources(owner),readonly=True)

    def get(self,owner,sid):
        self.setup()
        with self.documents.connect() as db:row=db.execute('SELECT * FROM skill_catalog WHERE owner=? AND id=?',(owner,sid)).fetchone()
        if not row:raise ValueError('技能不存在')
        meta=json.loads(row['meta']);allowed=[Path(s['path']).resolve() for s in self.sources(owner) if s.get('enabled',True)]
        if not any(Path(meta['path']).resolve().is_relative_to(r) for r in allowed):raise ValueError('技能来源已移除')
        meta['available']=Path(meta['path']).is_file()
        return dict(id=sid,title=row['title'],description=row['description'],content=row['body'],meta=meta,readonly=True)
