"""Official account buckets are a distinct source, never local request events."""
from datetime import date,datetime,timedelta,timezone
from workbench.usage_summary import Dataset
from workbench.usage_dates import date_range
from workbench.ai_monitor import FIELDS,iso

def count(value):
    return value if isinstance(value,int) and not isinstance(value,bool) and 0<=value<=2**53-1 else None

def normalize(value):
    if not isinstance(value,dict):raise ValueError('官方账户活动结构不正确')
    summary=value.get('summary') or {}
    if not isinstance(summary,dict):raise ValueError('官方账户汇总结构不正确')
    result={'summary':{k:count(summary.get(k)) for k in ('lifetimeTokens','peakDailyTokens','longestRunningTurnSec','currentStreakDays','longestStreakDays')},'dailyUsageBuckets':None}
    buckets=value.get('dailyUsageBuckets')
    if buckets is not None:
        if not isinstance(buckets,list) or len(buckets)>10000:raise ValueError('官方日期桶结构不正确')
        seen=set();clean=[]
        for bucket in buckets:
            if not isinstance(bucket,dict):raise ValueError('官方日期桶结构不正确')
            day=date.fromisoformat(bucket['startDate']).isoformat();tokens=count(bucket.get('tokens'))
            if tokens is None or day in seen:raise ValueError('官方日期桶重复或数量无效')
            seen.add(day);clean.append({'startDate':day,'tokens':tokens})
        result['dailyUsageBuckets']=sorted(clean,key=lambda r:r['startDate'])
    return result

def snapshot(value,days=30,error='',observed='',**params):
    value=normalize(value) if value else {'summary':{},'dailyUsageBuckets':None}
    rows=[dict(id='account-day:'+r['startDate'],at=r['startDate']+'T00:00:00Z',local_date=r['startDate'],source='official',agent='Codex',provider='',model='',project='',connection_id='',granularity='day',total=r['tokens'],input=None,output=None,cached=None,reasoning=None,cost=None,status='aggregate') for r in value['dailyUsageBuckets'] or []]
    allowed={k:v for k,v in params.items() if k in ('period','start_date','end_date','include_all')}
    result=Dataset(rows,'CNY').snapshot(days=days,scope='codex',**allowed)
    buckets={r['startDate']:r['tokens'] for r in value['dailyUsageBuckets'] or []}
    for item in [result['summary'],result['lifetime'],*result['daily'],*result['activity']]:
        for k in FIELDS:
            if k!='total':item[k]=None
        item.update(requests=None,requestCount=None,platformRequests=None)
        if 'date' in item:
            item['total']=buckets.get(item['date']);item['provided']=item['date'] in buckets;item['unknown']=int(not item['provided'])
            item['cumulativeTotal']=None;item['cumulativeUnknown']=1
    if value['dailyUsageBuckets'] is None:result['summary']['total']=None
    s=value['summary'];result['lifetime'].update(total=s.get('lifetimeTokens'),peak=s.get('peakDailyTokens'),currentStreak=s.get('currentStreakDays'),longestStreak=s.get('longestStreakDays'),longestRunningTurnSec=s.get('longestRunningTurnSec'))
    available=any(v is not None for v in s.values()) or bool(buckets)
    message='官方账户活动；按接口原始日期桶展示，无模型、工作区和请求明细；未返回的日期不补零'
    if not available:message=error or '官方账户活动尚未返回，请同步 Codex 账户；可切换本机日志查看独立统计'
    result.update(origin='official-codex-account',available=available,aggregated=True,platformRequests=None,groups=[],events=[],timezone='official-date-buckets',pricing={'enabled':False},dataVersion=observed or 'official-unavailable',options={'source':['official','codex'],'provider':[],'project':[],'model':[]},accounting={'incomplete':not available,'message':message},dataSource={'kind':'official-account','label':'官方账户汇总','method':'account/usage/read','message':message},updatedAt=observed or iso())
    return result
