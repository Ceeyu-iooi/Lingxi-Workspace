"""Desktop child lifetime: stdin belongs to the one Electron parent instance."""
import json
import os
import sys
import threading


def watch_parent(server, stop_background, instance, on_stop=None):
    def watch():
        try:
            for line in sys.stdin:
                if len(line) > 1024:
                    continue
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                if message == {'command': 'shutdown', 'instance': instance}:
                    break
        finally:
            stop_background.set()
            if on_stop:on_stop()
            server.shutdown()
    threading.Thread(target=watch, daemon=True, name='desktop-parent-pipe').start()


def announce(server, version, instance):
    print('WORKBENCH_READY ' + json.dumps({'port': server.server_address[1], 'version': version,
          'pid': os.getpid(), 'instance': instance}), flush=True)
