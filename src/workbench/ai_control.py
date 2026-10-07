"""Workstation settings, provider credentials and supervised Agent conversations."""
from pathlib import Path
from urllib import request as urlrequest
from urllib.parse import urlparse
from datetime import datetime, timezone
import hashlib
import json
import threading
import time
import uuid
import os
import re

SECTIONS=('general','appearance','modelProvider','memory','subagents','plugin','mcp','skill','commands','automations','hooks','browser','computerUse','shortcuts','workspaceFileSearch','usage')
RESOURCES=('memory','subagents','plugin','mcp','skill','commands','automations','hooks','browser')

def identifier():return uuid.uuid4().hex
def valid_id(value):
    value=str(value)
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}',value):raise ValueError('资源标识格式不正确')
    return value
def validate_state(value):
    if not isinstance(value,dict):raise ValueError('工作台控制配置必须是对象')
    if not isinstance(value.get('config',{}),dict) or not isinstance(value.get('resources',{}),dict):raise ValueError('工作台配置结构不正确')
    for kind in ('providers','sessions','runs','notifications'):
        if not isinstance(value.get(kind,[]),list) or any(not isinstance(row,dict) for row in value.get(kind,[])):raise ValueError('工作台列表格式不正确')
    for kind in ('providers','sessions'):
        for row in value.get(kind,[]):valid_id(row.get('id',''))
    for section,rows in value.get('resources',{}).items():
        if section not in RESOURCES or not isinstance(rows,list):raise ValueError('资源列表格式不正确')
        for row in rows:
            if not isinstance(row,dict):raise ValueError('资源格式不正确')
            valid_id(row.get('id',''))
            if not isinstance(row.get('name'),str) or not isinstance(row.get('content'),str) or not isinstance(row.get('enabled'),bool):raise ValueError('资源字段格式不正确')
            if section=='plugin':
                manifest=json.loads(row['content'])
                if not isinstance(manifest,dict) or not isinstance(manifest.get('instructions',''),str):raise ValueError('插件指令格式不正确')
            if section in ('browser','mcp'):endpoint(row.get('url',''))
            if section=='automations' and (row.get('workflow') not in ('taskReview','monthlySummary') or not isinstance(row.get('intervalMinutes'),int) or not 5<=row['intervalMinutes']<=10080):raise ValueError('自动化字段格式不正确')
    for row in value.get('providers',[]):
        if any(key in row for key in ('apiKey','key','secret')):raise ValueError('密钥请在模型服务中单独填写')
        if not isinstance(row.get('model'),str) or not isinstance(row.get('name'),str):raise ValueError('模型字段格式不正确')
        endpoint(row.get('baseUrl',''))
    for row in value.get('sessions',[]):
        if not isinstance(row.get('title'),str) or not isinstance(row.get('messages'),list):raise ValueError('会话格式不正确')
        for message in row['messages']:
            if not isinstance(message,dict) or message.get('role') not in ('user','assistant') or not isinstance(message.get('content'),str):raise ValueError('会话消息格式不正确')
def endpoint(value):
    if not isinstance(value,str):raise ValueError('地址必须是文本')
    parsed=urlparse(value)
    if parsed.scheme not in ('http','https') or not parsed.netloc or parsed.username or parsed.password:raise ValueError('地址须为不含账号密码的 HTTP/HTTPS URL')
    return value.rstrip('/')

class AIControl:
    def __init__(self,data,documents,monitor):
        self.data=Path(data);self.documents=documents;self.monitor=monitor;self.lock=threading.RLock();self.busy=set()
    def path(self,owner):return self.data/'users'/owner/'control.json'
    def state(self,owner):
        value=self.documents.read(self.path(owner),{})
        if not isinstance(value,dict):value={}
        return {'config':value.get('config',{}),'providers':value.get('providers',[]),'resources':{k:value.get('resources',{}).get(k,[]) for k in RESOURCES},'sessions':value.get('sessions',[]),'runs':value.get('runs',[]),'notifications':value.get('notifications',[])}
    def save(self,owner,state):self.documents.write(self.path(owner),state)
    def credentials(self,owner):
        path=self.data/'credentials'/owner/'secrets.json'
        try:return json.loads(path.read_text(encoding='utf-8'))
        except (ValueError,OSError):return {}
    def save_credentials(self,owner,value):
        path=self.data/'credentials'/owner/'secrets.json';path.parent.mkdir(parents=True,exist_ok=True)
        temp=path.with_suffix('.tmp');temp.write_text(json.dumps(value),encoding='utf-8');temp.replace(path)
    def public(self,owner):
        state=self.state(owner);keys=self.credentials(owner)
        state['providers']=[dict(p,configured=bool(keys.get(p['id']))) for p in state['providers']]
        state['sections']=list(SECTIONS);state['capabilities']={'agentChat':True,'apiUsage':True,'codexLogs':True,'nativeComputerUse':False,'sshRuntime':False,'mcpHttp':True,'localAutomations':True}
        home=Path(os.environ.get('USERPROFILE') or os.environ.get('HOME') or self.data.parent)
        state['defaultCodexPath']=str(home/'.codex'/'sessions')
        from workbench.zcode_monitor import default_path
        state['defaultZcodePath']=default_path()
        from workbench.dsh_monitor import default_path as dsh_path
        state['defaultDshPath']=dsh_path()
        return state
    def update_config(self,owner,body,validate_only=False):
        allowed={'memoryEnabled','defaultProvider','defaultAgent','codexEnabled','codexPath','zcodeEnabled','zcodePath','dshEnabled','dshPath','workspaceIgnore','interfaceMode','locale','shortcuts','browserDefault','dailyTokenBudget','monthlyTokenBudget','codexValuationEnabled','zcodeValuationEnabled','dshValuationEnabled','promptAutosave','promptAIEnabled','theme','uiFontSize','accent','brightness','reduceMotion'}
        if not isinstance(body,dict) or any(k not in allowed for k in body):raise ValueError('设置项不正确')
        if len(json.dumps(body))>64000:raise ValueError('设置内容过长')
        for key in ('dailyTokenBudget','monthlyTokenBudget'):
            if key in body and (isinstance(body[key],bool) or not isinstance(body[key],int) or body[key]<0):raise ValueError('预算需为非负整数')
        for key in ('memoryEnabled','codexEnabled','zcodeEnabled','dshEnabled','codexValuationEnabled','zcodeValuationEnabled','dshValuationEnabled','promptAutosave','promptAIEnabled','reduceMotion'):
            if key in body and not isinstance(body[key],bool):raise ValueError('开关需为布尔值')
        if 'interfaceMode' in body and body['interfaceMode'] not in ('coding','office'):raise ValueError('界面模式不正确')
        if 'locale' in body and body['locale'] not in ('system','zh-CN','en-US'):raise ValueError('菜单语言不正确')
        if 'theme' in body and body['theme'] not in ('system','light','dark','zai-light','zai-dark'):raise ValueError('主题不正确')
        if 'uiFontSize' in body and body['uiFontSize'] not in (12,14,16,18):raise ValueError('字号不正确')
        if 'accent' in body and body['accent'] not in ('blue','violet','teal','orange'):raise ValueError('强调色不正确')
        if 'brightness' in body and (isinstance(body['brightness'],bool) or not isinstance(body['brightness'],int) or not 85<=body['brightness']<=110):raise ValueError('亮度范围为 85–110')
        if 'workspaceIgnore' in body and (not isinstance(body['workspaceIgnore'],list) or any(not isinstance(x,str) or len(x)>150 for x in body['workspaceIgnore'])):raise ValueError('忽略规则需为文本列表')
        for key in ('codexPath','zcodePath','dshPath','defaultProvider','defaultAgent','browserDefault'):
            if key in body and (not isinstance(body[key],str) or len(body[key])>1000):raise ValueError('路径和标识须为文本')
        if 'shortcuts' in body:
            import re
            values=body['shortcuts']
            if not isinstance(values,dict) or any(k not in ('search','sidebar','settings') or not isinstance(v,str) or not re.fullmatch(r'(Ctrl|Meta)\+(Shift\+)?[A-Za-z,]',v) for k,v in values.items()) or len(set(values.values()))!=len(values):raise ValueError('快捷键格式不正确或重复')
        if validate_only:return {'ok':True}
        with self.lock:
            state=self.state(owner);state['config'].update(body);self.save(owner,state)
        return {'ok':True}
    def provider(self,owner,body):
        with self.lock:
            state=self.state(owner);pid=valid_id(body.get('id') or identifier());existing=next((p for p in state['providers'] if p['id']==pid),{})
            if body.get('delete'):
                state['providers']=[p for p in state['providers'] if p['id']!=pid];keys=self.credentials(owner);keys.pop(pid,None)
                if state['config'].get('defaultProvider')==pid:state['config']['defaultProvider']=next((p['id'] for p in state['providers'] if p['enabled']),'')
                self.save_credentials(owner,keys);self.save(owner,state);return {'ok':True}
            name=str(body.get('name','')).strip();model=str(body.get('model','')).strip()
            if not name or not model or len(name)>80 or len(model)>180:raise ValueError('请填写服务商名称和模型')
            rates=body.get('rates') or {}
            if rates:
                import math
                if any(not isinstance(rates.get(k),(int,float)) or isinstance(rates[k],bool) or rates[k]<0 or not math.isfinite(rates[k]) for k in ('input','output','cached')):raise ValueError('单价需为非负数，每百万 Token')
                if rates.get('currency') not in ('CNY','USD'):raise ValueError('请选择 CNY 或 USD')
            provider={'id':pid,'name':name,'model':model,'baseUrl':endpoint(str(body.get('baseUrl',''))),'rates':rates,'enabled':body.get('enabled',True) is True}
            key=str(body.get('apiKey') or '').strip();keys=self.credentials(owner)
            if key:keys[pid]=key;self.save_credentials(owner,keys)
            if body.get('clearKey'):keys.pop(pid,None);self.save_credentials(owner,keys)
            state['providers']=[p for p in state['providers'] if p['id']!=pid]+[provider]
            if not state['config'].get('defaultProvider'):state['config']['defaultProvider']=pid
            self.save(owner,state);return {'provider':dict(provider,configured=bool(keys.get(pid)))}
    def resource(self,owner,section,body):
        if section not in RESOURCES:raise ValueError('资源类型不正确')
        with self.lock:
            state=self.state(owner);rows=state['resources'][section];rid=valid_id(body.get('id') or identifier())
            if body.get('delete'):state['resources'][section]=[r for r in rows if r['id']!=rid];self.save(owner,state);return {'ok':True}
            previous=next((r for r in rows if r['id']==rid),{})
            name=str(body.get('name',previous.get('name',''))).strip();content=str(body.get('content',previous.get('content','')))
            if not name or len(name)>100 or len(content)>32000:raise ValueError('请填写名称，内容不超过 32000 字符')
            row={**previous,'id':rid,'name':name,'content':content,'enabled':body.get('enabled',previous.get('enabled',True)) is True,'updatedAt':datetime.now(timezone.utc).isoformat()}
            if section in ('mcp','browser'):row['url']=endpoint(str(body.get('url',previous.get('url',''))))
            if section=='automations':
                row['intervalMinutes']=max(5,min(10080,int(body.get('intervalMinutes',previous.get('intervalMinutes',60)))))
                row['workflow']=body.get('workflow',previous.get('workflow','taskReview'))
                if row['workflow'] not in ('taskReview','monthlySummary'):raise ValueError('工作流类型不正确')
                row['nextRun']=previous.get('nextRun',time.time()+row['intervalMinutes']*60)
            if section=='hooks':
                row['event']=body.get('event',previous.get('event','ai.success'))
                if row['event'] not in ('ai.success','ai.error','automation.done'):raise ValueError('Hook 事件不正确')
            if section=='plugin':
                try:manifest=json.loads(content)
                except ValueError:raise ValueError('插件清单需为 JSON')
                if not isinstance(manifest,dict) or not isinstance(manifest.get('instructions',''),str):raise ValueError('插件清单需包含文本 instructions')
            state['resources'][section]=[r for r in rows if r['id']!=rid]+[row];self.save(owner,state);return {'resource':row}
    def notify(self,owner,event):
        with self.lock:
            state=self.state(owner)
            for hook in state['resources']['hooks']:
                if hook['enabled'] and hook.get('event')==event:state['notifications'].insert(0,{'id':identifier(),'at':datetime.now(timezone.utc).isoformat(),'message':hook['content'] or hook['name'],'event':event})
            state['notifications']=state['notifications'][:100];self.save(owner,state)
    def request(self,owner,cfg,payload,agent='工作台',session='',source='api',project='',notify_hooks=True):
        start=time.monotonic();rid=identifier();data=None
        try:
            url=endpoint(cfg['baseUrl'])+'/chat/completions'
            req=urlrequest.Request(url,data=json.dumps(payload,ensure_ascii=False).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+cfg['apiKey']})
            class NoRedirect(urlrequest.HTTPRedirectHandler):
                def redirect_request(self,*args):return None
            with urlrequest.build_opener(NoRedirect()).open(req,timeout=40) as response:data=json.loads(response.read().decode('utf-8'))
            self.monitor.record(owner,data.get('usage'),id=data.get('id') or rid,source=source,agent=agent,provider=cfg.get('name',cfg.get('provider','API')),model=data.get('model') or '未识别模型',requested_model=payload.get('model',cfg.get('model','')),connection_id=cfg.get('id',''),auth_mode='api_key',session=session,project=project,duration_ms=int((time.monotonic()-start)*1000),rates=cfg.get('rates'))
            hook=getattr(self,'usage_response_hook',None)
            if hook:
                try:hook(owner,cfg,data,payload.get('model',cfg.get('model','')),rid)
                except Exception:pass  # A statistics write must not discard a successful model response.
            if notify_hooks:self.notify(owner,'ai.success')
            return data
        except Exception:
            if data is None:self.monitor.record(owner,None,id=rid,source=source,agent=agent,provider=cfg.get('name',cfg.get('provider','API')),model='未识别模型',requested_model=cfg.get('model',''),connection_id=cfg.get('id',''),auth_mode='api_key',session=session,status='error',duration_ms=int((time.monotonic()-start)*1000))
            if notify_hooks:self.notify(owner,'ai.error')
            raise
    def config_for(self,owner,pid=None):
        state=self.state(owner);pid=pid or state['config'].get('defaultProvider')
        provider=next((p for p in state['providers'] if p['id']==pid and p['enabled']),None)
        key=self.credentials(owner).get(pid)
        if not provider or not key:raise ValueError('请在模型服务中添加 API 服务并保存密钥')
        return dict(provider,apiKey=key)
    def test_provider(self,owner,pid):
        cfg=self.config_for(owner,pid)
        req=urlrequest.Request(endpoint(cfg['baseUrl'])+'/models',headers={'Authorization':'Bearer '+cfg['apiKey']})
        with urlrequest.urlopen(req,timeout=10) as response:data=json.loads(response.read())
        return {'ok':True,'models':[x.get('id') for x in data.get('data',[])][:100]}
    def session(self,owner,body):
        with self.lock:
            state=self.state(owner);sid=valid_id(body.get('id') or identifier());previous=next((s for s in state['sessions'] if s['id']==sid),None)
            if body.get('delete'):state['sessions']=[s for s in state['sessions'] if s['id']!=sid];self.save(owner,state);return {'ok':True}
            row=previous or {'id':sid,'title':str(body.get('title') or '新对话')[:100],'messages':[],'createdAt':datetime.now(timezone.utc).isoformat(),'archived':False}
            if 'title' in body:row['title']=str(body['title']).strip()[:100] or '新对话'
            if 'archived' in body:row['archived']=body['archived'] is True
            state['sessions']=[s for s in state['sessions'] if s['id']!=sid]+[row];self.save(owner,state);return {'session':row}
    def chat(self,owner,body):
        with self.lock:
            if owner in self.busy:raise ValueError('当前账号已有 Agent 请求，请等待回复后发送')
            self.busy.add(owner)
        try:return self._chat(owner,body)
        finally:
            with self.lock:self.busy.discard(owner)
    def _chat(self,owner,body):
        message=str(body.get('message','')).strip()
        if not message or len(message)>16000:raise ValueError('请输入消息，最多 16000 字符')
        sid=body.get('session') or self.session(owner,{'title':message[:50]})['session']['id']
        state=self.state(owner);session=next((s for s in state['sessions'] if s['id']==sid),None)
        if not session:raise ValueError('会话不存在')
        cfg=self.config_for(owner,body.get('provider'))
        instructions=['你是用户的个人工作台助手。只提出可核对的建议，不声称执行未执行的操作。']
        aid=body.get('agent') or state['config'].get('defaultAgent')
        profile=next((a for a in state['resources']['subagents'] if a['id']==aid and a['enabled']),None)
        if profile:instructions.append(profile['content'])
        if state['config'].get('memoryEnabled',True):instructions.extend(r['content'] for r in state['resources']['memory'] if r['enabled'])
        instructions.extend(r['content'] for r in state['resources']['skill'] if r['enabled'])
        instructions.extend(json.loads(r['content']).get('instructions','') for r in state['resources']['plugin'] if r['enabled'])
        messages=[{'role':'system','content':'\n\n'.join(instructions)[:32000]}]+session['messages'][-20:]+[{'role':'user','content':message}]
        data=self.request(owner,cfg,{'model':cfg['model'],'messages':messages},agent=profile['name'] if profile else '工作台 Agent',session=sid,source='agent')
        text=data['choices'][0]['message']['content']
        if not isinstance(text,str):raise ValueError('服务未返回文本内容')
        with self.lock:
            state=self.state(owner);current=next((s for s in state['sessions'] if s['id']==sid),None)
            if not current:raise ValueError('会话已删除，响应未保存')
            current['messages'].extend([{'role':'user','content':message},{'role':'assistant','content':text}]);current['updatedAt']=datetime.now(timezone.utc).isoformat();current['messages']=current['messages'][-100:];self.save(owner,state)
        return {'session':current,'usage':data.get('usage'),'model':data.get('model',cfg['model'])}
    def mcp_test(self,owner,rid):
        state=self.state(owner);resource=next((r for r in state['resources']['mcp'] if r['id']==rid),None)
        if not resource:raise ValueError('MCP 连接不存在')
        protocol='2024-11-05'
        def rpc(method,params,session=None,notification=False):
            headers={'Content-Type':'application/json','Accept':'application/json, text/event-stream','MCP-Protocol-Version':protocol}
            if session:headers['Mcp-Session-Id']=session
            body={'jsonrpc':'2.0','method':method,'params':params}
            if not notification:body['id']=identifier()
            req=urlrequest.Request(resource['url'],data=json.dumps(body).encode(),headers=headers)
            with urlrequest.urlopen(req,timeout=12) as response:
                session=response.headers.get('Mcp-Session-Id') or session
                if 'text/event-stream' in response.headers.get('Content-Type','') and not notification:
                    raw=''
                    for _ in range(1000):
                        line=response.readline(1024*1024).decode()
                        if not line:break
                        if line.startswith('data:') and line[5:].strip().startswith('{'):
                            candidate=json.loads(line[5:])
                            if 'result' in candidate or 'error' in candidate:raw=line[5:];break
                    if not raw:raise ValueError('MCP 事件流未返回结果')
                else:raw=response.read(1024*1024).decode()
            if notification:return {},session
            if raw.lstrip().startswith('data:'):raw=next(line[5:].strip() for line in raw.splitlines() if line.startswith('data:') and line[5:].strip().startswith('{'))
            result=json.loads(raw)
            if 'error' in result:raise ValueError('MCP 返回错误：'+str(result['error'].get('message','请求失败')))
            return result.get('result',{}),session
        info,session=rpc('initialize',{'protocolVersion':'2024-11-05','capabilities':{},'clientInfo':{'name':'personal-workbench','version':'2.0'}})
        protocol=info.get('protocolVersion',protocol)
        rpc('notifications/initialized',{},session,notification=True)
        tools,_=rpc('tools/list',{},session)
        return {'ok':True,'server':info.get('serverInfo',{}),'tools':tools.get('tools',[])}
    def run_automation(self,owner,rid,state_data,summary):
        state=self.state(owner);job=next((r for r in state['resources']['automations'] if r['id']==rid),None)
        if not job:raise ValueError('自动化不存在')
        result=summary()['draft'] if job['workflow']=='monthlySummary' else '\n'.join(['待办检查']+[('已完成' if t.get('done') else '待完成')+' · '+t['title'] for t in state_data()['tasks']])
        run={'id':identifier(),'jobId':rid,'title':job['name'],'at':datetime.now(timezone.utc).isoformat(),'status':'success','result':result[:32000]}
        with self.lock:
            state=self.state(owner);state['runs'].insert(0,run);state['runs']=state['runs'][:100]
            for r in state['resources']['automations']:
                if r['id']==rid:r['lastRun']=run['at'];r['nextRun']=time.time()+r['intervalMinutes']*60
            self.save(owner,state)
        self.notify(owner,'automation.done');return {'run':run}
