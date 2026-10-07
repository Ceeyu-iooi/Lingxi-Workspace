"""Scoped DeepSeek forwarding: counts come only from actual official responses."""
import hashlib,hmac,json,secrets,uuid
from urllib import request,error
from workbench.ai_monitor import tokens,iso
from workbench.usage_accounts import AccountUnavailable
from workbench.ai_control import valid_id
from workbench.provider_adapters import RELAY_KINDS,PRESETS,validate_url,inference_base


class ProviderRelay:
    def __init__(self,accounts):self.accounts=accounts

    def configure(self,owner,cid,revoke=False):
        a=self.accounts;cid=valid_id(cid)
        with a.lock:
            row=next((r for r in a._rows(owner) if r['id']==cid and r['kind'] in RELAY_KINDS),None)
            if not row:raise ValueError('DeepSeek 连接不存在')
            if row.get('credentialMode')=='subscription' or row['kind'] in ('newapi','sub2api') and row.get('credentialMode')=='account':raise ValueError('账户／订阅查询凭据不能作为推理采集 Key')
            keys=a.control.credentials(owner)
            if revoke:
                keys.pop('relay:'+cid,None);key=None
            else:
                if not keys.get('usage:'+cid):raise ValueError('请先填写 DeepSeek API Key')
                key='wb-relay-'+secrets.token_urlsafe(32);keys['relay:'+cid]=key
            a.control.save_credentials(owner,keys)
            return {'id':cid,'relayKey':key,'basePath':'/api/usage/relay/'+cid,'revoked':revoke,'coverage':'仅记录经过此地址的新请求。不能读取其他应用或历史请求；正常模型调用按 DeepSeek 计费。'}

    def connect_agent(self,owner,cid,model):
        a=self.accounts;cid=valid_id(cid)
        row=next((r for r in a._rows(owner) if r['id']==cid and r['kind'] in RELAY_KINDS),None)
        if not row or not row['enabled']:raise ValueError('DeepSeek 连接不存在或已暂停')
        key=a.control.credentials(owner).get('usage:'+cid)
        if not key:raise ValueError('请先填写 DeepSeek API Key')
        available=row.get('snapshot',{}).get('models',[])
        if not isinstance(model,str) or not model or len(model)>180 or (available and model not in available):raise ValueError('请选择平台返回的模型')
        pid='usage-agent-'+cid
        if row.get('credentialMode')=='subscription' or row['kind'] in ('newapi','sub2api') and row.get('credentialMode')=='account':raise ValueError('请使用独立的推理 Key')
        a.control.provider(owner,{'id':pid,'name':(PRESETS.get(row['kind'],{}).get('name','DeepSeek')+' · '+row['name'])[:80],'baseUrl':inference_base(row),'apiKey':key,'model':model})
        a.control.update_config(owner,{'defaultProvider':pid})
        return {'providerId':pid,'model':model,'coverage':'仅采集此工作台 Agent 直接调用 DeepSeek 返回的用量，不读取日志，也不包含其他应用历史。'}

    def capture_agent(self,owner,cfg,response,requested_model,request_id):
        pid=cfg.get('id','')
        if not pid.startswith('usage-agent-'):return False
        cid=pid[len('usage-agent-'):];a=self.accounts
        row=next((r for r in a._rows(owner) if r['id']==cid and r['kind'] in RELAY_KINDS and r['enabled']),None)
        if not row or cfg.get('baseUrl','').rstrip('/')!=inference_base(row) or a.control.credentials(owner).get('usage:'+cid)!=cfg.get('apiKey'):return False
        return self.capture(owner,row,response,requested_model,request_id,allow_missing=True)

    def authenticate(self,cid,bearer):
        a=self.accounts;a.initialize();cid=valid_id(cid)
        if not bearer or len(bearer)>200:raise AccountUnavailable('采集密钥无效')
        with a.monitor.db() as db:
            found=db.execute('SELECT owner,value FROM usage_connections WHERE id=?',(cid,)).fetchone()
        if not found:raise AccountUnavailable('采集连接不存在')
        owner=found[0];row=json.loads(found[1]);keys=a.control.credentials(owner)
        expected=keys.get('relay:'+cid,'')
        if not expected or not hmac.compare_digest(expected,bearer):raise AccountUnavailable('采集密钥无效')
        if row['kind'] not in RELAY_KINDS or row.get('credentialMode')=='subscription' or row['kind'] in ('newapi','sub2api') and row.get('credentialMode')=='account' or not row['enabled']:raise AccountUnavailable('采集连接已暂停或凭据仅供账户查询')
        key=keys.get('usage:'+cid)
        if not key:raise AccountUnavailable('服务商密钥尚未配置')
        return owner,row,key

    def open(self,key,endpoint,body,row=None):
        if endpoint not in ('chat/completions','responses'):raise ValueError('采集地址仅支持 chat/completions 与 responses')
        if not isinstance(body,dict) or not isinstance(body.get('model'),str) or not body['model'] or len(body['model'])>180:raise ValueError('请指定有效模型')
        if not isinstance(body.get('stream',False),bool):raise ValueError('stream 必须是布尔值')
        if endpoint=='chat/completions' and not isinstance(body.get('messages'),list):raise ValueError('messages 必须是数组')
        class NoRedirect(request.HTTPRedirectHandler):
            def redirect_request(self,*args,**kwargs):return None
        base=inference_base(row) if row else 'https://api.deepseek.com'
        if row and row['kind'] in PRESETS:validate_url(row['kind'],base)
        req=request.Request(base+'/'+endpoint,data=json.dumps(body,ensure_ascii=False).encode(),headers={'Authorization':'Bearer '+key,'Content-Type':'application/json','Accept':'text/event-stream' if body.get('stream') else 'application/json'})
        try:return request.build_opener(NoRedirect).open(req,timeout=90)
        except error.HTTPError as exc:raise AccountUnavailable({401:'DeepSeek API Key 无效',402:'DeepSeek 余额不足',429:'DeepSeek 请求限流'}.get(exc.code,'DeepSeek 调用失败，请检查模型及请求参数')) from None
        except OSError:raise AccountUnavailable('DeepSeek 暂时无法连接') from None

    def capture(self,owner,row,response,requested_model,request_id,allow_missing=False):
        """Save no prompts, content or credential. Missing usage stays unknown."""
        if not isinstance(response,dict):return False
        if isinstance(response.get('response'),dict):response=response['response']
        usage=response.get('usage')
        if not isinstance(usage,dict) and not allow_missing:return False
        try:counts=tokens(usage)
        except ValueError:return False
        if not counts or counts['total'] is None:
            if not allow_missing:return False
            counts={k:None for k in ('input','output','cached','reasoning','total')};usage={}
        if any(v is not None and v>2**53-1 for v in counts.values()):return False
        if all(counts[k] is not None for k in ('input','output','total')) and counts['input']+counts['output']!=counts['total']:return False
        model=response.get('model') or '未识别模型'
        if not isinstance(model,str) or not model or len(model)>180:return False
        # Do not claim absent cache/reasoning counters are returned zeros.
        if not any(k in usage for k in ('prompt_cache_hit_tokens','cached_input_tokens','cached')) and not any(isinstance(usage.get(k),dict) and 'cached_tokens' in usage[k] for k in ('input_tokens_details','prompt_tokens_details')):counts['cached']=None
        if not any(k in usage for k in ('reasoning_output_tokens','reasoning')) and not any(isinstance(usage.get(k),dict) and 'reasoning_tokens' in usage[k] for k in ('output_tokens_details','completion_tokens_details')):counts['reasoning']=None
        try:stamp=iso(response.get('created',response.get('created_at')))
        except ValueError:stamp=iso()
        upstream_id=response.get('id') or request_id
        ident=row['id']+':response:'+hashlib.sha256(str(upstream_id).encode()).hexdigest()
        record={'id':ident,'at':stamp,'source':'captured-response','agent':PRESETS.get(row['kind'],{}).get('name','DeepSeek')+' 响应采集','provider':PRESETS.get(row['kind'],{}).get('name','GLM' if row['kind']=='glm' else 'DeepSeek'),'model':model,'project':'','session':'','connection_id':row['id'],'requested_model':requested_model,'auth_mode':'api_key','status':'ok','cost':None,'currency':PRESETS.get(row['kind'],{}).get('currency','CNY'),'duration_ms':None,**counts}
        a=self.accounts
        with a.lock:
            current=next((c for c in a._rows(owner) if c['id']==row['id']),None)
            if not current or current.get('revision')!=row.get('revision'):return False
            credential=a.control.credentials(owner).get('usage:'+row['id'],'')
            record.update(granularity='request',consumptionId=hashlib.sha256((row['kind']+'\0'+row['apiUrl']+'\0'+credential+'\0'+str(upstream_id)).encode()).hexdigest(),provenance={'type':'captured-response','endpoint':row['apiUrl'],'requestId':str(upstream_id),'parserVersion':'usage-v18'})
            if current.get('historyEnabled'):record['excludedFromTotals']='official-history-overlap'
            with a.monitor.db() as db:
                previous=db.execute('SELECT record FROM provider_buckets WHERE owner=? AND connection_id=? AND id=?',(owner,row['id'],ident)).fetchone()
                if previous and json.loads(previous[0])['total'] is not None and counts['total'] is None:return True
                db.execute('INSERT OR REPLACE INTO provider_buckets VALUES(?,?,?,?)',(owner,row['id'],ident,json.dumps(record,ensure_ascii=False)))
            if counts['total'] is not None:current['lastTokenSuccessAt']=iso()
            a._write(owner,current)
        return True

    def handle(self,handler,cid,endpoint,body):
        auth=handler.headers.get('Authorization','')
        try:owner,row,key=self.authenticate(cid,auth[7:] if auth.startswith('Bearer ') else '')
        except (ValueError,AccountUnavailable):handler._json({'error':{'message':'采集密钥无效、连接已暂停或不存在','type':'authentication_error'}},401);return
        request_id=uuid.uuid4().hex
        try:
            upstream=self.open(key,endpoint,body,row)
        except (ValueError,AccountUnavailable) as exc:handler._json({'error':{'message':str(exc),'type':'provider_error'}},400 if isinstance(exc,ValueError) and not isinstance(exc,AccountUnavailable) else 502);return
        with upstream:
            if body.get('stream'):
                if 'text/event-stream' not in upstream.headers.get('Content-Type',''):
                    handler._json({'error':{'message':'平台没有返回事件流','type':'provider_error'}},502);return
                handler.send_response(200);handler.send_header('Content-Type','text/event-stream; charset=utf-8');handler.send_header('Cache-Control','no-store');handler.send_header('Connection','close');handler.end_headers();handler.close_connection=True
                data=[];connected=True;last_packet=None
                def inspect():
                    nonlocal last_packet
                    if not data:return
                    try:
                        packet=json.loads('\n'.join(data));last_packet=packet
                        terminal=endpoint=='chat/completions' or packet.get('type') in ('response.completed','response.incomplete','response.failed')
                        if terminal:self.capture(owner,row,packet,body['model'],request_id)
                    except (ValueError,UnicodeError):pass
                    data.clear()
                def lines():
                    try:
                        yield from upstream
                    except OSError:return
                for line in lines():
                    if len(line)>4*1024*1024 or sum(len(v) for v in data)>4*1024*1024:break
                    if line.strip()==b'':inspect()
                    elif line.startswith(b'data:'):
                        value=line[5:].decode('utf-8').strip()
                        if value!='[DONE]':data.append(value)
                    if connected:
                        try:handler.wfile.write(line);handler.wfile.flush()
                        except (BrokenPipeError,ConnectionResetError):connected=False
                inspect()
                self.capture(owner,row,last_packet or {},body['model'],request_id,allow_missing=True)
            else:
                raw=upstream.read(16*1024*1024+1)
                if len(raw)>16*1024*1024:handler._json({'error':{'message':'平台响应过大','type':'provider_error'}},502);return
                try:response=json.loads(raw)
                except ValueError:handler._json({'error':{'message':'平台响应格式不正确','type':'provider_error'}},502);return
                self.capture(owner,row,response,body['model'],request_id,allow_missing=True);handler._json(response)
