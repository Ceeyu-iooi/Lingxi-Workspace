"""Public, licensed data only. Market refresh never executes downloaded code."""
import csv
import hashlib
import io
import json
import re
import urllib.request
from urllib.parse import urlparse
from workbench.prompt_store import encode, stamp, text
csv.field_size_limit(20*1024*1024)

SOURCES=[dict(id='prompts-chat',name='prompts.chat',repo='f/prompts.chat',path='prompts.csv',ref='main',format='csv',license='CC0-1.0'),
         dict(id='langgpt',name='LangGPT',repo='langgptai/LangGPT',path='examples/chinese_poet/Prompt_chinese_poet.md',ref='main',format='markdown',license='Apache-2.0')]

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args):return None

def fetch(url):
    if urlparse(url).hostname not in ('api.github.com','raw.githubusercontent.com'):raise ValueError('模板源需为公开 GitHub 仓库')
    with urllib.request.build_opener(NoRedirect()).open(urllib.request.Request(url,headers={'User-Agent':'Lingxi-Workbench','Accept':'application/vnd.github+json'}),timeout=20) as response:
        data=response.read(20*1024*1024+1)
        if len(data)>20*1024*1024:raise ValueError('模板数据源过大')
        return data.decode('utf-8-sig')

class Market:
    def __init__(self,prompts,jobs):self.prompts,self.jobs=prompts,jobs
    def sources(self,owner):
        self.prompts.setup()
        with self.prompts.documents.connect() as db:return SOURCES+[json.loads(r[0]) for r in db.execute('SELECT config FROM template_sources WHERE owner=?',(owner,))]
    def config(self,owner,body):
        self.prompts.setup();repo=text(body.get('repo',''),200);path=text(body.get('path',''),500);ref=text(body.get('ref','main'),100)
        if not re.fullmatch(r'[\w.-]+/[\w.-]+',repo) or '..' in path.split('/') or path.startswith('/') or not re.fullmatch(r'[\w./-]+',path) or not re.fullmatch(r'[\w.-]+',ref):raise ValueError('仓库、分支或文件路径不正确')
        license=text(body.get('license',''),100).strip()
        if not license:raise ValueError('请填写并核验模板数据许可')
        sid=hashlib.sha256((owner+repo+path).encode()).hexdigest()[:24];fmt=body.get('format','json')
        if fmt not in ('csv','json','markdown'):raise ValueError('模板源格式不支持')
        if not isinstance(body.get('mapping',{}),dict) or any(k not in ('title','content') or not isinstance(v,str) or len(v)>100 for k,v in body.get('mapping',{}).items()):raise ValueError('字段映射不正确')
        value=dict(id=sid,name=body.get('name') or repo,repo=repo,path=path,ref=ref,format=fmt,license=license,mapping=body.get('mapping',{}),owner=owner)
        return value
    def source(self,owner,body):
        value=self.config(owner,body);sid=value['id']
        with self.prompts.documents.connect() as db:db.execute('INSERT INTO template_sources VALUES(?,?,?) ON CONFLICT(owner,id) DO UPDATE SET config=excluded.config',(owner,sid,encode(value)))
        return value
    def sync(self,owner,sid,loader=fetch,preview_source=None,expected_commit=None):
        source=preview_source or next((s for s in self.sources(owner) if s['id']==sid),None)
        if not source:raise ValueError('模板源不存在')
        def work(update):
            commit=json.loads(loader('https://api.github.com/repos/'+source['repo']+'/commits/'+source['ref']))['sha']
            if expected_commit and commit!=expected_commit:raise ValueError('来源在预览后已变化，请重新预览再同步')
            raw=loader('https://raw.githubusercontent.com/'+source['repo']+'/'+commit+'/'+source['path'])
            if source['format']=='csv':rows=list(csv.DictReader(io.StringIO(raw)))
            elif source['format']=='json':
                data=json.loads(raw);rows=data if isinstance(data,list) else data.get('items',[])
            else:rows=[dict(title=source['name']+' · 结构化模板',content=raw)]
            mapping=source.get('mapping',{});items=[]
            for i,row in enumerate(rows[:20000]):
                title=row.get(mapping.get('title','title')) or row.get('act') or row.get('name') or '模板 '+str(i+1)
                content=row.get(mapping.get('content','content')) or row.get('prompt') or row.get('body')
                if not isinstance(content,str) or not content.strip() or len(content)>262144:continue
                digest=hashlib.sha256(content.encode()).hexdigest();rid=hashlib.sha256((str(title)+'\0'+str(i)).encode()).hexdigest()[:24]
                origin=dict(source=sid,id=rid,repo=source['repo'],path=source['path'],commit=commit,license=source['license'],digest=digest,url='https://github.com/'+source['repo']+'/blob/'+commit+'/'+source['path'])
                items.append((sid,rid,str(title)[:160],content,'markdown',encode(row.get('tags',[]) if isinstance(row.get('tags'),list) else []),encode(origin),stamp()))
            if preview_source:return dict(source=sid,count=len(items),commit=commit,license=source['license'],items=[dict(title=r[2],excerpt=r[3][:400]) for r in items[:20]],preview=True)
            with self.prompts.documents.lock,self.prompts.documents.connect() as db:
                db.execute('DELETE FROM template_catalog WHERE source=?',(sid,));db.executemany('INSERT INTO template_catalog VALUES(?,?,?,?,?,?,?,?)',items)
            return dict(source=sid,count=len(items),commit=commit,license=source['license'])
        return self.jobs.start(owner,('template-preview:' if preview_source else 'template-sync:')+sid,work)
    def preview(self,owner,body):
        source=self.config(owner,body);return self.sync(owner,source['id'],preview_source=source)
    def search(self,owner,params):
        sources=self.sources(owner);self.seed();allowed={s['id'] for s in sources};query=str(params.get('q','')).casefold();items=[]
        with self.prompts.documents.connect() as db:
            for row in db.execute('SELECT * FROM template_catalog ORDER BY title'):
                if row['source'] not in allowed or params.get('source') and row['source']!=params['source']:continue
                if query and query not in (row['title']+'\n'+row['content']).casefold():continue
                items.append(dict(id=row['id'],source=row['source'],title=row['title'],excerpt=row['content'][:180],origin=json.loads(row['origin']),tags=json.loads(row['tags']),updated=row['updated']))
        offset=max(0,int(params.get('offset',0)));limit=min(100,max(1,int(params.get('limit',40))))
        return dict(items=items[offset:offset+limit],total=len(items),sources=sources)
    def seed(self):
        from pathlib import Path
        from workbench.paths import resource
        path=resource('static/vendor/prompt-market/seed.json')
        if not path.is_file():return
        with self.prompts.documents.connect() as db:
            if db.execute('SELECT 1 FROM template_catalog LIMIT 1').fetchone():return
            for row in json.loads(path.read_text(encoding='utf-8'))['items']:
                db.execute('INSERT OR IGNORE INTO template_catalog VALUES(?,?,?,?,?,?,?,?)',(row['source'],row['id'],row['title'],row['content'],row['format'],encode(row['tags']),encode(row['origin']),stamp()))
    def get(self,owner,sid,rid):
        if sid not in {s['id'] for s in self.sources(owner)}:raise ValueError('模板源不存在')
        with self.prompts.documents.connect() as db:row=db.execute('SELECT * FROM template_catalog WHERE source=? AND id=?',(sid,rid)).fetchone()
        if not row:raise ValueError('模板不存在')
        return dict(title=row['title'],content=row['content'],format=row['format'],tags=json.loads(row['tags']),origin=dict(json.loads(row['origin']),source=sid,id=rid))
    def update_status(self,owner,item):
        origin=item.get('origin',{});sid=origin.get('source');rid=origin.get('id')
        if not sid or not rid or sid not in {s['id'] for s in self.sources(owner)}:return item
        with self.prompts.documents.connect() as db:row=db.execute('SELECT origin FROM template_catalog WHERE source=? AND id=?',(sid,rid)).fetchone()
        if row:
            latest=json.loads(row[0])
            if latest.get('digest')!=origin.get('digest'):item['templateUpdate']=dict(commit=latest.get('commit'),url=latest.get('url'),message='模板来源有更新；你的个人副本保持不变')
        return item
