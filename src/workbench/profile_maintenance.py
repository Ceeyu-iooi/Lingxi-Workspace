"""Maintenance capabilities are minted by the local host, never by a login."""
from pathlib import Path
import hmac
import json
import os
import time
from workbench.profile_store import atomic_json, layout, preflight

def authorized(handler, code):
    if handler.client_address[0] not in ('127.0.0.1','::1'):return False
    if handler.headers.get('Host') != '127.0.0.1:'+str(handler.server.server_address[1]):return False
    if handler.headers.get('Origin','http://'+handler.headers.get('Host','')) != 'http://'+handler.headers.get('Host',''):return False
    token=os.environ.get('WORKBENCH_MAINTENANCE_TOKEN','');expiry=float(os.environ.get('WORKBENCH_MAINTENANCE_EXPIRES','0'))
    if not token:
        try:
            from workbench.profile_store import web_layout
            value=json.loads((Path(web_layout(code)['root'])/'config/maintenance.json').read_text());token=value['token'];expiry=value['expires']
        except (OSError,KeyError,ValueError):return False
    return bool(token) and time.time()<expiry and hmac.compare_digest(handler.headers.get('X-Workbench-Maintenance',''),token)

def size(path):
    p=Path(path)
    if not p.exists():return 0
    if p.is_file():return p.stat().st_size
    return sum(f.stat().st_size for f in p.rglob('*') if f.is_file() and not f.is_symlink())

def storage(services, root):
    services.pricing.setup()
    with services.monitor.db() as db:
        blobs=db.execute('SELECT coalesce(sum(length(body)),0),coalesce(sum(raw_size),0) FROM evidence_blobs').fetchone()
        derived=db.execute('SELECT coalesce(sum(length(cast(result as blob))),0) FROM radar_values').fetchone()[0]
    data=Path(root)/'data'
    categories=[dict(id=k,label=v,bytes=0) for k,v in [('databases','数据库'),('backups','备份'),('browser','浏览器资料'),('updates','更新安装包'),('logs','日志与崩溃记录'),('other','其他资料')]]
    totals={row['id']:row for row in categories};incomplete=False
    def failed(_error):
        nonlocal incomplete
        incomplete=True
    for directory,folders,files in os.walk(root,followlinks=False,onerror=failed):
        parent=Path(directory)
        folders[:]=[name for name in folders if not (parent/name).is_symlink() and not (parent/name).is_junction()]
        for name in files:
            file=parent/name
            if file.is_symlink():continue
            try:
                parts=file.relative_to(root).parts
                if parts[0]=='backups' or parts[:3]==('data','storage','recovery'):kind='backups'
                elif parts[0]=='browser':kind='browser'
                elif parts[0]=='updates':kind='updates'
                elif parts[0]=='logs' or parts[:2]==('runtime','crashes'):kind='logs'
                elif name.lower().endswith(('.db','.sqlite','.sqlite3','.db-wal','.db-shm','.sqlite-wal','.sqlite-shm','.sqlite3-wal','.sqlite3-shm')):kind='databases'
                else:kind='other'
                totals[kind]['bytes']+=file.stat().st_size
            except (OSError,ValueError):incomplete=True
    return dict(totalBytes=sum(row['bytes'] for row in categories),categories=categories,incomplete=incomplete,databaseBytes=size(services.monitor.path),businessBytes=size(data),priceEvidenceCompressedBytes=blobs[0],priceEvidenceRawBytes=blobs[1],valuationPayloadBytes=derived,backupsBytes=size(Path(root)/'backups')+size(data/'storage/recovery'),browserCacheBytes=sum(size(Path(root)/'browser'/p) for p in ('Cache','Code Cache','GPUCache')),responseCacheBytes=services.monitor.snapshot_cache.bytes,responseCacheBudget=services.monitor.snapshot_cache.budget,compression=getattr(services.pricing,'migration',{'status':'idle'}))

def dispatch(handler,services,code,root,route,body=None):
    if route not in ('/api/profile/storage','/api/profile/location','/api/profile/preflight','/api/profile/migrate','/api/profile/maintenance','/api/profile/clear-cache','/api/profile/remove-old'):return False
    user=handler._require_user()
    if not user:return True
    permitted=authorized(handler,code);root=Path(root)
    if route=='/api/profile/storage':handler._json(storage(services,root));return True
    if route=='/api/profile/clear-cache':
        if body is None:raise ValueError('清理须显式提交')
        owner=user['username']
        # Refuse concurrent network preparation, so it cannot re-enable stale state.
        with services.valuation_tasks.lock:
            if any(services.valuation_tasks.status(owner,s).get('status')=='running' for s in ('codex','zcode','dsh')):raise ValueError('请先取消正在进行的计价准备')
            for scope in ('codex','zcode','dsh'):services.valuation_tasks.disable(owner,scope)
            with services.monitor.db() as db:db.execute('DELETE FROM radar_values WHERE owner=?',(owner,))
            with services.monitor.cache_lock:
                services.monitor.snapshot_cache.clear();services.monitor.datasets={};services.monitor.coverage_cache={}
        handler._json(dict(ok=True,features=services.features(owner),evidenceRetained=True));return True
    if route=='/api/profile/location':
        result=dict(managementAvailable=permitted,managed=bool(os.environ.get('WORKBENCH_MANAGED_WEB') or os.environ.get('WORKBENCH_DESKTOP')),desktop=os.environ.get('WORKBENCH_DESKTOP')=='1')
        if permitted:
            result.update(layout(root));journal=root/'data/migration-journal.json'
            if journal.exists():
                j=json.loads(journal.read_text());result['previous']=dict(path=j['source'],retained=j['oldRetained'])
        handler._json(result);return True
    if not permitted:raise PermissionError('需本机维护入口授权；普通账号不能迁移全局资料')
    request=root/'data/.maintenance-request.json'
    if route=='/api/profile/maintenance':
        handler._json(json.loads(request.read_text()) if request.exists() else dict(status='idle'));return True
    if body is None:raise ValueError('迁移须显式提交')
    if route=='/api/profile/remove-old':
        if not os.environ.get('WORKBENCH_MANAGED_WEB') or body.get('confirm') is not True:raise ValueError('需受控启动并明确确认')
        atomic_json(request,dict(status='queued',action='remove-old',created=time.time()))
        handler._json(dict(status='queued'));return True
    target=body.get('target','');plan=preflight(root,target,os.environ.get('WORKBENCH_DESKTOP')=='1')
    if route=='/api/profile/preflight':handler._json(plan);return True
    if not os.environ.get('WORKBENCH_MANAGED_WEB'):raise ValueError('网页迁移请先使用 python run_web.py 启动受控后台；桌面请使用原生迁移入口')
    if body.get('confirm') is not True:raise ValueError('请确认暂停后台并迁移全部账户资料')
    if request.exists() and json.loads(request.read_text()).get('status') in ('queued','running'):raise ValueError('已有迁移任务')
    atomic_json(request,dict(status='queued',action='migrate',target=plan['target'],created=time.time()))
    handler._json(dict(status='queued',restartRequired=True));return True
