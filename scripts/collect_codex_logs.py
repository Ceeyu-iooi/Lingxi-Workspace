from pathlib import Path
import json
import os


def collect(offset=0):
    root=Path(os.environ.get('CODEX_HOME',str(Path.home()/'.codex'))).resolve()
    paths=sorted({p.resolve() for kind in ('sessions','archived_sessions') for p in (root/kind).rglob('*.jsonl') if p.resolve().is_relative_to(root)})
    files=[];size=0;index=offset
    for index in range(offset,len(paths)):
        rows=[]
        with paths[index].open('rb') as stream:
            while True:
                line=stream.readline(8*1024*1024+1)
                if not line:break
                if len(line)>8*1024*1024:
                    if b'"response_item"' not in line[:600]:raise ValueError('单条用量证据过大')
                    while line and not line.endswith(b'\n'):line=stream.readline(1024*1024)
                    continue
                if not line.endswith(b'\n'):continue
                try:r=json.loads(line)
                except ValueError:
                    if b'"token_count"' in line[:600] and line.endswith(b'\n'):raise ValueError('用量证据损坏')
                    continue
                if not isinstance(r,dict):continue
                p=r.get('payload') or {};kind=r.get('type')
                if not isinstance(p,dict):continue
                if kind=='session_meta':p={k:v for k,v in p.items() if k in ('id','session_id','model_provider','cwd','timestamp','forked_from_id','originator')}
                elif kind=='turn_context':p={'model':p.get('model')}
                elif kind=='event_msg' and p.get('type')=='token_count':
                    info=p.get('info') or {}
                    if not isinstance(info,dict):raise ValueError('消费证据格式不正确')
                    p={'type':'token_count','info':{k:{f:v for f,v in val.items() if f in ('input_tokens','output_tokens','cached_input_tokens','cache_write_input_tokens','reasoning_output_tokens','total_tokens')} if isinstance(val,dict) else val for k,val in info.items() if k in ('last_token_usage','total_token_usage','response_id')},**({'response_id':p['response_id']} if p.get('response_id') else {})}
                else:continue
                rows.append(dict(type=kind,payload=p,**({k:r[k] for k in ('timestamp','response_id') if k in r})))
        if not any(r['type']=='event_msg' for r in rows):continue
        content=''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in rows);length=len(content.encode())
        if length>8*1024*1024:raise ValueError('单个会话证据过大，请分段导出并保留会话元数据')
        if files and (size+length>12*1024*1024 or len(files)>=100):return dict(files=files,next=index)
        files.append(dict(name=paths[index].name,content=content));size+=length
    return dict(files=files,next=None)


if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('--output',required=True);args=parser.parse_args()
    offset=0;part=0;target=Path(args.output)
    while True:
        result=collect(offset);part+=1
        path=target if part==1 and result['next'] is None else target.with_name(target.stem+'-'+str(part).zfill(3)+'.json')
        path.write_text(json.dumps(dict(kind='ssh',files=result['files']),ensure_ascii=False),encoding='utf-8')
        if result['next'] is None:break
        offset=result['next']
