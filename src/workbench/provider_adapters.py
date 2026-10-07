"""Capability-based read-only adapters. Money/credits are never Token counts."""
from decimal import Decimal,InvalidOperation
from urllib import request,error
from urllib.parse import urlsplit
import hashlib,json,socket,ipaddress

PRESETS={
 'openrouter':{'name':'OpenRouter','url':'https://openrouter.ai/api/v1','hosts':['openrouter.ai'],'currency':'USD'},
 'newapi':{'name':'New API','url':'','currency':'USD'},
 'sub2api':{'name':'Sub2API','url':'','currency':'USD'},
 'custom_balance':{'name':'自定义余额','url':'','currency':None},
 'siliconflow':{'name':'硅基流动','url':'https://api.siliconflow.cn/v1','hosts':['api.siliconflow.cn'],'currency':'CNY'},
 'moonshot':{'name':'Moonshot','url':'https://api.moonshot.cn/v1','hosts':['api.moonshot.cn'],'currency':'CNY'},
 'minimax':{'name':'MiniMax','url':'https://api.minimaxi.com/v1','hosts':['api.minimaxi.com','api.minimax.io','www.minimax.cn'],'currency':'CNY'},
}
RELAY_KINDS={'deepseek','glm','openrouter','newapi','sub2api','siliconflow','moonshot','minimax'}

def inference_base(row):
    base=row['apiUrl'].rstrip('/')
    if row['kind']=='deepseek' and base.endswith('/user/balance'):base=base[:-len('/user/balance')]
    if row['kind']=='glm':
        p=urlsplit(base)
        if p.path in ('','/api/monitor/usage/model-usage'):base=p.scheme+'://'+p.netloc+'/api/paas/v4'
        if p.path=='/api/anthropic':raise ValueError('此地址使用 Messages 协议，不支持 OpenAI 响应采集')
    if row['kind'] in ('newapi','sub2api') and not base.endswith('/v1'):base+='/v1'
    return base

def validate_url(kind,url):
    from workbench.usage_accounts import UsageAccounts
    p=UsageAccounts.validate_history_url(url)
    if p.query:raise ValueError('供应商地址不能含查询参数')
    if kind in PRESETS and PRESETS[kind].get('hosts'):
        if p.hostname not in PRESETS[kind]['hosts'] or p.path not in ('','/v1','/api/v1'):raise ValueError('请使用供应商已配置区域的官方 API 地址')
    return p

def get_json(url,headers):
    from workbench.usage_accounts import AccountUnavailable
    class NoRedirect(request.HTTPRedirectHandler):
        def redirect_request(self,*args):return None
    p=urlsplit(url)
    if p.scheme!='https' or p.username or p.password:raise AccountUnavailable('供应商地址不正确')
    # Resolve configured hosts before sending any secret; private ranges are not supported.
    try:
        addresses=socket.getaddrinfo(p.hostname,p.port or 443,type=socket.SOCK_STREAM)
        if any(not ipaddress.ip_address(r[4][0]).is_global for r in addresses):raise AccountUnavailable('供应商地址指向内部网络')
        with request.build_opener(NoRedirect).open(request.Request(url,headers={'Accept':'application/json',**headers}),timeout=12) as response:body=response.read(2*1024*1024+1)
        if len(body)>2*1024*1024:raise AccountUnavailable('供应商响应过大')
        data=json.loads(body,parse_float=Decimal)
        if not isinstance(data,dict) or data.get('success') is False or data.get('status') is False or 'error' in data:raise AccountUnavailable('供应商未返回有效数据')
        return data
    except error.HTTPError as exc:raise AccountUnavailable({401:'查询凭据无效或过期',403:'此凭据没有查询权限',429:'供应商限流，请稍后重试'}.get(exc.code,'供应商查询失败')) from None
    except (OSError,ValueError):raise AccountUnavailable('供应商连接失败或响应格式不正确') from None

def amount(value):
    if value is None or isinstance(value,bool):return None
    try:v=Decimal(str(value))
    except InvalidOperation:return None
    return str(v) if v.is_finite() else None

def unwrap(data):return data.get('data',data) if isinstance(data,dict) else {}

def read(row,key,platform='',loader=get_json):
    from workbench.usage_accounts import AccountUnavailable
    kind=row['kind'];base=row['apiUrl'].rstrip('/');p=validate_url(kind,base)
    headers={'Authorization':'Bearer '+key};currency=PRESETS[kind]['currency']
    result={'coverage':'余额／额度与 Token 独立；没有历史接口的记录保持未知。','unavailable':{'tokens':'普通 Key 未提供历史 Token 查询'},'adapter':kind,'granularity':'account-snapshot','verifiedLive':loader is get_json}
    def get(path,auth=None):return loader(base+path,headers if auth is None else auth)
    balance=spent=None;ref=None
    if kind=='openrouter':
        d=unwrap(get('/key'));key_spend=amount(d.get('usage'));result['keyFinance']={k:amount(d.get(k)) for k in ('usage','usage_daily','usage_weekly','usage_monthly','limit')}
        result['quota']={'metric':'money','limit':amount(d.get('limit')),'used':key_spend,'currency':'USD'}
        try:
            c=unwrap(get('/credits'));credits=amount(c.get('total_credits'));used=amount(c.get('total_usage'))
            if credits is not None and used is not None:balance=str(Decimal(credits)-Decimal(used));spent=used
            # A key hash identifies a key, not an account; leave accountRef absent.
        except AccountUnavailable:result['unavailable']['balance']='余额查询需具有 credits 权限的凭据'
    elif kind=='siliconflow':
        body=get('/user/info')
        if body.get('code') not in (0,20000):raise AccountUnavailable('硅基流动未返回有效用户信息')
        d=unwrap(body);balance=amount(d.get('totalBalance'));identity=d.get('id')
        if identity is not None:ref=str(identity)
    elif kind=='moonshot':
        body=get('/users/me/balance')
        if body.get('code')!=0:raise AccountUnavailable('Moonshot 未返回有效余额')
        d=unwrap(body);balance=amount(d.get('available_balance'))
    elif kind=='newapi':
        origin=base[:-3] if base.endswith('/v1') else base
        status=unwrap(loader(origin+'/api/status',{}));unit=amount(status.get('quota_per_unit'))
        if unit is None or Decimal(unit)<=0:raise AccountUnavailable('New API 未返回可核验的金额配额单位')
        mode=row.get('credentialMode','key');auth={'Authorization':'Bearer '+(platform or key)}
        if row.get('userId'):auth['New-Api-User']=row['userId']
        d=unwrap(loader(origin+('/api/user/self' if mode=='account' else '/api/usage/token/'),auth))
        used=amount(d.get('used_quota' if mode=='account' else 'total_used'));available=amount(d.get('quota' if mode=='account' else 'total_available'))
        if available is None:raise AccountUnavailable('New API 未返回金额配额')
        balance=str(Decimal(available)/Decimal(unit));spent=str(Decimal(used)/Decimal(unit)) if used is not None else None
        currency=status.get('quota_currency',row.get('quotaCurrency','USD'))
        if currency not in ('USD','CNY'):currency=None;balance=spent=None
        result['quota']={'metric':'money','rawUnit':unit,'currency':currency,'unlimited':d.get('unlimited_quota') is True}
        if d.get('unlimited_quota') is True or mode=='account' and available=='-1':balance=None;result['quota']['unlimited']=True
        if mode=='account' and d.get('id') is not None:ref=str(d['id'])
    elif kind=='sub2api':
        origin=base[:-3] if base.endswith('/v1') else base;auth={'Authorization':'Bearer '+(platform or key)}
        me=loader(origin+'/api/v1/auth/me',auth)
        if me.get('code')!=0:raise AccountUnavailable('Sub2API 需要有效账户访问凭据')
        d=unwrap(me);balance=amount(d.get('balance'))
        if d.get('id') is not None:ref=str(d['id'])
        try:
            body=loader(origin+'/api/v1/usage/stats?period=month&timezone=Asia%2FShanghai',auth)
            if body.get('code')!=0:raise AccountUnavailable('月汇总不可用')
            d=unwrap(body);result['usageSummary']={'period':'month','granularity':'month','tokens':d.get('total_tokens'),'input':d.get('total_input_tokens'),'output':d.get('total_output_tokens'),'requests':d.get('total_requests'),'actualCost':amount(d.get('total_actual_cost'))}
        except AccountUnavailable:result['unavailable']['usageSummary']='账户月汇总暂不可用'
        try:
            d=unwrap(loader(origin+'/api/v1/usage/dashboard/stats',auth));spent=amount(d.get('total_actual_cost'))
        except AccountUnavailable:pass
    elif kind=='custom_balance':
        config=row.get('balanceMapping',{});endpoint=config.get('endpoint','/user/balance')
        if not re_path(endpoint):raise AccountUnavailable('余额端点路径不正确')
        auth={'x-api-key':key} if config.get('authMode')=='x-api-key' else headers;d=get(endpoint,auth)
        def mapped(name):
            v=d
            for part in config.get(name,'data.balance' if name=='remainingPath' else '').split('.'):
                if not part or not isinstance(v,dict):return None
                v=v.get(part)
            return amount(v)
        divisor=amount(config.get('divisor',1));currency=config.get('currency')
        if not divisor or Decimal(divisor)<=0 or currency not in ('USD','CNY'):raise AccountUnavailable('请在余额映射中明确币种与计量单位')
        balance=mapped('remainingPath');spent=mapped('usedPath')
        if balance is not None:balance=str(Decimal(balance)/Decimal(divisor))
        if spent is not None:spent=str(Decimal(spent)/Decimal(divisor))
    elif kind=='minimax':
        if row.get('credentialMode')!='subscription':result['coverage']='MiniMax 普通推理 Key：仅采集真实响应；订阅额度需要独立订阅 Key'
        else:
            origin=p.scheme+'://'+p.netloc;body=loader(origin+'/v1/token_plan/remains',headers)
            d=unwrap(body);resp=body.get('base_resp',d.get('base_resp',{}))
            if resp.get('status_code',0)!=0:raise AccountUnavailable('MiniMax 订阅凭据无效或权限不足')
            windows=d.get('model_remains')
            if not isinstance(windows,list):raise AccountUnavailable('MiniMax 未返回可识别额度窗口')
            result['platformQuota']={'windows':[{k:w.get(k) for k in ('model_name','current_interval_total_count','current_interval_usage_count','start_time','end_time','remains_time')} for w in windows]}
            result['coverage']='MiniMax 订阅额度快照；次数、积分与 Token 分开'
    if ref is not None:ref=hashlib.sha256((kind+':'+p.netloc+':'+ref).encode()).hexdigest()
    result['accountFinance']={'currency':currency,'balance':float(Decimal(balance)) if balance is not None else None,'spent':float(Decimal(spent)) if spent is not None else None,'balanceExact':balance,'spentExact':spent,'accountRef':ref}
    result['accountFinance']['scope']='key' if kind=='newapi' and row.get('credentialMode','key')=='key' else 'account'
    return result

def re_path(path):
    return isinstance(path,str) and path.startswith('/') and not path.startswith('//') and '\\' not in path and not any(x in path.split('/') for x in ('.','..')) and '?' not in path and '#' not in path
