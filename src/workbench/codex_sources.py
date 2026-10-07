from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
import os
import re
import subprocess
import tempfile

FIELDS=('input_tokens','output_tokens','cached_input_tokens','cache_write_input_tokens','reasoning_output_tokens','total_tokens')


def compact(content):
    if not isinstance(content,str) or len(content.encode())>8*1024*1024:raise ValueError('单份日志最多 8 MB')
    rows=[];session=''
    for line in content.splitlines():
        if not line.strip():continue
        try:row=json.loads(line)
        except ValueError:raise ValueError('日志不完整或 JSON 损坏')
        if not isinstance(row,dict):continue
        kind=row.get('type');payload=row.get('payload') or {}
        if not isinstance(payload,dict):continue
        if kind=='session_meta':
            payload={k:v for k,v in payload.items() if k in ('id','session_id','model_provider','cwd','timestamp','forked_from_id','originator')}
            session=str(payload.get('id') or payload.get('session_id') or '')
        elif kind=='turn_context':payload={'model':payload.get('model')}
        elif kind=='event_msg' and payload.get('type')=='token_count':
            info=payload.get('info') or {}
            if not isinstance(info,dict):raise ValueError('消费证据格式不正确')
            info={k:{f:v for f,v in val.items() if f in FIELDS} if isinstance(val,dict) else val for k,val in info.items() if k in ('last_token_usage','total_token_usage','response_id')}
            payload={'type':'token_count','info':info,**({'response_id':payload['response_id']} if payload.get('response_id') else {})}
        else:continue
        rows.append(dict(type=kind,payload=payload,**({k:row[k] for k in ('timestamp','response_id') if k in row})))
    if not session or len(session)>300 or not any(r['type']=='event_msg' for r in rows):raise ValueError('日志缺少会话编号或原始用量证据')
    return ''.join(json.dumps(row,ensure_ascii=False,separators=(',',':'))+'\n' for row in rows)


class CodexSources:
    def __init__(self,monitor):self.monitor=monitor
    def directory(self,owner):return self.monitor.path.parent.parent/'codex-sources'/owner
    def setup(self):
        self.monitor.initialize()
        with self.monitor.db() as db:db.execute('CREATE TABLE IF NOT EXISTS codex_sources(owner TEXT,path TEXT,kind TEXT,label TEXT,digest TEXT,at TEXT,PRIMARY KEY(owner,path))')
    def hosts(self):return [h for h in os.environ.get('WORKBENCH_CODEX_SSH_HOSTS','').split(',') if re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.@-]{0,150}',h)]
    def state(self,owner):
        self.setup()
        with self.monitor.db() as db:
            rows=[dict(r) for r in db.execute('SELECT kind,label,COUNT(*) files,MAX(at) importedAt FROM codex_sources WHERE owner=? GROUP BY kind,label',(owner,))]
        return dict(sources=rows,sshHosts=self.hosts(),cloudAutomatic=False,message='本机日志含本地 Work；远程与云端需同步或导入原始日志')
    def roots(self,owner,local=None):
        folder=self.directory(owner);return ([local] if local else [])+([folder] if folder.is_dir() else [])
    def sync(self,owner,local=None):
        roots=self.roots(owner,local)
        if not roots:raise ValueError('尚未连接用量来源')
        return self.monitor.scan_codex(owner,roots)
    def import_files(self,owner,body):
        kind=body.get('kind');label=body.get('label') or ('远程 SSH' if kind=='ssh' else '云端 Work');files=body.get('files')
        if kind not in ('ssh','cloud') or not isinstance(label,str) or len(label)>100:raise ValueError('日志来源格式不正确')
        if not isinstance(files,list) or not 1<=len(files)<=128:raise ValueError('每次导入 1–128 份日志')
        clean=[];size=0
        for item in files:
            if not isinstance(item,dict):raise ValueError('日志文件格式不正确')
            content=compact(item.get('content'));size+=len(content.encode())
            if size>16*1024*1024:raise ValueError('每次导入最多 16 MB 用量证据')
            clean.append((hashlib.sha256(content.encode()).hexdigest(),content))
        self.setup();folder=self.directory(owner);folder.mkdir(parents=True,exist_ok=True)
        with self.monitor.scan_lock:
            from workbench.codex_ledger import read_file
            from workbench.ai_monitor import tokens,iso
            with tempfile.TemporaryDirectory(dir=folder) as temp:
                for digest,content in clean:
                    path=Path(temp)/(digest+'.jsonl');path.write_text(content,encoding='utf-8');read_file(path,None,tokens,iso)
                for digest,content in clean:
                    target=folder/(digest+'.jsonl')
                    if not target.exists():(Path(temp)/(digest+'.jsonl')).replace(target)
            result=self.sync(owner)
            with self.monitor.db() as db:
                for digest,content in clean:db.execute('INSERT OR REPLACE INTO codex_sources VALUES(?,?,?,?,?,?)',(owner,str(folder/(digest+'.jsonl')),kind,label,digest,datetime.now(timezone.utc).isoformat()))
        return dict(result,source=self.state(owner),received=len(clean))
    def ssh(self,owner,host):
        if host not in self.hosts():raise ValueError('该 SSH 主机尚未由服务器配置')
        imported=0;scanned=0;offset=0
        for _ in range(50):
            from workbench.paths import resource
            script=resource('scripts/collect_codex_logs.py').read_text(encoding='utf-8').split("if __name__=='__main__':",1)[0]
            script+='\nprint(json.dumps(collect('+str(offset)+'),ensure_ascii=False))\n'
            try:
                result=subprocess.run(['ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8',host,'python3 -'],input=script,text=True,encoding='utf-8',capture_output=True,timeout=45,check=True)
                if len(result.stdout)>20*1024*1024:raise ValueError('远程证据响应过大')
                batch=json.loads(result.stdout)
            except (OSError,subprocess.SubprocessError,ValueError):raise ValueError('SSH 同步失败，请检查主机连接和已配置的认证')
            if batch['files']:
                value=self.import_files(owner,dict(kind='ssh',label=host,files=batch['files']));imported+=value['imported'];scanned+=value['scanned']
            if batch['next'] is None:return dict(imported=imported,scanned=scanned,errors=[],source=self.state(owner))
            offset=batch['next']
        raise ValueError('远程日志过多，请导出后分批导入')
