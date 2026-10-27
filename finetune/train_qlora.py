# train_qlora.py — Qwen3.5-9B-Base QLoRA 微調（段落級：AI味版 → 真人版）
# AutoDL 4090 上跑。資料：pairs.jsonl（{"human": ..., "ai": ...}）
# 產出：LoRA adapter（r16）＋合併 GGUF 轉換說明
#
# 用法（AutoDL）：
#   pip install torch --index-url https://download.pytorch.org/whl/cu121
#   pip install transformers peft bitsandbytes datasets accelerate
#   python train_qlora.py --pairs pairs.jsonl --base Qwen/Qwen3.5-9B-Base --out out_lora
import argparse, json, math, os, random

import torch
from torch.utils.data import Dataset
from transformers import (AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig,
                          TrainingArguments, Trainer, DataCollatorForLanguageModeling)
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training

p = argparse.ArgumentParser()
p.add_argument('--pairs', default='pairs.jsonl')
p.add_argument('--base', default='Qwen/Qwen3.5-9B-Base')
p.add_argument('--out', default='out_lora')
p.add_argument('--epochs', type=int, default=3)
p.add_argument('--lr', type=float, default=2e-4)
p.add_argument('--seq', type=int, default=640)
args = p.parse_args()

random.seed(42)
pairs = [json.loads(l) for l in open(args.pairs, encoding='utf-8') if l.strip()]
random.shuffle(pairs)
n_val = max(4, len(pairs) // 10)
val, train = pairs[:n_val], pairs[n_val:]
print(f'train={len(train)} val={len(val)}')

bnb = BitsAndBytesConfig(
    load_in_4bit=True,
    bnb_4bit_quant_type='nf4',
    bnb_4bit_use_double_quant=True,
    bnb_4bit_compute_dtype=torch.float16,
)
tok = AutoTokenizer.from_pretrained(args.base)
model = AutoModelForCausalLM.from_pretrained(
    args.base, quantization_config=bnb, device_map='auto',
    attn_implementation='sdpa', torch_dtype=torch.float16)
model = prepare_model_for_kbit_training(model)
model = get_peft_model(model, LoraConfig(
    r=16, lora_alpha=32, lora_dropout=0.05, bias='none',
    task_type='CAUSAL_LM',
    target_modules=['q_proj', 'k_proj', 'v_proj', 'o_proj', 'gate_proj', 'up_proj', 'down_proj']))
model.print_trainable_parameters()

class PairDS(Dataset):
    def __init__(self, rows):
        self.rows = rows
    def __len__(self): return len(self.rows)
    def __getitem__(self, i):
        r = self.rows[i]
        # 訓練目標：AI 味版輸入 → 真人版輸出（教「LLM味 → 本文類真人味」的轉換）
        prompt = ('Rewrite the following paragraph to sound like a genuine university '
                  'student writing an academic essay — natural, slightly imperfect, with '
                  'the rhythm and word choices of a real L2 learner. Keep the same content.\n\n'
                  f"{r['ai']}")
        full = prompt + '\n\n' + r['human'] + tok.eos_token
        ids = tok(full, truncation=True, max_length=args.seq, return_tensors='pt')['input_ids'][0]
        plen = len(tok(prompt, truncation=True, max_length=args.seq - 16)['input_ids'][0])
        labels = ids.clone()
        labels[:plen] = -100          # 只學輸出側
        return {'input_ids': ids, 'labels': labels}

def collate(batch):
    m = max(len(b['input_ids']) for b in batch)
    input_ids, labels, mask = [], [], []
    for b in batch:
        pad = m - len(b['input_ids'])
        input_ids.append(list(b['input_ids']) + [tok.pad_token_id or tok.eos_token] * pad)
        labels.append(list(b['labels']) + [-100] * pad)
        mask.append([1] * len(b['input_ids']) + [0] * pad)
    return {'input_ids': torch.tensor(input_ids), 'labels': torch.tensor(labels),
            'attention_mask': torch.tensor(mask)}

targs = TrainingArguments(
    output_dir=args.out,
    num_train_epochs=args.epochs,
    per_device_train_batch_size=1,
    gradient_accumulation_steps=8,
    learning_rate=args.lr,
    lr_scheduler_type='cosine',
    warmup_ratio=0.05,
    logging_steps=5,
    save_strategy='epoch',
    bf16=False, fp16=True,
    gradient_checkpointing=True,
    gradient_checkpointing_kwargs={'use_reentrant': False},
    report_to=[],
    remove_unused_columns=False,
)
trainer = Trainer(model=model, args=targs, train_dataset=PairDS(train),
                  data_collator=collate)
trainer.train()
trainer.save_model(args.out)
tok.save_pretrained(args.out)
print('saved ->', args.out)
print('下一步：合併 LoRA 後轉 GGUF（convert_hf_to_gguf.py --outtype q4_K），掛回 llama-server 跑探針')
