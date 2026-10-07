"""Account/scope preparation barrier, cancellation and durable reload status."""
from datetime import datetime, timezone
from pathlib import Path
import threading
import time
import uuid

FLAGS = dict(codex='codexValuationEnabled', zcode='zcodeValuationEnabled', dsh='dshValuationEnabled')


class ValuationTasks:
    def __init__(self, services):
        self.s = services
        self.lock = threading.RLock()
        self.live = set()

    def path(self, owner, scope):
        if scope not in FLAGS:
            raise ValueError('计价工具不正确')
        return self.s.documents.data / 'users' / owner / ('valuation-' + scope + '.json')

    def status(self, owner, scope):
        with self.lock:
            state = self.s.documents.read(self.path(owner, scope), dict(status='idle', scope=scope))
            if state.get('status') == 'running' and state.get('id') not in self.live:
                state.update(status='failed', error='后台重启，准备尚未完成；请重试或取消')
                self.s.documents.write(self.path(owner, scope), state)
            return state

    def disable(self, owner, scope):
        with self.lock:
            state = self.status(owner, scope)
            state.update(status='cancelled', finished=time.time())
            self.s.documents.write(self.path(owner, scope), state)
            self.s.control.update_config(owner, {FLAGS[scope]: False})
            return dict(features=self.s.features(owner), task=state)

    def start(self, owner, scope):
        with self.lock:
            current = self.status(owner, scope)
            if current['status'] == 'running':
                return current
            token = uuid.uuid4().hex
            state = dict(id=token, scope=scope, status='running', phase='usage', completed=0, total=1,
                         created=time.time(), deadline=time.time()+300)
            self.live.add(token)
            self.s.control.update_config(owner, {FLAGS[scope]: False})
            self.s.documents.write(self.path(owner, scope), state)

        def check():
            saved = self.s.documents.read(self.path(owner, scope), {})
            if saved.get('id') != token or saved.get('status') != 'running':
                raise ValueError('计价准备已取消')
            if time.time() >= state['deadline']:
                raise ValueError('准备超过五分钟，请重试或取消')

        def update(**values):
            with self.lock:
                check()
                state.update(values)
                self.s.documents.write(self.path(owner, scope), state)

        def fail(error):
            with self.lock:
                saved = self.s.documents.read(self.path(owner, scope), {})
                if saved.get('id') == token and saved.get('status') == 'running':
                    saved.update(status='failed', error=str(error)[:400] if isinstance(error, ValueError) else '准备失败，缓存保留；请重试或取消', finished=time.time())
                    self.s.documents.write(self.path(owner, scope), saved)

        def work():
            try:
                self.s.sync_agent(owner, scope)
                check()
                with self.s.monitor.db() as db:
                    rows = [dict(r) for r in db.execute('SELECT * FROM events WHERE owner=? AND source=?', (owner, scope))]
                dates = [datetime.fromisoformat(r['at'].replace('Z','+00:00')).astimezone(timezone.utc).date().isoformat() for r in rows]
                today = datetime.now(timezone.utc).date().isoformat()
                update(phase='prices', completed=0, total=len(set(dates)))
                result = self.s.pricing.sync(min(dates, default=today), max(dates, default=today),
                                             owner=owner, scope=scope, required_rows=rows, progress=update, check=check, force=True)
                if result['errors']:
                    raise ValueError('价格或汇率网络同步失败；缓存保留，请重试或取消')
                update(phase='valuation', completed=0, total=2)
                coverage = {}
                while True:
                    for n, currency in enumerate(('USD','CNY'), 1):
                        check()
                        snapshot = self.s.monitor.snapshot(owner, scope=scope, source=scope, period='all', value_currency=currency, valuation_enabled=True)
                        # Every event is valued by the versioned dataset above;
                        # also materialize the default visible chart/summary.
                        self.s.monitor.snapshot(owner, scope=scope, source=scope if scope=='codex' else '', period='30', value_currency=currency, valuation_enabled=True)
                        value = snapshot.get('valuation', {})
                        coverage[currency] = dict(summary=value.get('summary'), issues=value.get('issues'), priceVersion=value.get('priceVersion'), dataVersion=snapshot.get('dataVersion'))
                        update(phase='valuation', completed=n, total=2)
                    if all(coverage['USD'][key]==coverage['CNY'][key] for key in ('dataVersion','priceVersion')):break
                    update(phase='valuation',completed=0,total=2)
                with self.lock:
                    check()
                    # Commit only after both currencies have a completed derived dataset.
                    state.update(status='complete', phase='ready', coverage=coverage, versions=dict(priceAndFx=coverage['USD']['priceVersion'],usage=coverage['USD']['dataVersion']), finished=time.time())
                    with self.s.control.lock:
                        control=self.s.control.state(owner)
                        control['config'][FLAGS[scope]]=True
                        self.s.documents.write_many([(self.s.control.path(owner),control),(self.path(owner, scope),state)])
            except Exception as error:
                fail(error)
            finally:
                timer.cancel()
                with self.lock:
                    self.live.discard(token)

        timer = threading.Timer(300, lambda: fail(ValueError('准备超过五分钟，请重试或取消')))
        timer.daemon = True; timer.start()
        threading.Thread(target=work, daemon=True, name='valuation-'+scope).start()
        return state.copy()
