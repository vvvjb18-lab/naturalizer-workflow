import subprocess, sys, os, json, time, textwrap

def sh(cmd, quiet=False):
    t0 = time.time()
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if not quiet and (r.stdout.strip() or r.stderr.strip()):
        print((r.stdout + r.stderr).strip()[-1200:], flush=True)
    print(f'[{int(time.time()-t0)}s] {cmd[:70]}', flush=True)
    return r.returncode

print('=== 1 環境檢查 ===', flush=True)
sh('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader', True)
import transformers, torch
print('transformers', transformers.__version__, '| torch', torch.__version__, flush=True)

print('=== 2 資料 ===', flush=True)
sh('wget -q -O pairs_all.jsonl "https://gist.githubusercontent.com/vvvjb18-lab/17e75bfe2b7461bda6bdd683030951f1/raw/pairs_snapshot_714.jsonl"')
pairs = [json.loads(l) for l in open('pairs_all.jsonl', encoding='utf-8') if l.strip()]
import random
random.seed(42); random.shuffle(pairs)
n_val = max(20, len(pairs) // 20)
train, val = pairs[n_val:], pairs[:n_val]
print('pairs:', len(pairs), '| train', len(train), '| val', len(val), flush=True)

print('=== 3 訓練 ===', flush=True)
from transformers import AutoModelForCausalLM, AutoTokenizer, TrainingArguments, Trainer
from peft import LoraConfig, get_peft_model

BASE = 'Qwen/Qwen3.5-9B-Base'
tok = AutoTokenizer.from_pretrained(BASE)
if tok.pad_token is None: tok.pad_token = tok.eos_token
model = AutoModelForCausalLM.from_pretrained(BASE, device_map='auto', attn_implementation='sdpa', torch_dtype=torch.float16)
model.config.use_cache = False
model = get_peft_model(model, LoraConfig(r=32, lora_alpha=64, lora_dropout=0.05, task_type='CAUSAL_LM',
    target_modules=['q_proj','k_proj','v_proj','o_proj','gate_proj','up_proj','down_proj']))
model.print_trainable_parameters()

TPL = ('Rewrite the following paragraph to sound like a genuine university student writing an academic essay — natural, slightly imperfect, with the rhythm and word choices of a real L2 learner. Keep the same content.\n\n')

class DS(torch.utils.data.Dataset):
    def __init__(self, rows): self.rows = rows
    def __len__(self): return len(self.rows)
    def __getitem__(self, i):
        r = self.rows[i]
        prompt = TPL + r['ai'].strip()
        full = prompt + '\n\n' + r['human'].strip() + tok.eos_token
        ids = tok(full, truncation=True, max_length=640, return_tensors='pt')['input_ids'][0]
        plen = len(tok(prompt, truncation=True, max_length=620)['input_ids'])
        labels = ids.clone(); labels[:plen] = -100
        return {'input_ids': ids, 'labels': labels}

def collate(b):
    m = max(len(x['input_ids']) for x in b); pad = tok.pad_token_id
    return {'input_ids': torch.tensor([list(x['input_ids']) + [pad]*(m-len(x['input_ids'])) for x in b]),
            'labels': torch.tensor([list(x['labels']) + [-100]*(m-len(x['labels'])) for x in b]),
            'attention_mask': torch.tensor([[1]*len(x['input_ids']) + [0]*(m-len(x['input_ids'])) for x in b])}

EPOCHS, ACCUM = 3, 4
targs = TrainingArguments(output_dir='out_lora', num_train_epochs=EPOCHS, per_device_train_batch_size=1,
    gradient_accumulation_steps=ACCUM, learning_rate=1e-4, lr_scheduler_type='cosine', warmup_steps=30,
    logging_steps=10, save_strategy='no', fp16=True, gradient_checkpointing=True,
    gradient_checkpointing_kwargs={'use_reentrant': False}, report_to=[], remove_unused_columns=False)
print('optimizer steps ~', len(train) // ACCUM * EPOCHS, flush=True)
Trainer(model=model, args=targs, train_dataset=DS(train), data_collator=collate).train()
model.save_pretrained('out_lora'); tok.save_pretrained('out_lora')
print('TRAIN DONE', flush=True)

print('=== 4 合併 ===', flush=True)
merged = model.merge_and_unload()
merged.save_pretrained('merged'); tok.save_pretrained('merged')
sh('zip -q -r adapter.zip out_lora')
print('adapter.zip MB:', os.path.getsize('adapter.zip') // 1024 // 1024, flush=True)
del model, merged
torch.cuda.empty_cache()

print('=== 5 生成候選（同一模板）===', flush=True)
from transformers import AutoModelForCausalLM as AM
gen = AM.from_pretrained('merged', torch_dtype=torch.float16, device_map='auto').eval()
gtok = AutoTokenizer.from_pretrained('merged')
dev = next(gen.parameters()).device
CEILING = ("In today's competitive business environment, retailers must find effective ways to attract customers "
  "while controlling operating costs. Traditionally, physical stores have been the main channel for selling goods. "
  "The advent of digital technology has transformed e-commerce, allowing businesses to sell products online and reach "
  "a wider audience. While both channels meet customer needs, their operational efficiency differs significantly. "
  "This essay critically analyzes the operational efficiency of physical stores and e-commerce platforms, examining "
  "cost structures, customer reach, and inventory management.")
runs = []
for t in [0.7, 0.9, 1.0]:
    ids = gtok(TPL + CEILING + '\n\n', return_tensors='pt').to(dev)
    with torch.no_grad():
        o = gen.generate(**ids, max_new_tokens=260, do_sample=True, temperature=t, top_p=0.95, pad_token_id=gtok.eos_token_id)
    txt = gtok.decode(o[0][ids['input_ids'].shape[1]:], skip_special_tokens=True).strip()
    runs.append({'temp': t, 'text': txt})
    print('-- temp %.1f' % t, flush=True)
    print(txt[:350], flush=True)
json.dump({'ceiling': CEILING, 'runs': runs}, open('gen_runs.json', 'w'), ensure_ascii=False, indent=1)
del gen
torch.cuda.empty_cache()
print('GEN DONE', flush=True)

print('=== 6 降版 + 子進程評分 ===', flush=True)
sh('pip install -q "transformers==4.46.3" "tokenizers<0.21" "numpy<2"', True)

probe_src = textwrap.dedent('''
import json, torch
from transformers import AutoTokenizer, AutoModelForCausalLM, AutoModelForSequenceClassification
d = json.load(open("gen_runs.json"))
ttok = AutoTokenizer.from_pretrained("Oxidane/tmr-ai-text-detector")
tmr = AutoModelForSequenceClassification.from_pretrained("Oxidane/tmr-ai-text-detector").eval()
g2tok = AutoTokenizer.from_pretrained("gpt2")
g2 = AutoModelForCausalLM.from_pretrained("gpt2").eval()
def gs(t):
    ids = ttok(t, return_tensors="pt", truncation=True, max_length=512)
    with torch.no_grad(): lg = tmr(**ids).logits
    return float(torch.softmax(lg, -1)[0][1])
def ps(t):
    ids = g2tok(t, return_tensors="pt", truncation=True, max_length=512)
    with torch.no_grad(): o = g2(**ids, labels=ids["input_ids"])
    return float(torch.exp(o.loss))
out = {"ceiling": {"gen": gs(d["ceiling"]), "ppl": ps(d["ceiling"])}, "runs": []}
print("CEILING gen=%.3f ppl=%.1f" % (out["ceiling"]["gen"], out["ceiling"]["ppl"]), flush=True)
for r in d["runs"]:
    g, p = gs(r["text"]), ps(r["text"])
    out["runs"].append({"temp": r["temp"], "gen": g, "ppl": p})
    print("temp %.1f gen=%.3f ppl=%.1f" % (r["temp"], g, p), flush=True)
best = min(x["gen"] for x in out["runs"])
out["best_gen"] = best
out["verdict"] = "PASS" if best <= 0.8 else ("NEAR" if best <= 0.9 else "FAIL")
json.dump(out, open("probe_results.json", "w"), ensure_ascii=False, indent=1)
print("SUMMARY ceiling=%.3f best=%.3f -> %s" % (out["ceiling"]["gen"], best, out["verdict"]), flush=True)
''')
open('probe_run.py', 'w', encoding='utf-8').write(probe_src)
code = sh(f'{sys.executable} probe_run.py')
if code != 0:
    print('tmr 載入失敗 → ppl-only 備援（早上用本機 daemon 複核）', flush=True)
    open('probe_fallback.py', 'w', encoding='utf-8').write(textwrap.dedent('''
import json, torch
from transformers import AutoTokenizer, AutoModelForCausalLM
d = json.load(open("gen_runs.json"))
tk = AutoTokenizer.from_pretrained("gpt2"); m = AutoModelForCausalLM.from_pretrained("gpt2").eval()
def ps(t):
    ids = tk(t, return_tensors="pt", truncation=True, max_length=512)
    with torch.no_grad(): o = m(**ids, labels=ids["input_ids"])
    return float(torch.exp(o.loss))
res = {"ceiling": {"ppl": ps(d["ceiling"])}, "runs": [{"temp": r["temp"], "ppl": ps(r["text"])} for r in d["runs"]]}
json.dump(res, open("probe_results.json", "w"), indent=1)
print("PPL-only:", json.dumps(res), flush=True)
'''))
    sh(f'{sys.executable} probe_fallback.py')

print('=== 7 下載結果 ===', flush=True)
from google.colab import files
for f in ['probe_results.json', 'gen_runs.json', 'adapter.zip']:
    if os.path.exists(f):
        print(f, os.path.getsize(f)//1024, 'KB', flush=True)
        files.download(f)
print('ALL DONE', flush=True)
