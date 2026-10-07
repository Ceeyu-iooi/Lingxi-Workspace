"""Local profile moves; SQLite backup, evidence verification and atomic locator."""
from contextlib import closing
from pathlib import Path
import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
import uuid

def atomic_json(path, value):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    tmp=path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp')
    with tmp.open('w',encoding='utf-8') as file:
        json.dump(value,file,ensure_ascii=False);file.flush();os.fsync(file.fileno())
    os.replace(tmp,path)

def layout(root):
    root=Path(root).resolve()
    return dict(root=str(root),data=str(root/'data'),db=str(root/'accounts.db'),backups=str(root/'backups'))

def web_layout(code):
    config=Path(code)/'.runtime/web-profile.json'
    if not config.exists():config=Path(code)/'.web-profile.json'
    if config.exists():return layout(json.loads(config.read_text(encoding='utf-8'))['root'])
    if (Path(code)/'accounts.db').exists():return layout(code)
    return layout(Path(code)/'profile')

def environment(profile):
    return {'WORKBENCH_DATA':profile['data'],'WORKBENCH_DB':profile['db'],'WORKBENCH_BACKUPS':profile['backups'],'WORKBENCH_PROFILE':profile['root']}

def digest(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as file:
        for block in iter(lambda:file.read(1024*1024),b''):h.update(block)
    return h.hexdigest()

def entries(root,desktop=False):
    root=Path(root).resolve();result=[]
    for name in ['accounts.db','data','backups','config','logs','runtime','updates']+(['workspace','browser'] if desktop else []):
        start=root/name
        if not start.exists():continue
        candidates=[start] if start.is_file() else [start,*start.rglob('*')]
        for p in candidates:
            if p.is_symlink() or p.is_junction():raise ValueError('资料包含目录链接，不能迁移')
            if not p.resolve().is_relative_to(root):raise ValueError('资料路径越界')
            if not p.is_file():continue
            if p.name.endswith(('-wal','-shm')) or p.name in ('.service.lock','.maintenance-request.json','migration-journal.json','lockfile','SingletonLock','SingletonCookie','SingletonSocket'):continue
            if 'browser' in p.relative_to(root).parts and any(x in p.relative_to(root).parts for x in ('Cache','Code Cache','GPUCache','ShaderCache','GrShaderCache','DawnGraphiteCache','DawnWebGPUCache')):continue
            result.append(p)
    return result

def preflight(source,target,desktop=False):
    source=Path(source).resolve();requested=Path(target)
    if not requested.is_absolute():raise ValueError('请选择绝对资料路径')
    for p in [requested,*requested.parents]:
        if p.exists() and (p.is_symlink() or p.is_junction()):raise ValueError('目标不能是目录链接')
    target=requested.resolve()
    if target==source or target.is_relative_to(source) or source.is_relative_to(target):raise ValueError('目标不能与原资料目录相互包含')
    if target.exists() and (not target.is_dir() or any(target.iterdir())):raise ValueError('目标必须是空文件夹，不能合并已有资料')
    parent=target.parent
    while not parent.exists():parent=parent.parent
    files=entries(source,desktop);size=sum(p.stat().st_size for p in files)
    if shutil.disk_usage(parent).free<size+64*1024*1024:raise ValueError('目标磁盘空间不足')
    # Windows os.access can report writable despite an ACL denial. tempfile
    # retries those denials up to TMP_MAX; a unique exclusive probe fails fast.
    probe=parent/('.wb-write-probe-'+uuid.uuid4().hex)
    try:
        with probe.open('xb'):pass
        probe.unlink()
    except OSError:raise ValueError('目标目录不可写，请选择其他目录') from None
    return dict(source=str(source),target=str(target),bytes=size,files=len(files),desktop=desktop)

def migrate(source,target,desktop=False):
    plan=preflight(source,target,desktop);source=Path(plan['source']);target=Path(plan['target'])
    # Lifetime lock proves all writers have stopped; never copy a live profile.
    from workbench.shared_runtime import ProfileLock
    try:lock=ProfileLock(source/'data')
    except (SystemExit,PermissionError):raise ValueError('原资料目录仍有后台写入，未进行迁移') from None
    stage=target.with_name(target.name+'.migrating-'+uuid.uuid4().hex)
    manifest=[]
    try:
        stage.mkdir(parents=True)
        for src in entries(source,desktop):
            rel=src.relative_to(source);dest=stage/rel;dest.parent.mkdir(parents=True,exist_ok=True)
            with src.open('rb') as f:is_sqlite=f.read(16)==b'SQLite format 3\x00'
            if is_sqlite:
                with closing(sqlite3.connect(src.as_uri()+'?mode=ro',uri=True)) as db,closing(sqlite3.connect(dest)) as out:db.backup(out)
                with closing(sqlite3.connect(dest)) as db:
                    if db.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise ValueError('迁移数据库完整性错误')
            else:shutil.copy2(src,dest)
            manifest.append(dict(path=str(rel),sourceDigest=digest(src),targetDigest=digest(dest)))
            if not is_sqlite and manifest[-1]['sourceDigest']!=manifest[-1]['targetDigest']:raise ValueError('迁移文件摘要不一致')
        identity=json.loads((stage/'data/.shared-service.json').read_text(encoding='utf-8'))
        atomic_json(stage/'data/migration-journal.json',dict(source=str(source),target=str(target),identity=identity,files=manifest,oldRetained=True))
        if target.exists():target.rmdir()
        os.replace(stage,target)
        return dict(**plan,profileId=identity['profileId'],oldRetained=True)
    except BaseException:
        # Keep staging evidence on failure; caller never changes its locator.
        raise
    finally:lock.close()

def remove_old(current):
    current=Path(current).resolve();journal=current/'data/migration-journal.json'
    state=json.loads(journal.read_text(encoding='utf-8'));source=Path(state['source']).resolve()
    if str(current)!=state['target'] or json.loads((current/'data/.shared-service.json').read_text())!=state['identity']:raise ValueError('迁移身份不一致')
    from workbench.shared_runtime import ProfileLock
    lock=ProfileLock(source/'data');removed=0;changed=[]
    try:
        for item in state['files']:
            relative=Path(item['path'])
            if relative.is_absolute() or '..' in relative.parts or relative.parts[0] not in ('accounts.db','data','backups','config','logs','runtime','updates','workspace','browser'):raise ValueError('迁移清单越界')
            p=source/relative;new=current/relative
            if p.is_symlink() or p.is_junction() or not p.resolve().is_relative_to(source):raise ValueError('原资料路径已变化')
            if not p.exists():continue
            if digest(p)!=item['sourceDigest'] or not new.exists():changed.append(str(relative));continue
            p.unlink();removed+=1
        state['oldRetained']=bool(changed);atomic_json(journal,state)
        return dict(removed=removed,changed=changed,oldRetained=bool(changed))
    finally:lock.close()

def compact_profile(root):
    """Only between service lifetimes; evidence compression + safe page reclaim."""
    from contextlib import contextmanager
    from workbench.shared_runtime import ProfileLock
    from workbench import storage_cache
    root=Path(root).resolve();database=root/'data/storage/ai-monitor.sqlite'
    if not database.exists():return dict(beforeBytes=0,afterBytes=0)
    lock=ProfileLock(root/'data');before=database.stat().st_size
    class Monitor:
        @contextmanager
        def db(self):
            with closing(sqlite3.connect(database,timeout=20)) as db:
                db.row_factory=sqlite3.Row
                with db:yield db
    try:
        monitor=Monitor()
        with monitor.db() as db:
            tables={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if {'radar_days','radar_observations','radar_values'}.issubset(tables):storage_cache.migrate(monitor)
        with closing(sqlite3.connect(database,timeout=20)) as db:
            if db.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise ValueError('资料库完整性检查未通过，未回收空间')
            db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
            pages=db.execute('PRAGMA page_count').fetchone()[0];free=db.execute('PRAGMA freelist_count').fetchone()[0]
            if pages and free/pages>.15:db.execute('VACUUM')
            if db.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise ValueError('回收空间后的完整性检查未通过')
        return dict(beforeBytes=before,afterBytes=database.stat().st_size)
    finally:lock.close()

def consolidate_legacy(code):
    """One narrowly scoped migration from the old code root into root/profile."""
    code=Path(code).resolve();target=code/'profile'
    if not (code/'accounts.db').exists():
        return dict(status='already-consolidated',root=str(target))
    if target.exists() and any(target.iterdir()):raise ValueError('profile已有资料，拒绝合并旧根目录')
    from workbench.shared_runtime import ProfileLock
    lock=ProfileLock(code/'data');stage=code/'.runtime'/('profile-staging-'+uuid.uuid4().hex)
    manifest=[]
    try:
        stage.mkdir(parents=True)
        for src in entries(code):
            rel=src.relative_to(code);dest=stage/rel;dest.parent.mkdir(parents=True,exist_ok=True)
            with src.open('rb') as file:is_sqlite=file.read(16)==b'SQLite format 3\0'
            if is_sqlite:
                with closing(sqlite3.connect(src.as_uri()+'?mode=ro',uri=True)) as db,closing(sqlite3.connect(dest)) as out:db.backup(out)
                with closing(sqlite3.connect(dest)) as db:
                    if db.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise ValueError('归整数据库完整性检查失败')
            else:shutil.copy2(src,dest)
            manifest.append(dict(path=str(rel),sourceDigest=digest(src),targetDigest=digest(dest)))
            if not is_sqlite and manifest[-1]['sourceDigest']!=manifest[-1]['targetDigest']:raise ValueError('归整文件摘要不一致')
        import zipfile
        recovery=stage/'data/storage/recovery';recovery.mkdir(parents=True,exist_ok=True)
        baseline=recovery/'latest-v0.0.29.zip'
        with zipfile.ZipFile(baseline,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as archive:
            files=[]
            for file in stage.rglob('*'):
                if not file.is_file() or file.is_relative_to(recovery):continue
                rel=str(file.relative_to(stage));archive.write(file,rel);files.append(dict(path=rel,sha256=digest(file)))
            archive.writestr('manifest.json',json.dumps(dict(version='0.0.29',files=files),ensure_ascii=False))
        with zipfile.ZipFile(baseline) as archive:
            if archive.testzip() is not None:raise ValueError('归整恢复副本损坏')
        for file in recovery.iterdir():
            if file.is_file() and file!=baseline:file.unlink()
        identity=json.loads((stage/'data/.shared-service.json').read_text(encoding='utf8'))
        atomic_json(stage/'data/legacy-consolidation.json',dict(source=str(code),target=str(target),identity=identity,files=manifest))
        for name in ('config','logs','runtime','workspace'): (stage/name).mkdir(exist_ok=True)
        if target.exists():target.rmdir()
        os.replace(stage,target)
        atomic_json(code/'.runtime/web-profile.json',dict(root=str(target)))
        return dict(status='complete',root=str(target),profileId=identity['profileId'],files=len(manifest),oldRetained=True)
    finally:lock.close()

def cleanup_legacy(code):
    """After live acceptance, remove only unchanged files in the migration list."""
    code=Path(code).resolve();current=code/'profile'
    state=json.loads((current/'data/legacy-consolidation.json').read_text(encoding='utf8'))
    if state['source']!=str(code) or state['target']!=str(current):raise ValueError('归整身份不一致')
    if json.loads((current/'data/.shared-service.json').read_text())!=state['identity']:raise ValueError('归整身份变化')
    import zipfile
    with zipfile.ZipFile(current/'data/storage/recovery/latest-v0.0.29.zip') as archive:
        if archive.testzip() is not None:raise ValueError('恢复副本检查失败')
    from workbench.shared_runtime import ProfileLock
    lock=ProfileLock(code/'data');removed=0
    try:
        for item in state['files']:
            rel=Path(item['path']);p=code/rel;new=current/rel
            if rel.is_absolute() or '..' in rel.parts or rel.parts[0] not in ('accounts.db','data','backups'):raise ValueError('归整清理清单越界')
            if not p.resolve().is_relative_to(code) or p.is_symlink() or p.is_junction():raise ValueError('旧资料路径变化')
            if not p.exists():continue
            replaced_recovery=p.is_relative_to(code/'data/storage/recovery')
            if digest(p)!=item['sourceDigest'] or not (new.exists() or replaced_recovery):raise ValueError('旧资料已变化，停止清理')
            p.unlink();removed+=1
    finally:lock.close()
    for root in (code/'data',code/'backups'):
        lockfile=root/'.service.lock'
        if lockfile.exists():lockfile.unlink()
        for directory in sorted((p for p in root.rglob('*') if p.is_dir()),key=lambda p:len(p.parts),reverse=True):
            if not any(directory.iterdir()):directory.rmdir()
        if root.exists() and not any(root.iterdir()):root.rmdir()
    return dict(removed=removed)

def select_profile(target,bootstrap=None):
    requested=Path(target)
    if not requested.is_absolute():raise ValueError('请选择绝对资料路径')
    for candidate in [requested,*requested.parents]:
        if candidate.exists() and (candidate.is_symlink() or candidate.is_junction()):raise ValueError('资料路径不能包含目录链接')
    root=requested.resolve()
    if root.exists() and not root.is_dir():raise ValueError('资料位置必须是文件夹')
    existing=(root/'accounts.db').is_file() and (root/'data/.shared-service.json').is_file()
    if root.exists() and any(root.iterdir()) and not existing:
        is_bootstrap=bootstrap is not None and root==Path(bootstrap).resolve()
        if not is_bootstrap or any(p.name not in ('updates','browser','logs','runtime') for p in root.iterdir()):raise ValueError('请选择空文件夹或已有灵犀 Profile；不能合并其他资料')
    if existing:
        marker=json.loads((root/'data/.shared-service.json').read_text(encoding='utf-8'))
        uuid.UUID(marker['profileId']);uuid.UUID(marker['serviceId'])
        with closing(sqlite3.connect((root/'accounts.db').as_uri()+'?mode=ro',uri=True)) as db:
            if db.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise ValueError('所选账户数据库校验失败')
        from workbench.shared_runtime import ProfileLock
        try:lock=ProfileLock(root/'data')
        except (SystemExit,PermissionError):raise ValueError('所选 Profile 正在使用，请先关闭对应应用') from None
        lock.close()
    root.mkdir(parents=True,exist_ok=True);probe=root/('.wb-select-'+uuid.uuid4().hex)
    try:
        with probe.open('xb'):pass
        probe.unlink()
    except OSError:raise ValueError('资料位置不可写，请选择其他文件夹') from None
    return dict(root=str(root),existing=existing)

def main(args=None):
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['preflight','migrate','remove-old','compact','select']);parser.add_argument('--source');parser.add_argument('--target',required=True);parser.add_argument('--desktop',action='store_true')
    a=parser.parse_args(args)
    value=select_profile(a.target,a.source) if a.action=='select' else compact_profile(a.target) if a.action=='compact' else remove_old(a.target) if a.action=='remove-old' else (preflight if a.action=='preflight' else migrate)(a.source,a.target,a.desktop)
    print(json.dumps(value,ensure_ascii=False))

if __name__=='__main__':main()
