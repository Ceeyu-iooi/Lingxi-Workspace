"""Stable 8765 supervisor. Only the parent pauses, migrates and restarts."""
from pathlib import Path
import json
import os
import secrets
import subprocess
import sys
import time
import webbrowser
from urllib.request import urlopen
from workbench.profile_store import atomic_json,environment,web_layout,migrate,remove_old,compact_profile

from workbench.paths import project_root
CODE=project_root()
ORIGIN='http://127.0.0.1:'+os.environ.get('WORKBENCH_PORT','8765')

def capability():
    token=secrets.token_urlsafe(32)
    atomic_json(Path(web_layout(CODE)['root'])/'config/maintenance.json',dict(token=token,expires=time.time()+900))
    return ORIGIN+'/#/settings/data?maintenance='+token

def main():
    manage='--manage' in sys.argv
    try:
        with urlopen(ORIGIN+'/api/runtime',timeout=2) as r:current=json.load(r)
    except OSError:current=None
    if current:
        expected=json.loads((Path(web_layout(CODE)['data'])/'.shared-service.json').read_text())
        if current.get('profileId')!=expected['profileId'] or current.get('serviceId')!=expected['serviceId']:raise SystemExit('8765不是当前资料服务，拒绝连接')
        if manage:webbrowser.open(capability())
        else:print('8765已运行；本机资料维护入口：python run_web.py --manage')
        return
    from workbench.shared_runtime import ProfileLock
    supervisor_lock=ProfileLock(Path(web_layout(CODE)['root'])/'runtime/manager')
    child=None
    try:
        while True:
            profile=web_layout(CODE);data=Path(profile['data']);data.mkdir(parents=True,exist_ok=True)
            compact_profile(profile['root'])
            env={**os.environ,**environment(profile),'WORKBENCH_HOST':os.environ.get('WORKBENCH_HOST','127.0.0.1'),'WORKBENCH_PORT':os.environ.get('WORKBENCH_PORT','8765'),'WORKBENCH_MANAGED_WEB':'1','WORKBENCH_OPEN_BROWSER':'0','PYTHONUTF8':'1','PYTHONDONTWRITEBYTECODE':'1'}
            logs=Path(profile['root'])/'logs';logs.mkdir(parents=True,exist_ok=True)
            log=(logs/'web-runtime.log').open('ab')
            child=subprocess.Popen([sys.executable,'-B',str(CODE/'run_web.py'),'--backend'],cwd=CODE,env=env,stdin=subprocess.PIPE,stdout=log,stderr=log)
            if manage:
                url=capability();time.sleep(2);webbrowser.open(url);manage=False
            request=data/'.maintenance-request.json'
            maintenance=False
            while child.poll() is None:
                time.sleep(.5)
                if not request.exists():continue
                state=json.loads(request.read_text())
                if state.get('status')!='queued':continue
                maintenance=True
                state['status']='running';atomic_json(request,state)
                child.stdin.write(b'{"command":"shutdown","instance":""}\n');child.stdin.flush()
                try:child.wait(timeout=35)
                except subprocess.TimeoutExpired:
                    state.update(status='failed',error='后台未及时退出，未进行迁移');atomic_json(request,state);raise SystemExit(state['error'])
                try:
                    if state.get('action')=='remove-old':
                        result=remove_old(profile['root']);state.update(status='complete',result=result);atomic_json(request,state);break
                    result=migrate(profile['root'],state['target'])
                    # Commit locator only after complete, verified copy.
                    atomic_json(CODE/'.runtime/web-profile.json',dict(root=result['target']))
                    state.update(status='complete',result=result);atomic_json(Path(result['target'])/'data/.maintenance-request.json',state)
                except Exception as exc:
                    state.update(status='failed',error=str(exc));atomic_json(request,state)
                break
            log.close()
            if not maintenance:return
            if child.poll() is None:return
            # Failure restarts the original profile; successful locator restarts target.
    except KeyboardInterrupt:
        if child and child.poll() is None:
            child.stdin.close();child.wait(timeout=35)
    finally:supervisor_lock.close()

if __name__=='__main__':main()
