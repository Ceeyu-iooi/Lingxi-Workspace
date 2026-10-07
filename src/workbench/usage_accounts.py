"""Read-only official account adapters; snapshots are never added to request totals."""
import json
import os
import queue
import shutil
import subprocess
import threading
import time
import uuid
import re
import ipaddress
import hashlib
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib import request, error
from urllib.parse import urlsplit, urlencode
from datetime import datetime, timedelta, timezone

from workbench.ai_monitor import iso
from workbench.ai_control import valid_id
from workbench.provider_adapters import PRESETS,RELAY_KINDS


class AccountUnavailable(ValueError):
    pass


class CodexRPC:
    def __init__(self):
        explicit = os.environ.get('CODEX_CLI_PATH')
        exe = explicit or shutil.which('codex.exe')
        if exe and Path(exe).is_file():
            command = [exe, 'app-server']
        else:
            launcher = shutil.which('codex')
            node = shutil.which('node')
            script = Path(launcher).parent/'node_modules'/'@openai'/'codex'/'bin'/'codex.js' if launcher else None
            if not node or not script or not script.is_file():
                raise AccountUnavailable('未找到 Codex CLI，请安装官方 CLI 并完成 ChatGPT 登录后重试')
            command = [node, str(script), 'app-server']
        child_env=dict(os.environ)
        # Windows sandbox children otherwise resolve another account's empty home.
        child_env['CODEX_HOME']=os.environ.get('CODEX_HOME') or str(Path.home()/'.codex')
        self.process = subprocess.Popen(command, env=child_env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        self.messages = queue.Queue(maxsize=64)
        self.sequence = 0
        self.thread = threading.Thread(target=self._read, daemon=True)
        self.thread.start()
        try:
            self.call('initialize', {'clientInfo': {'name':'workbench_usage','version':'1.0.0'}})
            self._send({'method':'initialized'})
        except Exception:
            self.close()
            raise

    def _read(self):
        for line in iter(self.process.stdout.readline, b''):
            try:
                value = json.loads(line)
                if isinstance(value, dict) and 'id' in value:
                    self.messages.put_nowait(value)
            except (ValueError, queue.Full):
                continue
        try:self.messages.put_nowait(None)
        except queue.Full:pass

    def _send(self, value):
        try:
            self.process.stdin.write((json.dumps(value)+'\n').encode())
            self.process.stdin.flush()
        except (OSError, ValueError):raise AccountUnavailable('Codex 查询进程已退出，请检查 CLI 是否可运行')

    def call(self, method, params=None):
        self.sequence += 1
        identity = self.sequence
        self._send({'id':identity, 'method':method, 'params':params or {}})
        deadline = time.monotonic()+12
        while time.monotonic()<deadline:
            try:value = self.messages.get(timeout=max(.01,deadline-time.monotonic()))
            except queue.Empty:break
            if value is None:raise AccountUnavailable('Codex 查询进程已退出，请检查 CLI 和登录状态')
            if value.get('id')!=identity:continue
            if 'error' in value:
                code = value['error'].get('code') if isinstance(value['error'],dict) else None
                raise AccountUnavailable('当前 Codex 版本不支持此接口，请更新官方 CLI' if code==-32601 else 'Codex 暂未返回此项数据，请检查 ChatGPT 登录状态后重试')
            return value.get('result') or {}
        raise AccountUnavailable('Codex 查询超时，请稍后重试')

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:self.process.kill();self.process.wait(timeout=2)
        for stream in (self.process.stdin,self.process.stdout):
            if stream:stream.close()


class UsageAccounts:
    def __init__(self, monitor, control, rpc_factory=CodexRPC):
        self.monitor, self.control, self.rpc_factory = monitor, control, rpc_factory
        self.lock = threading.RLock()
        self.busy = set()
        self.ready = False
        self.snapshot_cache = {}

    def initialize(self):
        with self.lock:
            if self.ready:return
            self.monitor.initialize()
            with self.monitor.db() as db:
                db.execute('CREATE TABLE IF NOT EXISTS usage_connections(owner TEXT,id TEXT,value TEXT,PRIMARY KEY(owner,id))')
                db.execute('CREATE TABLE IF NOT EXISTS usage_bindings(resource TEXT PRIMARY KEY,owner TEXT NOT NULL)')
                db.execute('CREATE TABLE IF NOT EXISTS provider_buckets(owner TEXT,connection_id TEXT,id TEXT,record TEXT,PRIMARY KEY(owner,connection_id,id))')
                db.execute('CREATE TABLE IF NOT EXISTS provider_call_buckets(owner TEXT,connection_id TEXT,at TEXT,count INTEGER,PRIMARY KEY(owner,connection_id,at))')
                db.execute('CREATE TABLE IF NOT EXISTS provider_versions(owner TEXT PRIMARY KEY,version INTEGER)')
                for table in ('usage_connections','provider_buckets','provider_call_buckets'):
                    for operation,prefix in (('INSERT','NEW'),('UPDATE','NEW'),('DELETE','OLD')):
                        db.execute('CREATE TRIGGER IF NOT EXISTS provider_version_'+table+'_'+operation+' AFTER '+operation+' ON '+table+' BEGIN INSERT INTO provider_versions VALUES('+prefix+'.owner,1) ON CONFLICT(owner) DO UPDATE SET version=version+1; END')
            self.ready=True

    def _rows(self, owner):
        self.initialize()
        with self.monitor.db() as db:
            return [json.loads(r[0]) for r in db.execute('SELECT value FROM usage_connections WHERE owner=?',(owner,))]

    def codex_snapshot(self,owner,days=30,**params):
        from workbench.account_activity import snapshot
        source=params.pop('source','');params.pop('scope',None)
        attributed=any(params.get(k) for k in ('model','models','project','provider','connection_id'))
        if source not in ('','official','codex'):raise ValueError('Codex 来源不受支持')
        if source=='official' and attributed:raise ValueError('官方账户没有模型和工作区明细，请选择本机日志后筛选')
        if source=='codex' or attributed:
            result=self.monitor.browser_snapshot(owner,days,source='codex',scope='codex',**params)
            result['options']['source']=['official','codex']
            return result
        row=next((r for r in self._rows(owner) if r['kind']=='codex'),{}) if self.codex_bound(owner) else {}
        cached=row.get('snapshot') or {}
        try:
            result=snapshot(cached.get('tokenActivity'),days,error=(cached.get('unavailable') or {}).get('tokenActivity') or row.get('error',''),observed=row.get('lastSuccessAt',''),**params)
            if result['available'] and row.get('error'):
                result['dataSource']['stale']=True;result['dataSource']['message']='上次成功的官方活动快照；最新同步失败，请重试 · '+result['dataSource']['message']
            return result
        except (ValueError,KeyError,TypeError):return snapshot(None,days,error='官方活动数据未通过结构校验，未使用本机记录补数',**params)

    def _write(self, owner, row):
        with self.monitor.db() as db:
            db.execute('INSERT OR REPLACE INTO usage_connections VALUES(?,?,?)',(owner,row['id'],json.dumps(row,ensure_ascii=False)))

    def claim_codex(self, owner, root):
        """A local installation and its logs have one explicitly bound workbench owner."""
        self.initialize()
        root = str(Path(root).resolve()).casefold()
        with self.lock,self.monitor.db() as db:
            db.execute('BEGIN IMMEDIATE')
            for resource in ('codex-account', 'codex-logs:'+root):
                row=db.execute('SELECT owner FROM usage_bindings WHERE resource=?',(resource,)).fetchone()
                if row and row[0]!=owner:raise ValueError('本机 Codex 已绑定其他工作台账户，不能读取该账户的本机信息')
                db.execute('INSERT OR IGNORE INTO usage_bindings VALUES(?,?)',(resource,owner))

    def codex_bound(self, owner):
        self.initialize()
        with self.monitor.db() as db:
            row=db.execute("SELECT owner FROM usage_bindings WHERE resource='codex-account'").fetchone()
        return bool(row and row[0]==owner)

    def claim_dsh(self,owner,root):
        self.initialize();resource='dsh-logs:'+str(Path(root).resolve()).casefold()
        with self.lock,self.monitor.db() as db:
            db.execute('BEGIN IMMEDIATE')
            prior=db.execute('SELECT owner FROM usage_bindings WHERE resource=?',(resource,)).fetchone()
            if prior and prior[0]!=owner:raise ValueError('Harness 日志已绑定其他工作台账户')
            db.execute('INSERT OR IGNORE INTO usage_bindings VALUES(?,?)',(resource,owner))

    def claim_zcode(self,owner):
        self.initialize()
        with self.lock,self.monitor.db() as db:
            db.execute('BEGIN IMMEDIATE')
            row=db.execute("SELECT owner FROM usage_bindings WHERE resource='zcode-logs'").fetchone()
            if row and row[0]!=owner:raise ValueError('本机 ZCode 已绑定其他工作台账户')
            db.execute('INSERT OR IGNORE INTO usage_bindings VALUES(?,?)',('zcode-logs',owner))

    def list(self, owner):
        keys=self.control.credentials(owner)
        result=[]
        for row in self._rows(owner):
            row=dict(row)
            row['configured']=row['kind']=='codex' or bool(keys.get('usage:'+row['id'])) or bool(keys.get('platform:'+row['id']) and row.get('keyTrackingId'))
            row['apiConfigured']=bool(keys.get('usage:'+row['id']))
            row['platformConfigured']=bool(keys.get('lmu:platform')) if row['kind']=='lmu' else bool(keys.get('platform:'+row['id']))
            row['relayConfigured']=bool(keys.get('relay:'+row['id']))
            row['stale']=bool(row.get('lastSuccessAt')) and time.time()-row.get('lastSuccessEpoch',0)>600
            result.append(row)
        return {'connections':result}

    @staticmethod
    def supplier_id(row):
        return row['kind'] if row['kind']!='custom' else 'custom:'+str(row.get('supplierName') or urlsplit(row['apiUrl']).hostname)

    def _match_deepseek_key(self, owner, key, platform=''):
        secrets=self.control.credentials(owner);candidates=[platform] if platform else []
        candidates+=list(dict.fromkeys(secrets.get('platform:'+r['id']) for r in self._rows(owner) if r['kind']=='deepseek' and secrets.get('platform:'+r['id'])))
        for credential in dict.fromkeys(candidates):
            try:
                data=self._provider_get('https://platform.deepseek.com/api/v0/users/get_api_keys','Bearer '+credential)
                if str(data.get('biz_code'))!='0':raise AccountUnavailable('平台登录已过期，请重新导入')
                entries=(data.get('biz_data') or {}).get('api_keys',[]);matches=[]
                for entry in entries:
                    masked=entry.get('sensitive_id') or ''
                    if len(masked.replace('*',''))<8:continue
                    if entry.get('api_key')==key or re.fullmatch(re.escape(masked).replace(r'\*','.'),key):matches.append(entry)
                if len(matches)==1 and matches[0].get('tracking_id'):return credential,str(matches[0]['tracking_id'])
                if len(matches)>1:raise AccountUnavailable('无法唯一识别此 Key，请选择对应的 Key 标识')
            except AccountUnavailable:
                if platform:raise
        return None,None

    def save(self, owner, body):
        self.initialize()
        with self.lock,self.control.lock:
            cid=valid_id(body.get('id') or uuid.uuid4().hex)
            previous=next((r for r in self._rows(owner) if r['id']==cid),None)
            if body.get('delete'):
                if previous and previous['kind']=='deepseek':self.control.provider(owner,{'id':'usage-agent-'+cid,'delete':True})
                keys=self.control.credentials(owner);keys.pop('usage:'+cid,None);keys.pop('relay:'+cid,None);keys.pop('platform:'+cid,None);self.control.save_credentials(owner,keys)
                with self.monitor.db() as db:
                    db.execute('DELETE FROM usage_connections WHERE owner=? AND id=?',(owner,cid))
                    db.execute('DELETE FROM provider_buckets WHERE owner=? AND connection_id=?',(owner,cid))
                    db.execute('DELETE FROM provider_call_buckets WHERE owner=? AND connection_id=?',(owner,cid))
                if previous and previous['kind']=='codex':
                    self.control.update_config(owner,{'codexEnabled':False})
                    with self.monitor.db() as db:db.execute('DELETE FROM usage_bindings WHERE owner=?',(owner,))
                return {'ok':True}
            if previous is None and len(self._rows(owner))>=20:raise ValueError('最多添加 20 个用量账户')
            kind=body.get('kind',previous.get('kind') if previous else None)
            if kind not in ('codex','deepseek','glm','custom','lmu',*PRESETS) or (previous and previous['kind']!=kind):raise ValueError('请选择有效的用量账户')
            defaults={'deepseek':'https://api.deepseek.com','glm':'https://open.bigmodel.cn/api/paas/v4','lmu':'https://api.lmuai.ai',**{k:v['url'] for k,v in PRESETS.items()}}
            api_url=str(body.get('apiUrl',previous.get('apiUrl') if previous else '') or defaults.get(kind,'')).rstrip('/')
            if kind in PRESETS:
                from workbench.provider_adapters import validate_url
                validate_url(kind,api_url)
            if kind not in ('codex','custom','lmu',*PRESETS):
                parsed=urlsplit(api_url)
                paths={'deepseek':('','/v1','/user/balance'),'glm':('','/api/paas/v4','/api/anthropic','/api/coding/paas/v4','/api/monitor/usage/model-usage')}
                hosts={'deepseek':('api.deepseek.com',),'glm':('open.bigmodel.cn','api.z.ai')}[kind]
                if parsed.scheme!='https' or parsed.netloc not in hosts or parsed.path not in paths[kind] or parsed.query or parsed.fragment:
                    raise ValueError('请填写所选平台的官方 HTTPS API URL，不支持代理地址、查询参数或重定向')
            if kind=='lmu' and api_url!='https://api.lmuai.ai':raise ValueError('LMU 仅支持官方 HTTPS 地址')
            if kind=='custom':self.validate_history_url(api_url)
            name=str(body.get('name',previous.get('name') if previous else '')).strip()
            if not name or len(name)>80:raise ValueError('账户名称需为 1–80 个字符')
            if 'enabled' in body and not isinstance(body['enabled'],bool):raise ValueError('自动同步开关必须为布尔值')
            if kind=='codex':
                if any(r['kind']=='codex' and r['id']!=cid for r in self._rows(owner)):raise ValueError('本机 Codex 已连接，请编辑已有连接')
            linked=str(body.get('providerId',previous.get('providerId','') if previous else ''))
            if linked:
                provider=next((p for p in self.control.state(owner)['providers'] if p['id']==linked),None)
                if kind!='deepseek' or not provider or provider['baseUrl'].rstrip('/') not in ('https://api.deepseek.com','https://api.deepseek.com/v1'):
                    raise ValueError('只能关联此账户下使用 DeepSeek 官方地址的模型服务')
            keys=self.control.credentials(owner)
            previous_key=keys.get('usage:'+cid)
            previous_platform=keys.get('platform:'+cid)
            key=str(body.get('apiKey') or '').strip()
            if len(key)>4096 or any(c in key for c in '\r\n'):raise ValueError('API Key 格式不正确')
            platform=re.sub(r'^(?:Bearer\s+)+','',str(body.get('platformToken') or '').strip(),flags=re.I)
            imported=str(body.get('platformImport') or '').strip()
            if imported:
                if len(imported)>20000:raise ValueError('导入内容过长')
                if 'https://platform.deepseek.com/' not in imported:raise ValueError('请复制 DeepSeek 官方平台的请求')
                match=re.search(r'Authorization\s*:\s*Bearer\s+([^\s\x22\x27]+)',imported,re.I)
                if not match:raise ValueError('未识别平台登录，请复制完整请求')
                platform=match.group(1)
            if len(platform)>8192 or any(c in platform for c in '\r\n'):raise ValueError('平台凭据格式不正确')
            tracking=str(body.get('keyTrackingId',(previous or {}).get('keyTrackingId',''))).strip()
            if kind=='deepseek' and key and previous_key and key!=previous_key and 'keyTrackingId' not in body:tracking=''
            if kind=='deepseek' and (key or previous_key) and not tracking and not body.get('clearPlatformToken'):
                matched_platform,matched_tracking=self._match_deepseek_key(owner,key or previous_key,platform)
                if matched_platform:platform=matched_platform;tracking=matched_tracking
            if tracking and not re.fullmatch(r'[A-Za-z0-9_-]{1,180}',tracking):raise ValueError('Key 标识格式不正确')
            if kind=='deepseek' and platform and not tracking:raise ValueError('平台中未找到对应 APIKey，请核对 Key 和登录账户')
            if kind=='codex':self.claim_codex(owner,self.control.public(owner)['defaultCodexPath'])
            if kind!='codex':
                if key:keys['usage:'+cid]=key
                elif not keys.get('usage:'+cid) and linked:keys['usage:'+cid]=keys.get(linked,'')
                if kind in ('deepseek','sub2api','newapi'):
                    if body.get('clearPlatformToken'):keys.pop('platform:'+cid,None)
                    elif platform:keys['platform:'+cid]=platform
                self.control.save_credentials(owner,keys)
            row={**(previous or {}),'id':cid,'kind':kind,'name':name,'providerId':linked,'apiUrl':api_url,
                 'supplierName':str(body.get('supplierName',(previous or {}).get('supplierName',''))).strip()[:60] if kind=='custom' else '',
                 'keyTrackingId':tracking if kind=='deepseek' else '', 'historyEnabled':kind in ('custom','lmu') or kind=='deepseek' and bool(keys.get('platform:'+cid) and tracking),
                 'capabilities':{'balance':kind in ('deepseek','glm','lmu'),'accountTokens':kind=='codex','quota':kind in ('codex','glm'),'modelTokens':kind in ('glm','deepseek','custom','lmu'),'historyQuery':kind in ('glm','custom','lmu') or bool(keys.get('platform:'+cid) and tracking),'responseTokens':kind=='deepseek'},
                 'enabled':body.get('enabled',True) is True}
            if kind in PRESETS:
                mode=body.get('credentialMode',(previous or {}).get('credentialMode','account' if kind=='sub2api' else 'key'))
                if mode not in ('key','account','subscription'):raise ValueError('凭据类型不正确')
                mapping=body.get('balanceMapping',(previous or {}).get('balanceMapping',{}))
                if not isinstance(mapping,dict) or len(json.dumps(mapping))>4000 or any(k not in ('endpoint','remainingPath','usedPath','totalPath','currency','divisor','authMode') for k in mapping):raise ValueError('余额字段映射不正确')
                row.update(credentialMode=mode,balanceMapping=mapping,userId=str(body.get('userId',(previous or {}).get('userId','')))[:100],quotaCurrency=body.get('quotaCurrency',(previous or {}).get('quotaCurrency','USD')))
                row['capabilities']={'balance':kind!='minimax','quota':kind in ('openrouter','newapi','minimax'),'modelTokens':False,'historyQuery':False,'responseTokens':kind in RELAY_KINDS and mode=='key'}
            row['revision']=uuid.uuid4().hex
            if previous and (key and key!=previous_key or platform and platform!=previous_platform or tracking!=previous.get('keyTrackingId','') or row['historyEnabled']!=previous.get('historyEnabled',False) or api_url!=previous.get('apiUrl')):
                row['error']='密钥已更新，请重新同步账户'
                row['resetOnSuccess']=True
                if kind in ('deepseek','custom','glm','lmu',*PRESETS):
                    with self.monitor.db() as db:
                        db.execute('DELETE FROM provider_buckets WHERE owner=? AND connection_id=?',(owner,cid))
                        db.execute('DELETE FROM provider_call_buckets WHERE owner=? AND connection_id=?',(owner,cid))
                    row.pop('lastTokenSuccessAt',None)
                    row.pop('snapshot',None)
            if kind=='lmu' and not keys.get('lmu:platform'):row['error']='请先授权 LMU 平台以查询历史用量'
            self._write(owner,row)
            if kind=='deepseek':
                agent_id='usage-agent-'+cid
                linked_agent=next((p for p in self.control.state(owner)['providers'] if p['id']==agent_id),None)
                if linked_agent:
                    changed=bool(key and previous and key!=previous_key)
                    self.control.provider(owner,{**linked_agent,'enabled':row['enabled'] and not changed,'clearKey':changed})
            # Make this owner discoverable by the existing background scheduler.
            self.control.save(owner,self.control.state(owner))
            return {'connection':next(r for r in self.list(owner)['connections'] if r['id']==cid)}

    def _deepseek(self, key):
        # Fixed official origin. Never forward credentials to a configurable URL or redirect.
        class NoRedirect(request.HTTPRedirectHandler):
            def redirect_request(self,*args,**kwargs):return None
        opener=request.build_opener(NoRedirect)
        def get(path):
            req=request.Request('https://api.deepseek.com'+path,headers={'Authorization':'Bearer '+key})
            try:
                with opener.open(req,timeout=10) as response:
                    raw=response.read(1024*1024+1)
                if len(raw)>1024*1024:raise AccountUnavailable('服务商响应过大')
                return json.loads(raw)
            except error.HTTPError as exc:
                raise AccountUnavailable({401:'API Key 无效或已过期',403:'API Key 没有查询权限',429:'服务商查询限流，请稍后重试'}.get(exc.code,'服务商查询失败，请稍后重试')) from None
            except (OSError,ValueError):raise AccountUnavailable('服务商连接失败或响应格式不正确') from None
        data=get('/user/balance')
        if not isinstance(data,dict) or not isinstance(data.get('balance_infos'),list) or not isinstance(data.get('is_available'),bool):raise AccountUnavailable('服务商余额响应格式不正确')
        balances=[]
        for raw in data['balance_infos']:
            if not isinstance(raw,dict) or raw.get('currency') not in ('CNY','USD'):raise AccountUnavailable('服务商余额币种不支持')
            entry={'currency':raw['currency']}
            for field in ('total_balance','granted_balance','topped_up_balance'):
                try:
                    value=Decimal(str(raw[field]))
                    if not value.is_finite():raise InvalidOperation()
                except (KeyError,InvalidOperation):raise AccountUnavailable('服务商余额响应格式不正确') from None
                entry[field]=str(value)
            balances.append(entry)
        models=[]
        try:
            result=get('/models')
            models=[str(r['id'])[:180] for r in result.get('data',[]) if isinstance(r,dict) and r.get('id')][:100]
        except (AccountUnavailable,AttributeError,TypeError,KeyError):pass
        return {'balances':balances,'available':data['is_available'],'models':models,'coverage':'仅来自 DeepSeek 官方 API；公开余额接口未提供历史 Token、模型用量或请求明细，不读取本机日志。','unavailable':{'tokens':'DeepSeek 公开 API 尚未提供历史 Token 查询接口'}}

    def _provider_get(self, url, key, unwrap=True):
        class NoRedirect(request.HTTPRedirectHandler):
            def redirect_request(self,*args,**kwargs):return None
        opener=request.build_opener(NoRedirect)
        headers={'Authorization':key,'Accept-Language':'en-US,en','Accept':'application/json','Content-Type':'application/json','User-Agent':'LingxiWorkbench/0.0.2'}
        if urlsplit(url).hostname=='platform.deepseek.com':headers.update({'Referer':'https://platform.deepseek.com/usage','x-client-platform':'web','x-client-version':'1.0.0','x-client-locale':'zh_CN','x-client-timezone-offset':'28800'})
        req=request.Request(url,headers=headers)
        try:
            with opener.open(req,timeout=15) as response:raw=response.read(2*1024*1024+1)
            if len(raw)>2*1024*1024:raise AccountUnavailable('平台响应超过大小限制')
            result=json.loads(raw)
            if isinstance(result,dict) and 'coding plan' in str(result.get('msg','')).lower():
                raise AccountUnavailable('该密钥所属用户没有 GLM Coding Plan；普通 API 请使用供应商历史用量接口')
            if not isinstance(result,dict) or result.get('success') is False or str(result.get('code','200')) not in ('0','200'):
                raise AccountUnavailable('平台未提供此项用量，请确认 API Key 所属套餐及查询权限')
            return result.get('data',result) if unwrap else result
        except error.HTTPError as exc:
            raise AccountUnavailable({401:'API Key 无效或已过期',403:'API Key 没有查询权限',429:'平台查询限流，请稍后重试'}.get(exc.code,'平台查询失败，请检查套餐及权限')) from None
        except AccountUnavailable:raise
        except (OSError,ValueError):raise AccountUnavailable('平台连接失败或响应格式不正确') from None

    def _glm_finance(self, row, key, owner=None):
        from workbench.provider_finance import glm_bills, amount
        now=datetime.now(timezone(timedelta(hours=8)));start=(now-timedelta(days=365)).date();cutoff=start.isoformat();archived=[]
        previous=row.get('snapshot') or {}
        if owner and previous.get('financeVersion')==1 and row.get('lastSuccessEpoch') and not row.get('resetOnSuccess'):
            last=datetime.fromtimestamp(row['lastSuccessEpoch'],now.tzinfo).date()
            cutoff=max(start,min((now-timedelta(days=30)).date(),last)).replace(day=1).isoformat()
            with self.monitor.db() as db:archived=[json.loads(r[0]) for r in db.execute('SELECT record FROM provider_buckets WHERE owner=? AND connection_id=?',(owner,row['id']))]
            archived=[r for r in archived if start.isoformat()<=datetime.fromisoformat(r['at'].replace('Z','+00:00')).astimezone(now.tzinfo).date().isoformat()<cutoff]
        month=now.date().replace(day=1);first=datetime.fromisoformat(cutoff).date().replace(day=1);bills=[]
        while month>=first:
            page=1;seen=set();records_seen=set();received=0
            while True:
                params=urlencode({'billingMonth':month.strftime('%Y-%m'),'pageNum':page,'pageSize':100,'billStatus':'','modelProductName':'','paymentType':''})
                raw=self._provider_get('https://bigmodel.cn/api/finance/expenseBill/expenseBillListByDay?'+params,key,False)
                entries=raw.get('rows');total=raw.get('total')
                if not isinstance(entries,list) or isinstance(total,bool) or not isinstance(total,int) or total<0:raise AccountUnavailable('GLM 每日账单响应格式不正确')
                fingerprint=json.dumps(entries,sort_keys=True)
                if received<total and (not entries or fingerprint in seen):raise AccountUnavailable('GLM 账单分页未完成')
                seen.add(fingerprint)
                for entry in entries:
                    record_key=json.dumps(entry,sort_keys=True)
                    if record_key in records_seen:raise AccountUnavailable('GLM 账单返回重复记录')
                    records_seen.add(record_key)
                bills.extend(entries);received+=len(entries)
                if len(bills)>10000 or page>100:raise AccountUnavailable('GLM 历史账单超过查询限制')
                if received>=total:break
                page+=1
            month=(month-timedelta(days=1)).replace(day=1)
        try:rows=glm_bills(bills,row,key)
        except ValueError:raise AccountUnavailable('GLM 账单未返回有效的模型 Token 或费用') from None
        rows=archived+[r for r in rows if start<=datetime.fromisoformat(r['at'].replace('Z','+00:00')).astimezone(now.tzinfo).date()<=now.date()]
        result={'historyRows':rows,'historyAvailable':True,'historyDays':366,'financeVersion':1,'coverage':'GLM 官方账单 · 所选 Key','unavailable':{}}
        try:
            report=self._provider_get('https://bigmodel.cn/api/biz/account/query-customer-account-report',key)
            balance=amount(report.get('availableBalance'));spent=amount(report.get('totalSpendAmount'))
            customer_ids={str(b.get('customerId')) for b in bills if b.get('apiKey') in (key,key.split('.')[0]) and b.get('customerId') is not None}
            result['accountFinance']={'currency':'CNY','balance':float(balance) if balance is not None else None,'spent':float(spent) if spent is not None else None,'accountRef':hashlib.sha256(('GLM:'+next(iter(customer_ids))).encode()).hexdigest() if len(customer_ids)==1 else None}
        except (AccountUnavailable,ValueError,AttributeError):result['unavailable']['balance']='账户余额暂未返回'
        return result

    def _glm(self, key, api_url='https://open.bigmodel.cn/api/paas/v4'):
        now=datetime.now(timezone(timedelta(hours=8)))
        # Official GLM Coding Plan usage plugin uses these read-only endpoints.
        params=urlencode({'startTime':(now-timedelta(days=1)).strftime('%Y-%m-%d %H:00:00'),'endTime':now.strftime('%Y-%m-%d %H:59:59')})
        result={'coverage':'来自 GLM 官方 Coding Plan 个人套餐用量接口。按官方插件查询近期时间窗口；历史范围依平台实际返回，不代表全账号累计或逐次请求。','unavailable':{}}
        for path,field in (('model-usage?'+params,'modelUsage'),('quota/limit','platformQuota')):
            try:result[field]=self._provider_get(('https://api.z.ai' if urlsplit(api_url).hostname=='api.z.ai' else 'https://open.bigmodel.cn')+'/api/monitor/usage/'+path,key)
            except AccountUnavailable as exc:result['unavailable'][field]=str(exc)
        if len(result['unavailable'])==2:raise AccountUnavailable(result['unavailable']['modelUsage'])
        return result

    @staticmethod
    def validate_history_url(url):
        parsed=urlsplit(url)
        if parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.password or parsed.fragment or parsed.port not in (None,443) or parsed.hostname.lower() in ('localhost','localhost.localdomain') or parsed.hostname.lower().endswith(('.local','.localhost')):
            raise ValueError('历史用量接口需为公开 HTTPS 地址，不包含登录凭据或重定向')
        try:
            if not ipaddress.ip_address(parsed.hostname).is_global:raise ValueError('不能使用内部网络地址')
        except ValueError as exc:
            if str(exc)=='不能使用内部网络地址':raise
        if re.search(r'(api_?key|token|secret)=',parsed.query,re.I):raise ValueError('密钥请填写在密钥栏，不放在 URL 中')
        return parsed

    def _history(self,row,key,owner=None):
        if row['kind']=='lmu':
            from workbench.provider_lmu import Client
            now=datetime.now(timezone(timedelta(hours=8)));start=(now-timedelta(days=365)).date();cutoff=start;archived=[]
            if row.get('snapshot',{}).get('lmuVersion')==1 and row.get('lastSuccessEpoch') and not row.get('resetOnSuccess'):
                cutoff=max(start,(now-timedelta(days=30)).date())
                with self.monitor.db() as db:archived=[json.loads(r[0]) for r in db.execute('SELECT record FROM provider_buckets WHERE owner=? AND connection_id=?',(owner,row['id']))]
                archived=[r for r in archived if start<=datetime.fromisoformat(r['at'].replace('Z','+00:00')).astimezone(now.tzinfo).date()<cutoff]
            result=Client(self.control,owner).history(row,key,cutoff);result['historyRows']=archived+result['historyRows'];result.update(lmuVersion=1,historyStart=start.isoformat(),historyEnd=now.date().isoformat());return result
        from workbench.provider_usage import normalize_history
        if row['kind']=='deepseek':
            now=datetime.now(timezone(timedelta(hours=8)));end=(now+timedelta(days=1)).replace(hour=0,minute=0,second=0,microsecond=0);start=end-timedelta(days=366)
            key=re.sub(r'^(?:Bearer\s+)+','',key.strip(),flags=re.I)
            previous=row.get('snapshot') or {};query_start=start;rows=[];matched=False
            if owner and previous.get('historyDays')==366 and previous.get('historyAvailable') and previous.get('financeVersion')==1 and row.get('lastSuccessEpoch') and not row.get('resetOnSuccess'):
                last=datetime.fromtimestamp(row['lastSuccessEpoch'],end.tzinfo).replace(hour=0,minute=0,second=0,microsecond=0)
                query_start=max(start,min(end-timedelta(days=30),last))
                with self.monitor.db() as db:
                    archived=[json.loads(r[0]) for r in db.execute('SELECT record FROM provider_buckets WHERE owner=? AND connection_id=?',(owner,row['id']))]
                rows=[r for r in archived if start.timestamp()<=datetime.fromisoformat(r['at'].replace('Z','+00:00')).timestamp()<query_start.timestamp()]
            cursor=end
            while cursor>query_start:
                window_start=max(query_start,cursor-timedelta(days=30))
                url='https://platform.deepseek.com/api/v0/usage/by_api_key/amount?'+urlencode({'start':int(window_start.timestamp()),'end':int(cursor.timestamp()),'tz':28800,'api_key_tracking_id':row['keyTrackingId']})
                data=self._provider_get(url,'Bearer '+key)
                if not isinstance(data,dict):raise AccountUnavailable('DeepSeek 历史响应格式不正确')
                if str(data.get('biz_code'))!='0':
                    message='DeepSeek 拒绝历史查询参数，请检查查询范围和 Key 标识' if data.get('biz_msg')=='INVALID_PARAM' else 'DeepSeek 平台凭据无效或没有历史查询权限，请更新平台登录凭据'
                    raise AccountUnavailable(message)
                raw=data.get('biz_data')
                if not isinstance(raw,dict):raise AccountUnavailable('DeepSeek 历史响应格式不正确')
                matched=matched or any((r.get('api_key') or {}).get('tracking_id')==row['keyTrackingId'] for r in raw.get('series',[]) if isinstance(r,dict))
                batch=[r for r in normalize_history(raw,row,True) if window_start.timestamp()<=datetime.fromisoformat(r['at'].replace('Z','+00:00')).timestamp()<cursor.timestamp()]
                try:
                    from workbench.provider_finance import deepseek_costs
                    fees=deepseek_costs(self._provider_get(url.replace('/amount?','/cost?'),'Bearer '+key),row['keyTrackingId'])
                    for entry in batch:
                        when=int(datetime.fromisoformat(entry['at'].replace('Z','+00:00')).timestamp());value=fees.get((entry['model'],when))
                        entry['cost']=float(value) if value is not None else 0.0 if entry['total']==0 else None
                except (AccountUnavailable,ValueError,TypeError,AttributeError):pass
                rows.extend(batch)
                if len(rows)>10000:raise AccountUnavailable('历史记录超过 10000 条，请缩短查询范围')
                cursor=window_start
            if not matched:raise AccountUnavailable('平台未返回该 Key 的历史，请核对 Key 标识和查询范围')
            if len({r['id'] for r in rows})!=len(rows):raise AccountUnavailable('历史接口返回重复时间桶，请检查接口范围')
        else:
            import socket
            parsed=self.validate_history_url(row['apiUrl'])
            addresses=socket.getaddrinfo(parsed.hostname,443,type=socket.SOCK_STREAM)
            if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):raise AccountUnavailable('历史接口不能指向内部网络')
            raw=self._provider_get(row['apiUrl'],'Bearer '+key,False);rows=normalize_history(raw,row);cursors=set()
            while isinstance(raw,dict) and raw.get('has_more'):
                cursor=raw.get('next_page')
                if not isinstance(cursor,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,500}',cursor) or cursor in cursors or len(cursors)>=20:raise AccountUnavailable('历史分页未完成，请缩短查询范围')
                cursors.add(cursor)
                from urllib.parse import parse_qsl,urlunsplit
                params=dict(parse_qsl(parsed.query));params['page']=cursor
                url=urlunsplit((parsed.scheme,parsed.netloc,parsed.path,urlencode(params),''));raw=self._provider_get(url,'Bearer '+key,False);rows.extend(normalize_history(raw,row))
                if len(rows)>10000:raise AccountUnavailable('历史记录过多，请缩短查询范围')
            if len({r['id'] for r in rows})!=len(rows):raise AccountUnavailable('历史分页返回重复记录，请检查接口范围')
        result={'historyRows':rows,'coverage':'供应商历史接口 · 按已选择的 Key 与实际模型统计','unavailable':{},'historyAvailable':True}
        if row['kind']=='deepseek':
            result.update(historyDays=366,historyStart=start.isoformat(),historyEnd=end.isoformat(),financeVersion=1,coverage='DeepSeek 平台历史 · 所选 Key')
            if any(r.get('cost') is None for r in rows):result['unavailable']['cost']='部分费用暂未返回'
            try:
                from workbench.provider_finance import amount
                report=self._provider_get('https://platform.deepseek.com/api/v0/users/get_user_summary','Bearer '+key)
                if str(report.get('biz_code'))!='0':raise ValueError()
                report=report.get('biz_data') or {}
                wallets=[v for k in ('normal_wallets','bonus_wallets') for v in report.get(k,[]) if v.get('currency')=='CNY']
                costs=[v for v in report.get('total_costs',[]) if v.get('currency')=='CNY']
                balance=sum((amount(v.get('balance')) for v in wallets),Decimal(0)) if wallets else None
                spent=sum((amount(v.get('amount')) for v in costs),Decimal(0)) if costs else None
                result['accountFinance']={'currency':'CNY','balance':float(balance) if balance is not None else None,'spent':float(spent) if spent is not None else None,'accountRef':hashlib.sha256(('DeepSeek:'+key).encode()).hexdigest()}
            except (AccountUnavailable,ValueError,TypeError,AttributeError):result['unavailable']['balance']='账户余额暂未返回'
        return result

    def provider_snapshot(self,owner,*args,**kwargs):
        self.initialize()
        with self.lock:
            with self.monitor.db() as db:
                row=db.execute('SELECT version FROM provider_versions WHERE owner=?',(owner,)).fetchone();version=row[0] if row else 0
            key=(owner,version,datetime.now(timezone(timedelta(hours=8))).date().isoformat(),json.dumps([args,kwargs],sort_keys=True))
            cached=self.snapshot_cache.get(key)
            if cached is not None:return json.loads(cached)
            result=self._provider_snapshot(owner,*args,**kwargs)
            if len(self.snapshot_cache)>=64:self.snapshot_cache.pop(next(iter(self.snapshot_cache)))
            result['dataVersion']=str(version);self.snapshot_cache[key]=json.dumps(result,ensure_ascii=False)
            return result

    def _provider_snapshot(self, owner, days=30, source='', provider='', model='', project='', scope='', connection_id='', include_all=False,supplier='',connection_ids='',period='',start_date='',end_date='',models=None):
        from workbench.provider_usage import normalize_glm
        available=[c for c in self._rows(owner) if c['kind']!='codex'];identities=set(filter(None,(connection_ids or connection_id).split(',')))
        if identities-{c['id'] for c in available}:raise ValueError('所选 APIKey 不存在')
        if len(identities)>20:raise ValueError('最多选择 20 个 APIKey')
        connections=[c for c in available if (not identities or c['id'] in identities) and (not supplier or self.supplier_id(c)==supplier)]
        if supplier and identities-{c['id'] for c in connections}:raise ValueError('所选 APIKey 不属于当前供应商')
        if not identities and not supplier and connections:
            connections=[next((c for c in connections if c['kind']=='glm'),connections[0])]
        secrets=self.control.credentials(owner);seen=set();unique=[]
        for c in sorted(connections,key=lambda c:(bool(c.get('snapshot',{}).get('historyAvailable')),c.get('lastTokenSuccessAt',''),c.get('lastSuccessEpoch',0)),reverse=True):
            credential=secrets.get('usage:'+c['id'])
            identity=(c['kind'],credential.split('.')[0] if c['kind']=='glm' and credential else credential) if credential else (c['kind'],secrets.get('platform:'+c['id']),c.get('keyTrackingId')) if c['kind']=='deepseek' and c.get('keyTrackingId') else ('connection',c['id'])
            if identity in seen:continue
            seen.add(identity);unique.append(c)
        connections=unique
        rows=[];coverage=[];calls=[]
        for c in connections:
            snapshot=c.get('snapshot',{})
            if c['kind'] in ('glm','deepseek','custom','lmu',*PRESETS):
                credential=secrets.get('usage:'+c['id'])
                aliases=[a['id'] for a in available if a['kind']==c['kind'] and a.get('apiUrl')==c.get('apiUrl') and credential and secrets.get('usage:'+a['id'])==credential] or [c['id']]
                with self.monitor.db() as db:archived=[json.loads(r[0]) for r in db.execute('SELECT record FROM provider_buckets WHERE owner=? AND connection_id IN ('+','.join('?' for _ in aliases)+')',[owner,*aliases])]
                archived=[r for r in archived if r.get('connection_id')==c['id'] or r.get('provenance',{}).get('type')=='captured-response']
                rows.extend(archived or (normalize_glm(snapshot.get('modelUsage'),c) if c['kind']=='glm' else []))
                with self.monitor.db() as db:calls.extend({'at':r[0],'count':r[1]} for r in db.execute('SELECT at,count FROM provider_call_buckets WHERE owner=? AND connection_id=?',(owner,c['id'])))
            coverage.append({'id':c['id'],'name':c['name'],'kind':c['kind'],'lastSuccessAt':(c.get('lastTokenSuccessAt') or (c.get('lastSuccessAt') if snapshot.get('modelUsage') and rows else None)),'message':snapshot.get('coverage') or '尚未配置密钥或同步平台数据','unavailable':snapshot.get('unavailable',{})})
        merged={}
        for r in rows:
            if r.get('excludedFromTotals') and source!='captured-response':continue
            identity=r.get('consumptionId') or r['id']
            if identity not in merged:merged[identity]=r
            elif any(merged[identity].get(k)!=r.get(k) for k in ('total','input','output','model')):
                merged[identity]={**r,'total':None,'input':None,'output':None,'cached':None,'reasoning':None,'status':'conflicting-evidence'}
        rows=[r for r in merged.values() if (not source or r['source']==source) and (not project or r.get('project')==project)]
        rows.sort(key=lambda r:r['at'],reverse=True)
        for r in rows:
            if r.get('agent')=='平台时间桶':r['agent']=''
        currencies={(c.get('snapshot',{}).get('accountFinance') or {}).get('currency') or PRESETS.get(c['kind'],{}).get('currency') or ('USD' if c['kind']=='lmu' else 'CNY') for c in connections}
        currency=next(iter(currencies)) if len(currencies)==1 else 'CNY'
        calls_earliest=min((datetime.fromisoformat(c['at'].replace('Z','+00:00')).astimezone(timezone(timedelta(hours=8))).date() for c in calls),default=None)
        result=self.monitor.snapshot(owner,days,source=source,project=project,provider=provider,model=model,include_all=include_all,rows_override=rows,models=models,period=period,start_date=start_date,end_date=end_date,cost_currency=currency,range_earliest=calls_earliest)
        result['costCurrency']=currency
        result['dataVersion']=str(self.monitor.data_version(owner))+':'+str(max((c.get('lastSuccessEpoch',0) for c in connections),default=0))
        for day in result['daily']+result['activity']:
            day['provided']=bool(day['requests']) and day['unknown']<day['requests']
            if currency=='USD' and connections and all(c.get('snapshot',{}).get('historyAvailable') and c['snapshot'].get('historyStart','9999')<=day['date']<=c['snapshot'].get('historyEnd','') for c in connections):day['provided']=day['unknown']<day['requests'] or day['requests']==0
            if not day['provided']:day['total']=None
        aggregated=any(r.get('granularity','bucket')!='request' for r in rows) if rows else not connections or connections[0]['kind']!='deepseek' or connections[0].get('historyEnabled',False)
        result.update(origin='official-provider-api',coverage=coverage,available=any(r['total'] is not None for r in rows) or any(c.get('snapshot',{}).get('historyAvailable') for c in connections),aggregated=aggregated,requestDetailsAvailable=not aggregated)
        finance={};unidentified=False
        deepseek_accounts={(c.get('snapshot',{}).get('accountFinance') or {}).get('accountRef') for c in connections if c['kind']=='deepseek'}
        if len(deepseek_accounts)>1:unidentified=True
        for c in sorted(connections,key=lambda c:c.get('lastSuccessEpoch',0)):
            f=c.get('snapshot',{}).get('accountFinance') or {};ref=f.get('accountRef')
            if not ref and len(connections)>1:unidentified=True
            finance[ref or c['id']]=f
        result['accountFinance']={'currency':currency,**{k:sum(f[k] for f in finance.values()) if finance and not unidentified and all(isinstance(f.get(k),(int,float)) for f in finance.values()) else None for k in ('balance','spent')}} if connections else None
        if result['accountFinance'] is not None:result['accountFinance']['scope']='key' if finance and all(f.get('scope')=='key' for f in finance.values()) else 'account'
        result['selectedConnections']=[{'id':c['id'],'name':c['name']} for c in connections]
        result['incomplete']=any(not c.get('snapshot',{}).get('historyAvailable') and not c.get('snapshot',{}).get('modelUsage') for c in connections)
        result['costAvailable']=any(r.get('cost') is not None and r.get('currency')==currency for r in rows) or any(c.get('snapshot',{}).get('financeVersion')==1 and not c.get('snapshot',{}).get('unavailable',{}).get('cost') for c in connections)
        if not aggregated:
            result['platformRequests']=result['summary']['requests']
            for item in coverage:item['message']='仅统计经过采集地址、由 DeepSeek 官方响应返回的实际用量；未覆盖其他应用与接入前历史。'
        from workbench.usage_dates import date_range
        now=datetime.now(timezone(timedelta(hours=8)));start,end=date_range(days,period,start_date,end_date,now.date(),datetime.fromisoformat(result['daily'][0]['date']).date() if result['daily'] else now.date())
        known_calls=[c for c in calls if start<=datetime.fromisoformat(c['at'].replace('Z','+00:00')).astimezone(now.tzinfo).date()<=end]
        if aggregated:
            scoped=[r for r in rows if start<=datetime.fromisoformat(r['at'].replace('Z','+00:00')).astimezone(now.tzinfo).date()<=end and (r['model'] in models if models is not None and models else not model or r['model']==model) and (not provider or r['provider']==provider)]
            result['platformRequests']=sum(r['platform_requests'] for r in scoped) if scoped and all(r.get('platform_requests') is not None for r in scoped) else sum(c['count'] for c in known_calls) if known_calls and not model and not models and (not provider or provider=='GLM') else None
        return result

    def _codex(self):
        rpc=None
        try:
            rpc=self.rpc_factory()
            account=rpc.call('account/read',{'refreshToken':False}).get('account') or {}
            if account.get('type')!='chatgpt':raise AccountUnavailable('请在 Codex 中使用 ChatGPT 账户登录；API Key 登录无法查询 Plus 用量')
            result={'planType':account.get('planType'),'coverage':'官方账户汇总；按模型明细仅覆盖本机已采集记录','unavailable':{}}
            for method,field in (('account/usage/read','tokenActivity'),('account/rateLimits/read','quota')):
                try:result[field]=rpc.call(method)
                except AccountUnavailable as exc:result['unavailable'][field]=str(exc)
            if len(result['unavailable'])==2:raise AccountUnavailable('当前 Codex 无法查询账户用量及配额，请更新 CLI 并检查 ChatGPT 登录状态')
            if result['unavailable'].get('tokenActivity') and self.rpc_factory is CodexRPC:
                try:result['tokenActivity']=self._codex_activity_http();result['activitySource']='codex-backend-readonly';result['unavailable'].pop('tokenActivity',None)
                except AccountUnavailable as exc:result['unavailable']['tokenActivity']=str(exc)
            if result['unavailable'].get('quota') and self.rpc_factory is CodexRPC:
                try:
                    fallback=self._codex_quota_http();result['quota']=fallback['quota'];result['quotaSource']=fallback['quotaSource'];result['unavailable'].pop('quota',None)
                except AccountUnavailable:pass
            return result
        except AccountUnavailable:
            # Same read-only backend used by Codex; no refresh or auth-file writes.
            if self.rpc_factory is not CodexRPC:raise
            result={'unavailable':{},'coverage':'官方账户活动与实时配额；本机日志单独查看'}
            try:result.update(self._codex_quota_http())
            except AccountUnavailable as exc:result['unavailable']['quota']=str(exc)
            try:result['tokenActivity']=self._codex_activity_http();result['activitySource']='codex-backend-readonly';result['unavailable'].pop('tokenActivity',None)
            except AccountUnavailable as exc:result['unavailable']['tokenActivity']=str(exc)
            if 'tokenActivity' not in result and 'quota' not in result:raise AccountUnavailable('官方账户活动与额度暂不可用，请检查 Codex 登录状态和网络') from None
            return result
        finally:
            if rpc:rpc.close()

    def _codex_quota_http(self):
        home=Path(os.environ.get('CODEX_HOME') or Path.home()/'.codex')
        try:auth=json.loads((home/'auth.json').read_text(encoding='utf-8'))
        except (OSError,ValueError):raise AccountUnavailable('未找到当前用户的 Codex 登录，请使用 ChatGPT 登录后同步') from None
        keys=auth.get('tokens') or {}
        if auth.get('auth_mode')!='chatgpt' or not keys.get('access_token') or not keys.get('account_id'):raise AccountUnavailable('需要 Codex 的 ChatGPT 登录；API Key 不支持订阅额度查询')
        class NoRedirect(request.HTTPRedirectHandler):
            def redirect_request(self,*args,**kwargs):return None
        req=request.Request('https://chatgpt.com/backend-api/wham/usage',headers={'Authorization':'Bearer '+keys['access_token'],'ChatGPT-Account-Id':keys['account_id'],'User-Agent':'workbench-usage/1.0'})
        try:
            with request.build_opener(NoRedirect).open(req,timeout=15) as response:raw=response.read(1024*1024+1)
            if len(raw)>1024*1024:raise AccountUnavailable('额度响应过大')
            data=json.loads(raw)
        except error.HTTPError as exc:raise AccountUnavailable({401:'Codex 登录已过期，请在 Codex 重新登录后同步',403:'官方额度查询暂被拒绝，请检查网络后重试',429:'额度查询限流，请稍后重试'}.get(exc.code,'官方额度查询失败，请稍后重试')) from None
        except (OSError,ValueError):raise AccountUnavailable('官方额度连接失败，请检查网络后同步') from None
        limits=data.get('rate_limit') or {}
        def window(w):
            if not isinstance(w,dict):return None
            values=[w.get(k) for k in ('used_percent','limit_window_seconds','reset_at')]
            if any(isinstance(v,bool) or not isinstance(v,(int,float)) or not __import__('math').isfinite(v) for v in values) or not 0<=values[0]<=100 or values[1]<=0:return None
            return {'usedPercent':values[0],'windowDurationMins':values[1]/60,'resetsAt':values[2]}
        bucket={'limitId':'codex','primary':window(limits.get('primary_window')),'secondary':window(limits.get('secondary_window'))}
        if not bucket['primary'] and not bucket['secondary']:raise AccountUnavailable('官方未返回有效额度窗口')
        return {'planType':data.get('plan_type'),'quota':{'rateLimitsByLimitId':{'codex':bucket}},'quotaSource':'codex-backend-readonly','coverage':'官方实时配额；Token 与按模型明细见下方本机采集','unavailable':{'tokenActivity':'官方账户 Token 汇总暂不可用；下方本机统计正常，不影响实时额度'}}

    def _codex_activity_http(self):
        # Official BackendClient::token_usage_profile_url; same account binding as RPC.
        from workbench.account_activity import normalize
        home=Path(os.environ.get('CODEX_HOME') or Path.home()/'.codex')
        try:auth=json.loads((home/'auth.json').read_text(encoding='utf-8'));keys=auth.get('tokens') or {}
        except (OSError,ValueError):raise AccountUnavailable('未找到 Codex 的 ChatGPT 登录') from None
        if auth.get('auth_mode')!='chatgpt' or not keys.get('access_token') or not keys.get('account_id'):raise AccountUnavailable('API Key 登录不能读取官方账户活动')
        class NoRedirect(request.HTTPRedirectHandler):
            def redirect_request(self,*args,**kwargs):return None
        req=request.Request('https://chatgpt.com/backend-api/wham/profiles/me',headers={'Authorization':'Bearer '+keys['access_token'],'ChatGPT-Account-Id':keys['account_id'],'User-Agent':'workbench-usage/0.0.19','Accept':'application/json'})
        try:
            with request.build_opener(NoRedirect).open(req,timeout=10) as response:raw=response.read(2*1024*1024+1)
            if len(raw)>2*1024*1024:raise ValueError()
            stats=json.loads(raw)['stats']
            mapping={'lifetimeTokens':'lifetime_tokens','peakDailyTokens':'peak_daily_tokens','longestRunningTurnSec':'longest_running_turn_sec','currentStreakDays':'current_streak_days','longestStreakDays':'longest_streak_days'}
            buckets=stats.get('daily_usage_buckets')
            return normalize({'summary':{k:stats.get(v) for k,v in mapping.items()},'dailyUsageBuckets':None if buckets is None else [{'startDate':r['start_date'],'tokens':r['tokens']} for r in buckets]})
        except error.HTTPError as exc:raise AccountUnavailable({401:'Codex 登录已过期，请重新登录后同步',403:'官方账户活动查询被拒绝',429:'官方账户活动查询限流，请稍后同步'}.get(exc.code,'官方账户活动读取失败')) from None
        except (OSError,ValueError,KeyError,TypeError):raise AccountUnavailable('官方账户活动暂不可用或结构不受支持，不使用本机日志替代') from None

    def sync(self, owner, cid, force=True):
        self.initialize()
        cid=valid_id(cid)
        with self.lock:
            row=next((r for r in self._rows(owner) if r['id']==cid),None)
            if not row:raise ValueError('用量连接不存在')
            if not row['enabled']:raise ValueError('此连接已暂停，请先启用')
            if (owner,cid) in self.busy:return {'busy':True}
            if not force and time.time()-row.get('lastAttemptEpoch',0)<300:return {'cached':True}
            self.busy.add((owner,cid))
        try:
            try:
                if row['kind']=='codex':
                    self.claim_codex(owner,self.control.public(owner)['defaultCodexPath'])
                    snapshot=self._codex()
                else:
                    keys=self.control.credentials(owner);key=keys.get('usage:'+cid)
                    if row['kind'] in PRESETS:
                        from workbench.provider_adapters import read
                        if not key and not keys.get('platform:'+cid):raise AccountUnavailable('查询凭据未配置')
                        snapshot=read(row,key or '',keys.get('platform:'+cid,''))
                    elif row.get('historyEnabled'):
                        credential=keys.get('platform:'+cid) if row['kind']=='deepseek' else key
                        if not credential:raise AccountUnavailable('历史查询凭据未配置，请编辑连接')
                        snapshot=self._history(row,credential,owner)
                    else:
                        if not key:raise AccountUnavailable('密钥未配置，请编辑连接')
                        if row['kind']=='glm' and 'api.z.ai' not in row['apiUrl']:
                            try:snapshot=self._glm_finance(row,key,owner)
                            except AccountUnavailable as finance_error:
                                try:snapshot=self._glm(key)
                                except AccountUnavailable:raise finance_error
                        else:snapshot=self._deepseek(key) if row['kind']=='deepseek' else self._glm(key,row['apiUrl'])
                row.update(snapshot=snapshot,lastSuccessAt=iso(),lastSuccessEpoch=time.time(),error=None)
            except Exception as exc:
                # Unexpected errors may contain credential-bearing URLs: use fixed copy.
                row['error']=str(exc) if isinstance(exc,AccountUnavailable) else '账户同步失败，请检查连接后重试'
            row.update(lastAttemptAt=iso(),lastAttemptEpoch=time.time())
            with self.lock:
                current=next((r for r in self._rows(owner) if r['id']==cid),None)
                if current and current.get('revision')==row.get('revision'):
                    if row['kind'] in ('glm','custom','deepseek','lmu') and not row.get('error') and (row.get('snapshot',{}).get('modelUsage') or row.get('snapshot',{}).get('historyAvailable')):
                        from workbench.provider_usage import normalize_glm,normalize_glm_calls
                        historical=row['snapshot'].get('historyAvailable');buckets=row['snapshot'].pop('historyRows',[]) if historical else normalize_glm(row['snapshot']['modelUsage'],row)
                        if buckets:row['lastTokenSuccessAt']=row['lastSuccessAt']
                        call_buckets=[] if historical else normalize_glm_calls(row['snapshot']['modelUsage'])
                        with self.monitor.db() as db:
                            if current.get('resetOnSuccess') or historical:
                                db.execute('DELETE FROM provider_buckets WHERE owner=? AND connection_id=?',(owner,cid))
                                db.execute('DELETE FROM provider_call_buckets WHERE owner=? AND connection_id=?',(owner,cid))
                            for bucket in buckets:db.execute('INSERT OR REPLACE INTO provider_buckets VALUES(?,?,?,?)',(owner,cid,bucket['id'],json.dumps(bucket,ensure_ascii=False)))
                            for bucket in call_buckets:db.execute('INSERT OR REPLACE INTO provider_call_buckets VALUES(?,?,?,?)',(owner,cid,bucket['at'],bucket['count']))
                        current.pop('resetOnSuccess',None)
                        if historical:row['snapshot']['historyCount']=len(buckets)
                    for key in ('snapshot','lastSuccessAt','lastTokenSuccessAt','lastSuccessEpoch','error','lastAttemptAt','lastAttemptEpoch'):
                        if key in row:current[key]=row[key]
                    self._write(owner,current)
            return {'ok':not bool(row.get('error')),'error':row.get('error')}
        finally:
            with self.lock:self.busy.discard((owner,cid))

    def tick(self, owner):
        for row in self._rows(owner):
            if row['enabled'] and (row['kind']=='codex' or self.control.credentials(owner).get('usage:'+row['id'])) and time.time()-row.get('lastAttemptEpoch',0)>=300:
                def work(cid=row['id']):
                    try:self.sync(owner,cid,force=False)
                    except (ValueError,OSError):pass  # Connection may be removed between polling and dispatch.
                threading.Thread(target=work,daemon=True).start()
