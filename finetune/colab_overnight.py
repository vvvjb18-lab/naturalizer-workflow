# ═══════════════════════════════════════════════════════════════════
# Humanizer 9.1 — 文類內化微調 + 自動驗收（一鍵版，Colab Pro / A100）
# 做四件事：① 下載 1068 對資料 ② 訓練 Qwen3.5-9B-Base (fp16 LoRA)
#          ③ 合併 + 存 adapter ④ 用同一把尺驗收（gen / ppl / CoLA）
# 背景執行：工具 → 命令面板 → 搜「后台执行」→ 啟用後可關閉瀏覽器
# ═══════════════════════════════════════════════════════════════════
import subprocess, sys, os, json, time

def sh(cmd, show=True):
    t0 = time.time()
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if show and (r.stdout.strip() or r.stderr.strip()):
        print((r.stdout + r.stderr).strip()[-2000:])
    print(f'[{int(time.time()-t0)}s] {cmd[:90]}', flush=True)
    return r.returncode

print('=== ① 環境 ===')
sh('pip install -q "transformers==4.46.3" "tokenizers<0.21" peft accelerate 2>&1 | tail -2', show=False)
sh('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader')

print('=== ② 資料 ===')
DATA_URL = 'https://gist.githubusercontent.com/vvvjb18-lab/17e75bfe2b7461bda6bdd683030951f1/raw/pairs_snapshot_714.jsonl'
sh(f'wget -q -O pairs_all.jsonl "{DATA_URL}"')
pairs = [json.loads(l) for l in open('pairs_all.jsonl', encoding='utf-8') if l.strip()]
print(f'pairs: {len(pairs)} | models: {sorted({p["meta"].get("model","?") for p in pairs})}', flush=True)

import random, torch
random.seed(42); random.shuffle(pairs)
n_val = max(20, len(pairs)//20)
train, val = pairs[n_val:], pairs[:n_val]

print('=== ③ 訓練 ===')
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
    m = max(len(x['input_ids']) for x in b)
    pad = tok.pad_token_id
    return {'input_ids': torch.tensor([list(x['input_ids']) + [pad]*(m-len(x['input_ids'])) for x in b]),
            'labels': torch.tensor([list(x['labels']) + [-100]*(m-len(x['labels'])) for x in b]),
            'attention_mask': torch.tensor([[1]*len(x['input_ids']) + [0]*(m-len(x['input_ids'])) for x in b])}

EPOCHS = 3
ACCUM = 4
args = TrainingArguments(output_dir='out_lora', num_train_epochs=EPOCHS, per_device_train_batch_size=1,
    gradient_accumulation_steps=ACCUM, learning_rate=1e-4, lr_scheduler_type='cosine', warmup_steps=30,
    logging_steps=10, save_strategy='no', fp16=True, gradient_checkpointing=True,
    gradient_checkpointing_kwargs={'use_reentrant': False}, report_to=[], remove_unused_columns=False)
steps_per_epoch = len(train) // ACCUM
print(f'train={len(train)} val={len(val)} → optimizer steps ≈ {steps_per_epoch*EPOCHS}', flush=True)
trainer = Trainer(model=model, args=args, train_dataset=DS(train), data_collator=collate)
trainer.train()
model.save_pretrained('out_lora'); tok.save_pretrained('out_lora')
print('TRAIN DONE', flush=True)

print('=== ④ 合併 ===')
merged = model.merge_and_unload()
merged.save_pretrained('merged'); tok.save_pretrained('merged')
print('MERGED', flush=True)

print('=== ⑤ 驗收（同一把尺）===')
from transformers import AutoModelForSequenceClassification
import importlib
for m in [k for k in list(sys.modules) if k.startswith('transformers')]:
    pass  # 已釘 4.46.3，無需清理

ttok = AutoTokenizer.from_pretrained('Oxidane/tmr-ai-text-detector')
tmr = AutoModelForSequenceClassification.from_pretrained('Oxidane/tmr-ai-text-detector').eval()
g2tok = AutoTokenizer.from_pretrained('gpt2'); g2 = AutoModelForCausalLM.from_pretrained('gpt2').eval()

def gen_score(text):
    ids = ttok(text, return_tensors='pt', truncation=True, max_length=512)
    with torch.no_grad(): lg = tmr(**ids).logits
    return float(torch.softmax(lg, -1)[0][1])

def ppl_score(text):
    ids = g2tok(text, return_tensors='pt', truncation=True, max_length=512)
    with torch.no_grad(): out = g2(**ids, labels=ids['input_ids'])
    return float(torch.exp(out.loss))

CEILING = ("In today's competitive business environment, retailers must find effective ways to attract customers "
  "while controlling operating costs. Traditionally, physical stores have been the main channel for selling goods. "
  "The advent of digital technology has transformed e-commerce, allowing businesses to sell products online and reach "
  "a wider audience. While both channels meet customer needs, their operational efficiency differs significantly. "
  "This essay critically analyzes the operational efficiency of physical stores and e-commerce platforms, examining "
  "cost structures, customer reach, and inventory management.")

mdl = merged.eval()
dev = next(mdl.parameters()).device
results = {'ceiling': {'gen': gen_score(CEILING), 'ppl': ppl_score(CEILING)}, 'runs': []}
print('CEILING gen=%.3f ppl=%.1f' % (results['ceiling']['gen'], results['ceiling']['ppl']), flush=True)

for t in [0.7, 0.9, 1.0]:
    ids = tok(TPL + CEILING + '\n\n', return_tensors='pt').to(dev)
    with torch.no_grad():
        o = mdl.generate(**ids, max_new_tokens=260, do_sample=True, temperature=t, top_p=0.95, pad_token_id=tok.eos_token_id)
    txt = tok.decode(o[0][ids['input_ids'].shape[1]:], skip_special_tokens=True).strip()
    g, p = gen_score(txt), ppl_score(txt)
    results['runs'].append({'temp': t, 'gen': g, 'ppl': p, 'text': txt})
    print('── temp %.1f gen=%.3f ppl=%.1f' % (t, g, p), flush=True)
    print(txt[:400], flush=True)

best = min(r['gen'] for r in results['runs'])
verdict = 'PASS' if best <= 0.8 else ('NEAR' if best <= 0.9 else 'FAIL')
results['best_gen'] = best
results['verdict'] = verdict
json.dump(results, open('probe_results.json', 'w'), ensure_ascii=False, indent=1)
print('\nSUMMARY ceiling=%.3f best=%.3f → %s' % (results['ceiling']['gen'], best, verdict), flush=True)
print('判準：≤0.8 強陽性／≤0.7 顯著／>0.9 無效', flush=True)

# 存檔：adapter（小）與結果自動下載；大模型留在 VM 供早上匯出
from google.colab import files
files.download('probe_results.json')
sh('zip -q -r adapter.zip out_lora')
print('adapter.zip MB:', os.path.getsize('adapter.zip')//1024//1024, flush=True)
files.download('adapter.zip')
print('ALL DONE', flush=True)
