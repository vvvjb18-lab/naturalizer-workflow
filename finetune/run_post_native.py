"""Driver for the low-RAM GGUF path."""
import os, subprocess, sys, time
from huggingface_hub import snapshot_download
BASE_REPO, ADAPTER, PREFIX = sys.argv[1], sys.argv[2], sys.argv[3]
log = open(f"/content/post_{PREFIX}.log", "w", buffering=1)
def P(*a):
    m = " ".join(str(x) for x in a); print(m, flush=True); print(m, file=log, flush=True)
P("=== post-native", PREFIX, time.strftime("%H:%M:%S"), "===")
ALLOW = ["*.json", "*.safetensors", "*.model", "*.txt", "*.jinja", "*.py"]
base = snapshot_download(BASE_REPO, cache_dir=None, allow_patterns=ALLOW)
P("base:", base)
cmd = [sys.executable, "/content/postprocess_lora_native.py", base, ADAPTER, PREFIX, "Q5_K_M"]
P("$", " ".join(cmd))
r = subprocess.run(cmd, capture_output=True, text=True)
P(r.stdout[-4000:])
if r.returncode:
    P("FAILED rc", r.returncode); P(r.stderr[-3000:])
else:
    P("=== post done", time.strftime("%H:%M:%S"), "===")
