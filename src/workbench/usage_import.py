"""Preview usage files without retaining uploads or credentials."""
import csv
import io
import json
from datetime import datetime, timezone, timedelta

ALIASES={
    'at':('at','timestamp','created','时间','日期'), 'id':('id','request_id','请求ID'),
    'model':('model','模型','模型名称'), 'requested_model':('requested_model','请求模型'),
    'input':('input','input_tokens','prompt_tokens','输入Token'),
    'output':('output','output_tokens','completion_tokens','输出Token'),
    'cached':('cached','cached_input_tokens','prompt_cache_hit_tokens','缓存Token'),
    'reasoning':('reasoning','reasoning_tokens','推理Token'), 'total':('total','total_tokens','总Token'),
    'cost':('cost','费用'), 'currency':('currency','币种'), 'provider':('provider','服务商'),
}

def parse_file(body):
    text=body.get('text')
    if not isinstance(text,str) or len(text.encode('utf-8'))>8*1024*1024:raise ValueError('请选择不超过 8 MB 的用量文件')
    text=text.lstrip('\ufeff');mapping=body.get('mapping') or {};kind=body.get('format','json');headers=[]
    if not isinstance(mapping,dict) or any(k not in ALIASES or not isinstance(v,str) for k,v in mapping.items()):raise ValueError('字段映射格式不正确')
    if kind=='csv':
        reader=csv.DictReader(io.StringIO(text));headers=reader.fieldnames or []
        if not headers or len(headers)!=len(set(headers)):raise ValueError('CSV 需要不重复的标题行')
        mapping={k:mapping.get(k,next((a for a in aliases if a in headers),'')) for k,aliases in ALIASES.items()}
        if not mapping['at'] or not mapping['model'] or not (mapping['total'] or (mapping['input'] and mapping['output'])):
            return {'records':None,'headers':headers,'mapping':mapping,'needsMapping':True}
        rows=[]
        for index,raw in enumerate(reader,2):
            if len(rows)>=10000:raise ValueError('一次最多导入 10000 条记录')
            if None in raw:raise ValueError('CSV 第 '+str(index)+' 行字段数量不正确')
            row={k:(raw.get(v) or '').strip() for k,v in mapping.items() if v}
            for key in ('input','output','cached','reasoning','total'):
                if key in row:
                    if row[key]=='':row.pop(key);continue
                    try:row[key]=int(row[key])
                    except ValueError:raise ValueError('CSV 第 '+str(index)+' 行 '+key+' 必须是整数') from None
            if row.get('cost'):
                try:row['cost']=float(row['cost'])
                except ValueError:raise ValueError('CSV 费用必须是数字') from None
            else:row.pop('cost',None)
            if not row.get('at') or not row.get('model'):raise ValueError('CSV 第 '+str(index)+' 行缺少时间或模型')
            try:
                stamp=datetime.fromisoformat(row['at'].replace('Z','+00:00'))
                if stamp.tzinfo is None:row['at']=stamp.replace(tzinfo=timezone(timedelta(hours=8))).isoformat()
            except ValueError:raise ValueError('CSV 第 '+str(index)+' 行时间格式不正确') from None
            if not row.get('id'):row.pop('id',None)
            if not row.get('currency'):row['currency']='CNY'
            rows.append(row)
    else:
        try:
            if kind=='jsonl':rows=[json.loads(line) for line in text.splitlines() if line.strip()]
            elif kind=='json':
                value=json.loads(text);rows=value if isinstance(value,list) else value.get('records',[value]) if isinstance(value,dict) else None
            else:raise ValueError('请使用 JSON、JSONL 或 CSV 文件')
        except json.JSONDecodeError:raise ValueError('用量文件不是有效的 JSON / JSONL') from None
    if not isinstance(rows,list) or len(rows)>10000 or any(not isinstance(r,dict) for r in rows):raise ValueError('文件需包含最多 10000 条对象记录')
    return {'records':rows,'headers':headers,'mapping':mapping,'needsMapping':False}
