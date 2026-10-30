"""Merge a LoRA adapter into a base HF model shard-by-shard (low RAM), then
convert to GGUF and quantize to Q5_K_M. Designed for Colab T4 (12.7 GB RAM).

usage: python postprocess_gguf.py <base_dir> <adapter_dir> <out_prefix> [qtype]
"""
import json, os, re, shutil, subprocess, sys, time
import torch
from safetensors.torch import load_file, save_file

def log(*a): print(" ".join(str(x) for x in a), flush=True)

def merge(base_dir, adapter_dir, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    cfg = json.load(open(os.path.join(adapter_dir, "adapter_config.json")))
    scale = cfg.get("lora_alpha", 64) / cfg.get("r", 32)
    ad = load_file(os.path.join(adapter_dir, "adapter_model.safetensors"))
    mods = {}
    for k, v in ad.items():
        m = re.match(r"(?:base_model\.model\.)?(.+)\.lora_(A|B)\.weight$", k)
        if not m:
            continue
        mods.setdefault(m.group(1), {})[m.group(2)] = v
    pairs = {f"{k}.weight": (v["A"].float(), v["B"].float())
             for k, v in mods.items() if "A" in v and "B" in v}
    log(f"lora modules: {len(pairs)} scale {scale}")

    idx_path = os.path.join(base_dir, "model.safetensors.index.json")
    if os.path.exists(idx_path):
        idx = json.load(open(idx_path))
        wmap = idx["weight_map"]
        shards = sorted(set(wmap.values()))
    else:
        shards = [f for f in os.listdir(base_dir) if f.endswith(".safetensors")]
        idx = None
    log(f"shards: {len(shards)}")

    touched = 0
    for sh in shards:
        src = os.path.join(base_dir, sh)
        dst = os.path.join(out_dir, sh)
        tensors = load_file(src)
        for name in list(tensors.keys()):
            if name in pairs:
                A, B = pairs[name]
                delta = (B @ A) * scale
                tensors[name] = (tensors[name].float() + delta).to(torch.float16)
                touched += 1
        save_file(tensors, dst, metadata={"format": "pt"})
        del tensors
        log(f"  {sh} -> {os.path.getsize(dst)/1e9:.2f} GB  (merged {touched})")
    log(f"merged tensors: {touched}/{len(pairs)}")

    if idx is not None:
        shutil.copy(idx_path, os.path.join(out_dir, "model.safetensors.index.json"))
    for f in os.listdir(base_dir):
        if f.endswith((".json", ".jinja", ".model", ".txt", ".safetensors.index.json")) \
                and f != "model.safetensors.index.json":
            shutil.copy(os.path.join(base_dir, f), os.path.join(out_dir, f))
    log("merge complete")
    return out_dir

def sh(cmd):
    log("$", cmd[:200]); t = time.time()
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if r.returncode:
        log("  FAILED rc", r.returncode)
        log((r.stdout + r.stderr)[-1500:])
        raise SystemExit(1)
    log(f"  ok {time.time()-t:.0f}s")
    return r

def main():
    base_dir, adapter_dir, prefix = sys.argv[1], sys.argv[2], sys.argv[3]
    qtype = sys.argv[4] if len(sys.argv) > 4 else "Q5_K_M"
    merged = f"/content/merged_{prefix}"
    gguf_q8 = f"/content/{prefix}_q8.gguf"
    gguf_out = f"/content/{prefix}_{qtype}.gguf"

    merge(base_dir, adapter_dir, merged)
    shutil.rmtree(base_dir, ignore_errors=True) if "/content/hf_" in base_dir else None

    sh(f"cd /content && test -d llama.cpp || git clone --depth 1 https://github.com/ggml-org/llama.cpp")
    sh(f"cd /content/llama.cpp && test -f build/bin/llama-quantize || "
       f"(cmake -B build -DLLAMA_CURL=OFF -DGGML_NATIVE=OFF > /tmp/cmake.log 2>&1 && "
       f"cmake --build build --config Release -j 4 --target llama-quantize > /tmp/build.log 2>&1)")

    sh(f"{sys.executable} -m pip install -q -r /content/llama.cpp/requirements/requirements-convert_hf_to_gguf.txt 2>/dev/null || {sys.executable} -m pip install -q gguf")
    conv = f"cd /content/llama.cpp && {sys.executable} convert_hf_to_gguf.py {merged} --outfile {{out}} --outtype {{ot}}"
    try:
        sh(conv.format(out=gguf_q8, ot="f16"))
    except SystemExit:
        log("f16 failed, falling back to q8_0")
        sh(conv.format(out=gguf_q8, ot="q8_0"))
    shutil.rmtree(merged, ignore_errors=True)

    qbin = "/content/llama.cpp/build/bin/llama-quantize"
    if not os.path.exists(qbin):
        qbin = sh("find /content/llama.cpp/build -name 'llama-quantize' -type f | head -1").stdout.strip()
    sh(f"{qbin} {gguf_q8} {gguf_out} {qtype}")
    os.remove(gguf_q8)
    log("OUT", gguf_out, round(os.path.getsize(gguf_out)/1e9, 2), "GB")

    # split for chunked download
    shutil.rmtree("/content/chunks", ignore_errors=True); os.makedirs("/content/chunks")
    base = os.path.basename(gguf_out)
    sh(f"cd /content && split -b 1700M -d -a 2 {gguf_out} /content/chunks/{base}.part-")
    sh("ls -l /content/chunks")

if __name__ == "__main__":
    main()
