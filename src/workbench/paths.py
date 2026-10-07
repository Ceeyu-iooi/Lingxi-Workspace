"""Resolve application resources independently of cwd and private profile."""
from pathlib import Path
import sys
def project_root():
    return Path(sys._MEIPASS).resolve() if getattr(sys,'frozen',False) else Path(__file__).resolve().parents[2]
def resource(relative):return project_root()/relative
