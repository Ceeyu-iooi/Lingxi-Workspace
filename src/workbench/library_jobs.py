"""Account-scoped background jobs; no credentials or input bodies in logs."""
import copy
import threading
import time
import uuid


class Jobs:
    def __init__(self):
        self.lock = threading.RLock()
        self.items = {}

    def start(self, owner, kind, work):
        with self.lock:
            running = [j for j in self.items.values() if j['owner'] == owner and j['status'] == 'running']
            same = next((j for j in running if j['kind'] == kind), None)
            if same:
                return self.get(owner, same['id'])
            if len(running) >= 4:
                raise ValueError('已有任务正在运行，请稍后重试')
            self.items = {k: v for k, v in self.items.items() if time.time() - v['created'] < 3600}
            jid = uuid.uuid4().hex
            item = dict(id=jid, owner=owner, kind=kind, status='running', created=time.time(), progress=None)
            self.items[jid] = item

        def update(**values):
            with self.lock:
                item.update(values)

        def run():
            try:
                result = work(update)
                update(status='complete', result=result, finished=time.time())
            except Exception as error:
                update(status='failed', error=str(error)[:400] if isinstance(error, ValueError) else '任务未完成；已保存的数据保留，可重试', finished=time.time())
        threading.Thread(target=run, name='workbench-' + kind, daemon=True).start()
        return self.get(owner, jid)

    def get(self, owner, jid):
        with self.lock:
            item = self.items.get(jid)
            if not item or item['owner'] != owner:
                raise ValueError('任务不存在')
            return {k: copy.deepcopy(v) for k, v in item.items() if k != 'owner'}
