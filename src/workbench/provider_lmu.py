import hashlib
import json
import time
from datetime import datetime, timedelta, timezone
from urllib import request, error
from urllib.parse import urlencode

from workbench.provider_usage import integer, timestamp
from workbench.provider_finance import amount
from workbench.usage_accounts import AccountUnavailable

ORIGIN='https://api.lmuai.ai'
SECRET='lmu:platform'

class Expired(AccountUnavailable):pass

def fetch(path,token='',body=None):
    class NoRedirect(request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs):return None
    headers={'Accept':'application/json','Content-Type':'application/json','User-Agent':'LingxiWorkbench'}
    if token:headers['Authorization']='Bearer '+token
    req=request.Request(ORIGIN+'/api/v1/'+path,headers=headers,data=json.dumps(body).encode() if body is not None else None)
    try:
        with request.build_opener(NoRedirect).open(req,timeout=25) as response:raw=response.read(2*1024*1024+1)
        if len(raw)>2*1024*1024:raise AccountUnavailable('LMU 响应过大，请缩短范围')
        result=json.loads(raw)
        if not isinstance(result,dict) or result.get('code')!=0 or not isinstance(result.get('data'),dict):raise AccountUnavailable('LMU 查询失败，请核对登录或查询权限')
        return result['data']
    except error.HTTPError as exc:
        if exc.code==401:raise Expired('LMU 登录已过期，请重新授权') from None
        raise AccountUnavailable({403:'LMU 没有查询权限',429:'LMU 查询限流，请稍后重试'}.get(exc.code,'LMU 查询失败，请稍后重试')) from None
    except (OSError,ValueError):raise AccountUnavailable('LMU 连接失败或响应格式不正确') from None

def normalize(items,connection,key_id):
    rows=[];seen=set()
    for item in items:
        if not isinstance(item,dict) or item.get('api_key_id')!=key_id:raise AccountUnavailable('LMU 返回了其他 Key 的用量，已停止导入')
        at=timestamp(item.get('created_at'));model=item.get('model');identity=item.get('id') or item.get('request_id')
        values=[integer(item.get(k)) for k in ('input_tokens','output_tokens','cache_read_tokens','cache_creation_tokens')]
        if not at or not isinstance(model,str) or not model or len(model)>180 or identity is None or None in values:raise AccountUnavailable('LMU 用量字段不完整，已停止导入')
        identity=connection['id']+':lmu:'+str(identity)[:180]
        if identity in seen:raise AccountUnavailable('LMU 分页返回重复记录，已停止导入')
        seen.add(identity);uncached,output,cached,created=values;input_tokens=uncached+cached+created;total=integer(input_tokens+output)
        if total is None:raise AccountUnavailable('LMU Token 数值超出范围')
        cost=amount(item.get('actual_cost'))
        rows.append({'id':identity,'at':at,'source':'official-api','agent':'','provider':'LMU','model':model,'project':'','session':'','connection_id':connection['id'],'requested_model':'','auth_mode':'api_key','status':'ok','input':input_tokens,'output':output,'cached':cached,'reasoning':None,'total':total,'cost':float(cost) if cost is not None else None,'currency':'USD','duration_ms':integer(item.get('duration_ms')),'platform_requests':1})
    return rows

class Client:
    def __init__(self,control,owner):self.control=control;self.owner=owner
    def load(self):
        raw=self.control.credentials(self.owner).get(SECRET)
        try:return json.loads(raw) if raw else {}
        except (TypeError,ValueError):return {}
    def store(self,value):
        keys=self.control.credentials(self.owner);keys[SECRET]=json.dumps(value);self.control.save_credentials(self.owner,keys)
    def tokens(self,data,previous=None):
        token=data.get('access_token');refresh=data.get('refresh_token') or (previous or {}).get('refresh_token','')
        if not isinstance(token,str) or not token or len(token)>8192 or any(c.isspace() for c in token):raise AccountUnavailable('LMU 未返回有效登录授权')
        if not isinstance(refresh,str) or len(refresh)>8192 or any(c.isspace() for c in refresh):raise AccountUnavailable('LMU 续期凭据格式不正确')
        return {'access_token':token,'refresh_token':refresh,'expires_at':time.time()+min(86400,max(60,integer(data.get('expires_in')) or 86400))}
    def api(self,path):
        with self.control.lock:
            credentials=self.load()
            if not credentials.get('access_token'):raise AccountUnavailable('请先授权 LMU 平台；APIKey 不能查询历史用量')
            refreshed=False
            if credentials.get('expires_at',0)<=time.time()+60 and credentials.get('refresh_token'):
                credentials=self.tokens(fetch('auth/refresh',body={'refresh_token':credentials['refresh_token']}),credentials);self.store(credentials);refreshed=True
            try:return fetch(path,credentials['access_token'])
            except Expired:
                if refreshed or not credentials.get('refresh_token'):raise
                credentials=self.tokens(fetch('auth/refresh',body={'refresh_token':credentials['refresh_token']}),credentials);self.store(credentials)
                return fetch(path,credentials['access_token'])
    def key_id(self,key,token=None):
        matches=[];count=0
        for page in range(1,101):
            path='keys?'+urlencode({'page':page,'page_size':200})
            data=fetch(path,token) if token else self.api(path);items=data.get('items')
            if not isinstance(items,list):raise AccountUnavailable('LMU 未返回 Key 列表')
            count+=len(items)
            matches.extend(row.get('id') for row in items if isinstance(row,dict) and row.get('key')==key)
            pages=integer(data.get('pages'));total=integer(data.get('total'))
            if pages is not None and page>=max(1,pages) or pages is None and total is not None and count>=total or pages is None and total is None and len(items)<200:break
        else:raise AccountUnavailable('LMU Key 列表分页未完成')
        if len(matches)!=1 or not isinstance(matches[0],int) or isinstance(matches[0],bool) or matches[0]<=0:raise AccountUnavailable('LMU 登录账户中未找到唯一对应的 APIKey')
        return matches[0]
    def authorize(self,body,connections):
        with self.control.lock:
            if body.get('totpCode'):
                pending=self.control.credentials(self.owner).get('lmu:pending')
                if not pending:raise AccountUnavailable('请重新登录 LMU')
                data=fetch('auth/login/2fa',body={'temp_token':pending,'totp_code':str(body['totpCode'])})
            elif body.get('accessToken'):
                data={'access_token':str(body['accessToken']).strip(),'refresh_token':str(body.get('refreshToken') or '').strip(),'expires_in':86400}
            else:
                email=str(body.get('email') or '').strip();password=body.get('password')
                if not email or len(email)>254 or not isinstance(password,str) or not password or len(password)>4096:raise ValueError('请填写 LMU 邮箱和密码')
                data=fetch('auth/login',body={'email':email,'password':password})
                if data.get('requires_2fa') is True:
                    pending=data.get('temp_token')
                    if not isinstance(pending,str) or not pending or len(pending)>8192:raise AccountUnavailable('LMU 二次验证响应不正确')
                    keys=self.control.credentials(self.owner);keys['lmu:pending']=pending;self.control.save_credentials(self.owner,keys);return {'requires2FA':True}
            credentials=self.tokens(data);user=fetch('auth/me',credentials['access_token'])
            if not integer(user.get('id')):raise AccountUnavailable('LMU 未返回账户标识')
            keys=self.control.credentials(self.owner)
            for row in connections:self.key_id(keys.get('usage:'+row['id'],''),credentials['access_token'])
            self.store(credentials);keys=self.control.credentials(self.owner);keys.pop('lmu:pending',None);self.control.save_credentials(self.owner,keys)
            return {'ok':True}
    def history(self,connection,key,start=None):
        key_id=self.key_id(key);now=datetime.now(timezone(timedelta(hours=8)));start=start or (now-timedelta(days=365)).date();end=now.date();items=[]
        for page in range(1,501):
            data=self.api('usage?'+urlencode({'page':page,'page_size':200,'start_date':start.isoformat(),'end_date':end.isoformat(),'timezone':'Asia/Shanghai','api_key_id':key_id,'sort_by':'created_at','sort_order':'asc'}));batch=data.get('items');pages=integer(data.get('pages'));total=integer(data.get('total'))
            if not isinstance(batch,list) or pages is None or total is None or pages>500:raise AccountUnavailable('LMU 用量分页不完整或超过查询上限')
            items.extend(batch)
            if page>=max(1,pages):
                if len(items)!=total:raise AccountUnavailable('LMU 分页总量不一致，请重试')
                break
            time.sleep(.15)
        else:raise AccountUnavailable('LMU 用量分页未完成')
        rows=normalize(items,connection,key_id);user=self.api('auth/me');account_id=integer(user.get('id'))
        finance={'currency':'USD','balance':float(amount(user.get('balance'))) if amount(user.get('balance')) is not None else None,'spent':None,'accountRef':hashlib.sha256(('LMU:'+str(account_id)).encode()).hexdigest() if account_id else None}
        return {'historyRows':rows,'historyAvailable':True,'historyDays':366,'financeVersion':1,'accountFinance':finance,'coverage':'LMU 官方历史 · 所选 Key','unavailable':{'cost':'部分费用未返回'} if any(r['cost'] is None for r in rows) else {}}
