"""One-pass aggregation; bucket summaries are reused across date/model filters."""
from collections import defaultdict
from datetime import datetime,timedelta,timezone
from decimal import Decimal,localcontext
from workbench.ai_monitor import FIELDS,decimal_total,iso
from workbench.usage_dates import date_range


def summary(entries,currency='CNY'):
    totals={k:0 for k in FIELDS};missing={k:0 for k in FIELDS};costs=defaultdict(Decimal);parts=defaultdict(Decimal)
    failures=unknown=priced=cost_unknown=0;requests=0;requests_known=True;issues=defaultdict(int)
    with localcontext() as ctx:
        ctx.prec=100
        for r in entries:
            for k in FIELDS:
                value=r.get(k);missing[k]+=value is None;totals[k]+=value or 0
            failures+=r.get('status') in ('error','failed','cancelled');unknown+=r.get('total') is None
            cost=r.get('cost');priced+=cost is not None;cost_unknown+=cost is None or r.get('currency')!=currency
            if cost is None and r.get('valueReason'):issues[r['valueReason']]+=1
            if cost is not None:costs[r.get('currency','CNY')]+=Decimal(str(cost))
            for k,v in r.get('valueParts',{}).items():parts[k]+=Decimal(str(v))
            n=r.get('platform_requests')
            if n is None and r.get('granularity','request')=='request':n=1
            if n is None:requests_known=False
            else:requests+=n
    return dict(totals,requests=len(entries),observations=len(entries),requestCount=requests if requests_known else None,
        unknown=unknown,failures=failures,unknownFields=missing,costExact={c:str(v) for c,v in costs.items()},
        costs={c:float(v) for c,v in costs.items()},valueParts={k:str(parts[k]) for k in ('input','cached','write','output')},
        costUnknown=cost_unknown,pricedRequests=priced,platformRequests=requests if requests_known else None,valueIssues=dict(issues))


def merge(items,currency='CNY'):
    out=summary([],currency);exact=defaultdict(Decimal);parts=defaultdict(Decimal);requests_known=True;issues=defaultdict(int)
    with localcontext() as ctx:
        ctx.prec=100
        for s in items:
            for k in (*FIELDS,'requests','observations','unknown','failures','costUnknown','pricedRequests'):out[k]+=s[k]
            for k in FIELDS:out['unknownFields'][k]+=s['unknownFields'][k]
            for c,v in s['costExact'].items():exact[c]+=Decimal(v)
            for k,v in s['valueParts'].items():parts[k]+=Decimal(v)
            for k,v in s.get('valueIssues',{}).items():issues[k]+=v
            if s['requestCount'] is None:requests_known=False
            else:out['requestCount']+=s['requestCount']
    out.update(costExact={c:str(v) for c,v in exact.items()},costs={c:float(v) for c,v in exact.items()},valueParts={k:str(parts[k]) for k in ('input','cached','write','output')})
    out['requestCount']=out['platformRequests']=out['requestCount'] if requests_known else None
    out['valueIssues']=dict(issues)
    return out


class Dataset:
    def __init__(self,rows,currency,range_earliest=None):
        self.rows=rows;self.currency=currency;self.range_earliest=range_earliest;groups=defaultdict(list);self.row_index={k:defaultdict(list) for k in ('source','provider','model','project','connection_id')}
        for r in rows:
            if 'local_date' not in r:r['local_date']=datetime.fromisoformat(r['at'].replace('Z','+00:00')).astimezone(timezone(timedelta(hours=8))).date().isoformat()
            key=tuple(r.get(k,'') for k in ('source','agent','provider','model','project','connection_id','local_date'))
            groups[key].append(r)
            for k,index in self.row_index.items():index[r.get(k,'')].append(r)
        self.buckets=[(key,summary(values,currency),max(r['at'] for r in values)) for key,values in groups.items()]
        self.options={k:sorted({r.get(k,'') for r in rows if r.get(k)}) for k in ('source','provider','model','project')}

    def snapshot(self,days=30,source='',provider='',model='',project='',scope='',connection_id='',include_all=False,period='',start_date='',end_date='',models=None):
        now=datetime.now(timezone(timedelta(hours=8)))
        if models is not None and (not isinstance(models,list) or any(not isinstance(m,str) or len(m)>300 for m in models)):raise ValueError('模型筛选格式不正确')
        selected=set(filter(None,models)) if models is not None else {model} if model else set()
        def match(key):return (not source or key[0]==source) and (not provider or key[2]==provider) and (not selected or key[3] in selected) and (not project or key[4]==project) and (not connection_id or key[5]==connection_id)
        picked=[b for b in self.buckets if match(b[0])]
        earliest=min((datetime.fromisoformat(b[0][6]).date() for b in picked),default=now.date())
        if period=='all' and self.range_earliest is not None:earliest=min(earliest,self.range_earliest)
        start,end=date_range(max(1,min(366,int(days))),period,start_date,end_date,now.date(),earliest)
        by_day=defaultdict(list);by_group=defaultdict(list);group_at={};day_models=defaultdict(lambda:defaultdict(list))
        for key,s,at in picked:
            by_day[key[6]].append(s)
            day_models[key[6]][key[2:4]].append(s)
            if start.isoformat()<=key[6]<=end.isoformat():by_group[key[:4]].append(s);group_at[key[:4]]=max(group_at.get(key[:4],''),at)
        day_values={d:merge(v,self.currency) for d,v in by_day.items()};daily=[];empty=summary([],self.currency)
        for i in range((end-start).days+1):
            day=(start+timedelta(days=i)).isoformat();models_by=day_models[day]
            daily.append(dict(date=day,**day_values.get(day,empty),models=[dict(provider=p,model=m,**merge(values,self.currency)) for (p,m),values in sorted(models_by.items())]))
        activity=[];activity_start=(end-timedelta(days=365)).isoformat();older=merge([s for d,s in day_values.items() if d<activity_start],self.currency)
        running={k:older[k] for k in ('total','requests','unknown')};money=Decimal(older['costExact'].get(self.currency,'0'));unknown=older['costUnknown']
        with localcontext() as ctx:
            ctx.prec=100
            for i in range(366):
                day=(end-timedelta(days=365-i)).isoformat();s=day_values.get(day,empty)
                for k in running:running[k]+=s[k]
                money+=Decimal(s['costExact'].get(self.currency,'0'));unknown+=s['costUnknown']
                activity.append(dict(date=day,**s,cumulativeTotal=running['total'],cumulativeRequests=running['requests'],cumulativeUnknown=running['unknown'],cumulativeCost=float(money),cumulativeCostExact=str(money),cumulativeCostUnknown=unknown))
        active=sorted(d for d,s in day_values.items() if s['total']>0 and d<=end.isoformat());longest=current=0;previous=None
        for day in active:
            d=datetime.fromisoformat(day).date();current=current+1 if previous and (d-previous).days==1 else 1;longest=max(longest,current);previous=d
        streak=current if active and active[-1] in (end.isoformat(),(end-timedelta(days=1)).isoformat()) else 0
        events=[];candidates=[self.rows]
        for field,value in (('source',source),('provider',provider),('project',project),('connection_id',connection_id)):
            if value:candidates.append(self.row_index[field].get(value,[]))
        if selected:
            model_rows=[r for m in selected for r in self.row_index['model'].get(m,[])]
            if len(selected)>1:model_rows.sort(key=lambda r:r['at'],reverse=True)
            candidates.append(model_rows)
        for r in min(candidates,key=len):
            key=tuple(r.get(k,'') for k in ('source','agent','provider','model','project','connection_id','local_date'))
            if match(key) and start.isoformat()<=key[6]<=end.isoformat():
                events.append({k:v for k,v in r.items() if k!='owner'})
                if not include_all and len(events)>=100:break
        return dict(origin=scope if scope in ('codex','zcode','dsh') else 'observed',summary=merge([s for d,s in day_values.items() if start.isoformat()<=d<=end.isoformat()],self.currency),
            lifetime=dict(merge([b[1] for b in picked],self.currency),peak=max((day_values[d]['total'] for d in active),default=0),currentStreak=streak,longestStreak=longest),
            budgets={'today':day_values.get(end.isoformat(),empty)['total'],'month':sum(s['total'] for d,s in day_values.items() if d[:7]==end.isoformat()[:7])},
            activity=activity,daily=daily,groups=[dict(zip(('source','agent','provider','model'),key),**merge(values,self.currency),at=group_at[key]) for key,values in sorted(by_group.items())],
            events=events,options=self.options,range=dict(start=start.isoformat(),end=end.isoformat(),earliest=earliest.isoformat()),timezone='Asia/Shanghai',updatedAt=iso())
