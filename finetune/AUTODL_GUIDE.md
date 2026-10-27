# AutoDL 訓練指南 — Qwen3.5-9B-Base QLoRA（2026-10-28 版）

## 成本
- RTX 4090 24GB @ ¥1.88/時 → 80 對 × 3 epochs ≈ **40–60 分鐘訓練，¥2–4**
- RTX 5090 32GB @ ¥2/時 → **25–35 分鐘**（省 ~20 分鐘；32GB 解鎖全 essay 級與 14B 微調）
- ⚠ **5090（Blackwell）必須用 CUDA 12.8+ 的 PyTorch wheel**：
  ```bash
  pip install torch --index-url https://download.pytorch.org/whl/cu128
  pip install -U transformers peft bitsandbytes datasets accelerate
  ```
  4090 用 cu121 即可。另外 5090 上把腳本的 `fp16=True` 改成 `bf16=True`（Blackwell 對 bf16 更快）：
  `sed -i 's/fp16=True/bf16=True/' train_qlora.py`

## 為什麼 base 模型能勝任改寫（三層論證）
1. **先例**：humanizer-12B 本身就是「AI味輸入→真人輸出」的微調模型——同一配方已在我們生產線工作
2. **任務形態**：base 原生能力是「給定文本→變換文本」；「模板→輸出變換」是微調教 base 的標準場景，80 對統一格式足夠教會一個格式
3. **證據鏈**：hugo 實測 base 續寫 98.8% 被判人類；兰章就是 base-first 再指令微調的路線

**後備梯**：輸出格式亂掉 → ①base＋200 對（加通用指令樣本）→ ②改 `--base Qwen/Qwen3.5-9B`（instruct 版，實驗純度降但格式必過）

## label 遮罩說明（為何「用 AI 文章訓練」不違背低 AI）
訓練對 = (AI 拋光版 A(H) [輸入，label 遮罩 -100]，真人段落 H [輸出，唯一梯度來源])。
模型被訓練去**產生**的分佈是 PELIC 真人文本；AI 側只是任務條件（= 客戶交來的東西）。
推理流程 = 產品場景：客戶 AI 稿進 → 真人味出。

## 步驟

### 1. 開機
AutoDL → 容器實例 → 選「4090 · 24GB」（或 5090，見上方注意事項）→ 鏡像選 PyTorch 2.3+ → 開機

### 2. 上傳資料（兩個檔案，共 <200KB）
```bash
scp -P <端口> pipeline/finetune/{pairs.jsonl,train_qlora.py} root@<host>:/root/autodl-tmp/
```
（或用 AutoDL 網頁的 JupyterLab 上傳）

### 3. 裝依賴
```bash
pip install torch --index-url https://download.pytorch.org/whl/cu121
pip install transformers peft bitsandbytes datasets accelerate
pip install huggingface_hub
export HF_ENDPOINT=https://hf-mirror.com   # 大陸網絡加速
```

### 4. 下載基座 + 跑訓練
```bash
cd /root/autodl-tmp
python train_qlora.py --pairs pairs.jsonl --base Qwen/Qwen3.5-9B-Base --out out_lora --epochs 3
```
預期：~40 分鐘（9B QLoRA, seq 640, batch 1×8 累積）。顯存峰值 ~10GB。

### 5. 合併 LoRA → 轉 GGUF → 下載回本機
```bash
pip install llama-cpp-python  # 不需要；用 llama.cpp 的 convert 腳本
git clone https://github.com/ggml-org/llama.cpp
python llama.cpp/convert_hf_to_gguf.py out_lora --outfile qwen35-9b-hk-f16.gguf --outtype f16
# 注意：convert 前需要把 LoRA 合併回基座
python - << 'EOF'
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel
base = 'Qwen/Qwen3.5-9B-Base'
m = AutoModelForCausalLM.from_pretrained(base, torch_dtype=torch.float16, device_map='cpu')
m = PeftModel.from_pretrained(m, 'out_lora')
m = m.merge_and_unload()
m.save_pretrained('merged')
AutoTokenizer.from_pretrained(base).save_pretrained('merged')
EOF
python llama.cpp/convert_hf_to_gguf.py merged --outfile qwen35-9b-hk-q4.gguf --outtype q4_K
```
下載 `qwen35-9b-hk-q4.gguf`（~5.5GB）回本機。

### 6. 本機探針（回滾流程見 probe 結尾）
```bash
# 停 Humanizer App → llama-server 換載新 GGUF（port 8080）
# node probe_xtragpt.mjs <天花板文本> 12 8080   ← 同一腳本，模型已換
# 判準：句級 gen ≤0.8 = 強陽性（XtraGPT 是 0.98 全滅）；≤0.7 = 顯著
```

## 注意
- **訓練資料是公開語料**（PELIC），無隱私問題；客戶稿不上傳
- Qwen3.5-9B-Base 是 base 模型——它不會聽指令！訓練前 80 對全靠 prompt 模板教它任務格式。若 3 epochs 後輸出亂（base 模型常見），改訓 **Qwen3.5-9B（instruct 版）** 或加 200 條通用指令樣本
- Titan V（12GB）也可跑：seq 降到 512、batch 1、不用 AutoDL——但速度慢 2–3 倍
