"""Account-owned backups; internal recovery snapshots are never listed here."""
from pathlib import Path
import base64
import json
import re
import time
import uuid
import zipfile
from workbench.prompt_store import encode, stamp


class AccountBackups:
    def __init__(self, documents, prompts, control, base, entities, validator):
        self.documents,self.prompts,self.control=documents,prompts,control
        self.base=Path(base).resolve();self.entities=entities;self.validator=validator

    def directory(self,owner):
        if not re.fullmatch(r'[\w-]{1,60}',owner):raise ValueError('账号标识不正确')
        path=self.base/'accounts'/owner
        if not path.resolve().is_relative_to(self.base):raise ValueError('备份目录不正确')
        return path

    def export(self,owner):
        root=self.documents.data/'users'/owner
        data={name:self.documents.read(root/(name+'.json'),{} if name in ('settings','preferences','control','avatar') else []) for name in self.entities}
        data['avatar']=self.documents.read(root/'avatar.json',{})
        return dict(format='personal-workbench-backup',formatVersion=2,schemaVersion=2,user=owner,exportedAt=stamp(),data=data,library=self.prompts.snapshot(owner))

    def make(self,owner,reason='manual'):
        folder=self.directory(owner);folder.mkdir(parents=True,exist_ok=True)
        filename='account-'+str(time.time_ns())+'-'+uuid.uuid4().hex[:8]+'.zip'
        with zipfile.ZipFile(folder/filename,'w',zipfile.ZIP_DEFLATED) as z:
            z.writestr('account.json',encode(self.export(owner)))
        for old in sorted(folder.glob('account-*.zip'))[:-10]:old.unlink()
        return filename

    def list(self,owner):
        folder=self.directory(owner)
        return [dict(file=p.name,size=p.stat().st_size,at=p.stat().st_mtime,scope='account') for p in sorted(folder.glob('account-*.zip'),reverse=True)]

    def restore_file(self,owner,filename):
        if not isinstance(filename,str) or not re.fullmatch(r'account-\d+-[a-f0-9]{8}\.zip',filename):raise ValueError('此备份不属于当前账号')
        file=self.directory(owner)/filename
        if not file.is_file():raise ValueError('备份不存在')
        with zipfile.ZipFile(file) as z:
            if z.getinfo('account.json').file_size>100*1024*1024:raise ValueError('备份过大')
            payload=json.loads(z.read('account.json'))
        if payload.get('user')!=owner:raise ValueError('此备份不属于当前账号')
        return self.restore(owner,payload)

    def restore(self,owner,envelope):
        if not isinstance(envelope,dict) or envelope.get('format')!='personal-workbench-backup' or envelope.get('formatVersion',99) not in (1,2) or envelope.get('schemaVersion',0)>2:raise ValueError('不支持的备份格式')
        if envelope.get('user')!=owner:raise ValueError('备份账号与当前登录账号不一致')
        data=envelope.get('data',{})
        if not isinstance(data,dict) or set(data)-set(self.entities)-{'avatar'}:raise ValueError('备份包含不支持的资料')
        self.validator(data)
        if data.get('avatar'):
            avatar=data['avatar']
            if not isinstance(avatar,dict) or len(avatar.get('png',''))>2*1024*1024:raise ValueError('头像资料不正确')
            raw=base64.b64decode(avatar.get('png',''),validate=True)
            if not raw.startswith(b'\x89PNG\r\n\x1a\n'):raise ValueError('头像格式不正确')
            import io
            from PIL import Image
            try:
                with Image.open(io.BytesIO(raw)) as image:
                    if image.format!='PNG' or image.size!=(256,256) or getattr(image,'is_animated',False):raise ValueError('备份头像不是标准化图片')
                    image.load();normalized=image.convert('RGB');normalized.info.clear();out=io.BytesIO();normalized.save(out,format='PNG');avatar['png']=base64.b64encode(out.getvalue()).decode()
            except OSError:raise ValueError('备份头像无法读取') from None
        root=self.documents.data/'users'/owner
        if data.get('control'):
            for name,rows in data['control'].get('resources',{}).items():
                for row in rows:row['enabled']=False
            data['control'].get('config',{})['memoryEnabled']=False
        self.make(owner,'pre-restore')
        paths=[root/(name+'.json') for name in data];old={p:p.read_bytes() if p.exists() else None for p in paths};changed=[]
        with self.documents.lock:
            try:
                with self.documents.connect() as db:
                    if 'library' in envelope:self.prompts.restore(owner,envelope['library'],db)
                    if data.get('control'):self.prompts.migrate_commands(owner,data['control'],db)
                    for name,value in data.items():
                        path=root/(name+'.json');self.documents._put(db,self.documents.namespace(path),name,value)
                    for name,value in data.items():
                        path=root/(name+'.json');self.documents.mirror(path,value);changed.append(path)
            except Exception:
                for p in changed:
                    if old[p] is None:p.unlink(missing_ok=True)
                    else:p.write_bytes(old[p])
                raise
        return dict(ok=True,restored=len(data),scope='account')
