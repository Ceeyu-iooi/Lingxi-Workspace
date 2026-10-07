from datetime import datetime, timezone, timedelta
import math


def integer(value):
    if isinstance(value,bool) or not isinstance(value,(int,float)) or value<0 or value>2**53-1 or not math.isfinite(value) or value!=int(value):
        return None
    return int(value)


def timestamp(value):
    if not isinstance(value,str):return None
    try:
        dt=datetime.fromisoformat(value.replace('Z','+00:00'))
        if dt.tzinfo is None:dt=dt.replace(tzinfo=timezone(timedelta(hours=8)))
        return dt.astimezone(timezone.utc).isoformat().replace('+00:00','Z')
    except (ValueError,OverflowError):return None


def normalize_glm(data,connection):
    if not isinstance(data,dict):return []
    times=data.get('x_time')
    if not isinstance(times,list) or len(times)>10000:return []
    series=data.get('modelDataList')
    if not isinstance(series,list) or not series:
        series=[{'modelName':'平台未区分模型','tokensUsage':data.get('tokensUsage')}]
    rows=[];seen=set()
    if len(series)>100:return []
    for item in series:
        if not isinstance(item,dict):continue
        values=item.get('tokensUsage');model=item.get('modelName')
        if not isinstance(values,list) or len(values)!=len(times) or not isinstance(model,str) or not model or len(model)>180:continue
        for i,(date,value) in enumerate(zip(times,values)):
            at=timestamp(date);total=integer(value);identity=(model,at)
            if at is None or total is None or identity in seen:continue
            seen.add(identity)
            rows.append({'id':connection['id']+':'+model+':'+at,'at':at,'source':'official-api','agent':'','provider':'GLM','model':model,'project':'','session':'','connection_id':connection['id'],'requested_model':'','auth_mode':'api_key','status':'ok','input':None,'output':None,'cached':None,'reasoning':None,'total':total,'cost':None,'currency':'CNY','duration_ms':None,'granularity':'bucket','provenance':{'type':'official-history','parserVersion':'usage-v18'}})
            if len(rows)>10000:return []
    return rows


def normalize_glm_calls(data):
    if not isinstance(data,dict):return []
    times=data.get('x_time');counts=data.get('modelCallCount')
    if not isinstance(times,list) or not isinstance(counts,list) or len(times)!=len(counts) or len(times)>10000:return []
    result=[]
    for date,count in zip(times,counts):
        at=timestamp(date);value=integer(count)
        if at is not None and value is not None:result.append({'at':at,'count':value})
    return result


def normalize_history(data,connection,deepseek=False):
    from workbench.ai_monitor import iso,tokens
    import hashlib,json
    if deepseek:
        series=data.get('series') if isinstance(data,dict) else None
        if not isinstance(series,list):raise ValueError('历史用量响应缺少模型时间桶')
        records=[]
        for series_row in series:
            if not isinstance(series_row,dict):continue
            identity=(series_row.get('api_key') or {}).get('tracking_id')
            if identity!=connection.get('keyTrackingId'):continue
            for bucket in series_row.get('buckets',[]):
                def counter(value):return integer(int(value)) if isinstance(value,str) and value.isascii() and value.isdigit() and len(value)<=16 else integer(value)
                u=bucket.get('usage',{});hit=counter(u.get('PROMPT_CACHE_HIT_TOKEN'));miss=counter(u.get('PROMPT_CACHE_MISS_TOKEN'));output=counter(u.get('RESPONSE_TOKEN'))
                if None in (hit,miss,output):raise ValueError('历史 Token 数值不正确')
                records.append({'at':bucket.get('time'),'model':series_row.get('model'),'input':hit+miss,'output':output,'cached':hit,'total':hit+miss+output,'requests':counter(u.get('REQUEST'))})
    else:
        records=data if isinstance(data,list) else data.get('records',data.get('data')) if isinstance(data,dict) else None
        if isinstance(records,dict):records=records.get('records')
        if not isinstance(records,list):raise ValueError('历史接口需返回 records 或 data 列表')
        expanded=[]
        for record in records:
            if not isinstance(record,dict):raise ValueError('历史记录格式不正确')
            if isinstance(record.get('results'),list):expanded.extend({**r,'at':record.get('start_time'),'requests':r.get('num_model_requests')} for r in record['results'])
            else:expanded.append(record)
        records=expanded
    if len(records)>10000:raise ValueError('历史记录超过 10000 条，请缩短查询范围')
    rows=[];seen=set()
    for record in records:
        when=record.get('at',record.get('date',record.get('timestamp')))
        if when is None:raise ValueError('历史记录缺少日期')
        if isinstance(when,str) and when.isascii() and when.isdigit() and len(when)<=13:when=int(when)
        if isinstance(when,(int,float)) and when>10**12:when/=1000
        if isinstance(when,str):when=timestamp(when)
        if when is None:raise ValueError('历史日期不正确')
        at=iso(when);usage=tokens(record.get('usage',record))
        if not usage or usage['total'] is None:raise ValueError('历史记录缺少有效 Token 数值')
        if any(v is not None and integer(v) is None for v in usage.values()):raise ValueError('历史 Token 超出有效范围')
        if usage['input'] is not None and usage['output'] is not None and usage['input']+usage['output']!=usage['total']:raise ValueError('历史输入与输出合计不等于总 Token')
        model=record.get('model') or '平台未区分模型'
        if not isinstance(model,str) or len(model)>180:raise ValueError('历史模型名不正确')
        identity=record.get('id') or hashlib.sha256(json.dumps([at,model,record.get('api_key_id')],ensure_ascii=False).encode()).hexdigest()
        identity=connection['id']+':history:'+str(identity)[:200]
        if identity in seen:raise ValueError('历史记录存在重复标识')
        seen.add(identity)
        if not deepseek:
            u=record.get('usage',record)
            if not any(k in u for k in ('cached','cached_input_tokens','prompt_cache_hit_tokens','input_tokens_details','prompt_tokens_details')):usage['cached']=None
            if not any(k in u for k in ('reasoning','reasoning_output_tokens','completion_tokens_details')):usage['reasoning']=None
        from workbench.provider_finance import amount
        cost=amount(record.get('cost'))
        rows.append({'id':identity,'at':at,'source':'official-api','agent':'','provider':'DeepSeek' if deepseek else connection['name'],'model':model,'project':'','session':'','connection_id':connection['id'],'requested_model':'','auth_mode':'api_key','status':'ok',**usage,'cost':float(cost) if cost is not None else None,'currency':record.get('currency','CNY'),'duration_ms':None,'granularity':'bucket','platform_requests':integer(record.get('requests'))})
    return rows
