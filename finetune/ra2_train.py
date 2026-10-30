"""Route A v2: Qwen3.5-9B-Base + QLoRA, student register. T4-safe."""
import json, os, subprocess, sys, time
os.environ["USE_TF"] = "0"; os.environ["TRANSFORMERS_NO_TF"] = "1"; os.environ["USE_FLAX"] = "0"

LOG = "/content/ra2.log"
log = open(LOG, "w", buffering=1)
def P(*a):
    m = " ".join(str(x) for x in a); print(m, flush=True); print(m, file=log, flush=True)
def sh(c, **kw):
    P("$", c[:160]); r = subprocess.run(c, shell=True, capture_output=True, text=True, **kw)
    if r.returncode: P("  rc", r.returncode, (r.stdout + r.stderr)[-400:])
    return r

P("=== routea v2 start", time.strftime("%H:%M:%S"), "===")
P(subprocess.run("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader",
                 shell=True, capture_output=True, text=True).stdout.strip())

sh(f"{sys.executable} -m pip uninstall -y -q torchao")
sh(f"{sys.executable} -m pip install -q -U peft accelerate bitsandbytes trl")
sh(f"{sys.executable} -m pip install -q 'transformers==5.21.0'")
# Qwen3.5 hybrid-attention fast kernels (optional)
sh(f"{sys.executable} -m pip install -q flash-linear-attention 2>&1 | tail -2")

import torch, transformers
from transformers import AutoModelForCausalLM, AutoTokenizer, TrainingArguments, Trainer, BitsAndBytesConfig, TrainerCallback
from peft import LoraConfig, get_peft_model
P("torch", torch.__version__, "| transformers", transformers.__version__)
try:
    import fla; P("fla OK")
except Exception as e: P("fla MISSING", type(e).__name__)

BASE = "Qwen/Qwen3.5-9B-Base"
OUT = "/content/out_routea_v2"
TPL = ("Rewrite the following paragraph to sound like a genuine university student "
       "writing an academic essay - natural, slightly imperfect, with the rhythm "
       "and word choices of a real L2 learner. Keep the same content.\n\n")
MAXLEN = 1024

rows = [json.loads(l) for l in open("/content/routea2_sft.jsonl", encoding="utf-8") if l.strip()]
def _est(r): return (len(r["ai"]) + len(r["human"])) / 3.6 + 80
rows = [r for r in rows if _est(r) <= MAXLEN]
tr = [r for r in rows if r.get("split") != "validation"]
va = [r for r in rows if r.get("split") == "validation"]
P(f"routea pairs: {len(rows)} train {len(tr)} val {len(va)}")

tok = AutoTokenizer.from_pretrained(BASE)
if tok.pad_token is None: tok.pad_token = tok.eos_token

quant = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                           bnb_4bit_compute_dtype=torch.float16, bnb_4bit_use_double_quant=True)
model = AutoModelForCausalLM.from_pretrained(BASE, quantization_config=quant, device_map="auto",
                                             torch_dtype=torch.float16, attn_implementation="sdpa")
model.config.use_cache = False
_resume_dir = "/content/resume_adapter"
if os.path.isdir(_resume_dir) and os.path.exists(_resume_dir + "/adapter_model.safetensors"):
    from peft import PeftModel
    model = PeftModel.from_pretrained(model, _resume_dir, is_trainable=True)
    P("RESUME from", _resume_dir)
else:
    model = get_peft_model(model, LoraConfig(r=32, lora_alpha=64, lora_dropout=0.05,
    task_type="CAUSAL_LM", target_modules=["q_proj","k_proj","v_proj","o_proj","gate_proj","up_proj","down_proj"]))

class DS(torch.utils.data.Dataset):
    def __init__(s, rs): s.rows = rs
    def __len__(s): return len(s.rows)
    def __getitem__(s, i):
        r = s.rows[i]; prompt = TPL + r["ai"].strip()
        full = prompt + "\n\n" + r["human"].strip() + tok.eos_token
        ids = tok(full, truncation=True, max_length=MAXLEN, return_tensors="pt")["input_ids"][0]
        plen = len(tok(prompt, truncation=True, max_length=MAXLEN - 20)["input_ids"])
        labels = ids.clone(); labels[:plen] = -100
        return {"input_ids": ids, "labels": labels}

def collate(b):
    m = max(len(x["input_ids"]) for x in b); pad = tok.pad_token_id
    return {"input_ids": torch.tensor([list(x["input_ids"]) + [pad]*(m-len(x["input_ids"])) for x in b]),
            "labels": torch.tensor([list(x["labels"]) + [-100]*(m-len(x["labels"])) for x in b]),
            "attention_mask": torch.tensor([[1]*len(x["input_ids"]) + [0]*(m-len(x["input_ids"])) for x in b])}

class Prog(TrainerCallback):
    def on_log(self, args, state, control, logs=None, **kw):
        if logs:
            kv = " ".join(f"{k}={v:.4g}" for k, v in logs.items() if isinstance(v, (int, float)))
            P(f"step {state.global_step}/{state.max_steps} {kv}")


class SaveAdapter(TrainerCallback):
    """Tar the adapter after each checkpoint so a VM loss costs at most one save interval."""
    def on_save(self, args, state, control, **kw):
        import glob, tarfile
        cks = sorted(glob.glob(args.output_dir + "/checkpoint-*"),
                     key=lambda p: int(p.rsplit("-", 1)[-1]))
        if not cks:
            return
        ck = cks[-1]
        dst = "/content/latest_adapter.tar.gz"
        with tarfile.open(dst, "w:gz") as t:
            for f in ("adapter_model.safetensors", "adapter_config.json", "README.md"):
                p = os.path.join(ck, f)
                if os.path.exists(p):
                    t.add(p, arcname=f)
        P("CKPT", ck, round(os.path.getsize(dst) / 1e6, 1), "MB")



targs = TrainingArguments(
    output_dir=OUT, num_train_epochs=1,
    per_device_train_batch_size=1, gradient_accumulation_steps=8,
    learning_rate=1e-4, lr_scheduler_type="cosine", warmup_steps=40,
    logging_steps=10, save_strategy="steps", save_steps=25, save_total_limit=1,
    dataloader_num_workers=2, dataloader_pin_memory=False,
    optim="paged_adamw_8bit",
    fp16=True, gradient_checkpointing=True,
    gradient_checkpointing_kwargs={"use_reentrant": False},
    report_to=[], remove_unused_columns=False, disable_tqdm=True)

P("steps ~", len(tr)//8*1)
t0 = time.time()
Trainer(model=model, args=targs, train_dataset=DS(tr), data_collator=collate, callbacks=[Prog(), SaveAdapter()]).train()
P(f"routea TRAIN DONE in {(time.time()-t0)/60:.1f} min")
model.save_pretrained(OUT); tok.save_pretrained(OUT)
P("adapter saved")
subprocess.run(f"cd /content && tar -czf routea_v2_adapter.tar.gz -C {OUT} .", shell=True)
P("bundle", round(os.path.getsize("/content/routea_v2_adapter.tar.gz")/1e6,1), "MB")
P("=== routea v2 done", time.strftime("%H:%M:%S"), "===")
