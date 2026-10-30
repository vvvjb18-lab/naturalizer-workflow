"""Low-RAM path: base -> f16 GGUF -> apply PEFT LoRA -> quantize.
Avoids loading the 24 GB HF shard into 12.7 GB RAM.

usage: python postprocess_lora_native.py <base_snapshot_dir> <adapter_dir> <prefix> [qtype]
"""
import os, shutil, subprocess, sys, time

def log(*a): print(" ".join(str(x) for x in a), flush=True)

def sh(cmd):
    log("$", cmd[:220]); t = time.time()
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if r.returncode:
        log("  FAILED rc", r.returncode)
        log((r.stdout + r.stderr)[-2500:])
        raise SystemExit(1)
    log(f"  ok {time.time()-t:.0f}s")
    return r

base_dir, adapter_dir, prefix = sys.argv[1], sys.argv[2], sys.argv[3]
qtype = sys.argv[4] if len(sys.argv) > 4 else "Q5_K_M"

gg_f16 = f"/content/{prefix}_base_f16.gguf"
gg_lora = f"/content/{prefix}_lora.gguf"
gg_merged = f"/content/{prefix}_merged_f16.gguf"
gg_out = f"/content/{prefix}_{qtype}.gguf"

# build tools once
sh("cd /content && test -d llama.cpp || git clone --depth 1 https://github.com/ggml-org/llama.cpp")
sh("cd /content/llama.cpp && (test -f build/bin/llama-export-lora && test -f build/bin/llama-quantize) || "
   "(cmake -B build -DLLAMA_CURL=OFF -DGGML_NATIVE=OFF > /tmp/cmake.log 2>&1 && "
   "cmake --build build --config Release -j 4 --target llama-export-lora llama-quantize > /tmp/build.log 2>&1)")
B = "/content/llama.cpp/build/bin"

sh(f"{sys.executable} -m pip install -q gguf")
sh(f"cd /content/llama.cpp && {sys.executable} convert_hf_to_gguf.py {base_dir} --outfile {gg_f16} --outtype f16")
sh(f"cd /content/llama.cpp && {sys.executable} convert_lora_to_gguf.py {adapter_dir} --base {base_dir} --outfile {gg_lora} --outtype f16")
sh(f"{B}/llama-export-lora -m {gg_f16} --lora {gg_lora} -o {gg_merged}")
sh(f"{B}/llama-quantize {gg_merged} {gg_out} {qtype}")
for f in (gg_f16, gg_merged, gg_lora):
    if os.path.exists(f):
        os.remove(f)
log("OUT", gg_out, round(os.path.getsize(gg_out)/1e9, 2), "GB")

shutil.rmtree("/content/chunks", ignore_errors=True); os.makedirs("/content/chunks")
sh(f"cd /content && split -b 1700M -d -a 2 {gg_out} /content/chunks/{os.path.basename(gg_out)}.part-")
sh("ls -l /content/chunks")
