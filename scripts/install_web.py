"""Install only the portable web runtime dependencies in this checkout."""
from pathlib import Path
import subprocess,sys
root=Path(__file__).resolve().parents[1]
subprocess.run([sys.executable,'-m','pip','install','--no-cache-dir','--target',str(root/'.runtime/deps'),'--upgrade','-r',str(root/'requirements.txt')],check=True)
print('Web dependencies ready. Start: python -B run_web.py')
