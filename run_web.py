#!/usr/bin/env python3
"""Start Lingxi Web from this directory, independently of the shell cwd."""
from pathlib import Path
import sys
ROOT=Path(__file__).resolve().parent
sys.path[:0]=[str(ROOT/'src'),str(ROOT/'.runtime/deps')]
if __name__=='__main__':
    if '--backend' in sys.argv:
        sys.argv.remove('--backend')
        from workbench.server import main
    elif '--consolidate-profile' in sys.argv:
        from workbench.profile_store import consolidate_legacy
        import json
        print(json.dumps(consolidate_legacy(ROOT),ensure_ascii=False))
        raise SystemExit(0)
    else:
        from workbench.web_launcher import main
    main()
