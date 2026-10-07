"""One writer process per canonical data directory; IDs never expose paths."""
import atexit
import json
import os
from pathlib import Path
import uuid


class ProfileLock:
    def __init__(self, data):
        data = Path(data).resolve()
        data.mkdir(parents=True, exist_ok=True)
        self.file = (data / '.service.lock').open('a+b')
        try:
            self.file.seek(0)
            if not self.file.read(1):
                self.file.write(b'0'); self.file.flush()
            self.file.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.file.close()
            raise SystemExit('同一资料目录已有后台运行；请连接现有服务') from None
        atexit.register(self.close)

    def close(self):
        if not self.file.closed:
            self.file.close()


def identity(data):
    marker = Path(data) / '.shared-service.json'
    if marker.exists():
        value = json.loads(marker.read_text(encoding='utf-8'))
        for field in ('profileId', 'serviceId'):
            uuid.UUID(value[field])
        return value
    value = dict(profileId=str(uuid.uuid4()), serviceId=str(uuid.uuid4()))
    marker.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive creation, with the lifetime lock already held by main processes.
    try:
        with marker.open('x', encoding='utf-8') as stream:
            json.dump(value, stream)
    except FileExistsError:
        return identity(data)
    return value
