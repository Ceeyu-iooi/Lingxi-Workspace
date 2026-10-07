"""Validate web source and copy a runnable web build; no desktop toolchain."""
from pathlib import Path
import ast,hashlib,json,shutil,sys
root=Path(__file__).resolve().parents[1]
for file in (root/'src').rglob('*.py'):ast.parse(file.read_text(encoding='utf-8-sig'))
receipt=json.loads((root/'frontend/application-assets.json').read_text(encoding='utf8'))
for item in receipt['files']:
    file=root/item['file']
    if not file.is_file() or hashlib.sha256(file.read_bytes()).hexdigest()!=item['sha256']:raise SystemExit('Application UI resource missing or changed: '+item['file'])
target=root/'.runtime/web-build';target.mkdir(parents=True,exist_ok=True)
for directory in ('src','static'):
    shutil.copytree(root/directory,target/directory,dirs_exist_ok=True)
for name in ('run_web.py','VERSION','requirements.txt','LICENSE','THIRD_PARTY_NOTICES.md'):
    shutil.copy2(root/name,target/name)
if (root/'.runtime/deps').exists():shutil.copytree(root/'.runtime/deps',target/'.runtime/deps',dirs_exist_ok=True)
print('Web build ready: .runtime/web-build. It creates its own profile when started.')
