# 一條命令：原稿 → Humanizer → 學術修補

> 完整 workflow 說明（含 docx、UI、報告、成本、交付）：[`../WORKFLOW.md`](../WORKFLOW.md)

這個資料夾把兩步串起來：

```
原稿（.txt / .md / .docx）
   │
   ├─ 1. hz（官方 Humanizer CLI，12B 本機模型）
   │     產出 A：<name>.humanized.txt
   │
   ├─ 2. polish（API 完整大模型，預設 DeepSeek）
   │     只把 A 的語法／語域／結構／事實問題做最小修補
   │     修補後仍有缺陷：hz 重生 → 仍不過用 skill 合約的 API 改寫（strong 最多 3 次）→ quality judge → 重審
   │     產出 B：<name>.final.txt / .docx
   │
   └─ 報告：<name>.final.report.md / .json
```

順序不能反：先 Humanizer 打散 AI 味，再讓完整模型只做外科修補。反過來做，模型會把文字改回均勻的「標準學術英文」，把降 AI 率的優勢抵銷。

## 前置（已幫你裝好）

- `hz`：`uv tool install "git+https://github.com/sgaofen/humanizer-local-model"`（已完成，路徑 `~/.local/bin/hz`）
- Humanizer App 開著；`hz` 會自動找 `http://127.0.0.1:47615`，關著也會嘗試啟動
- API key：`../polish/.env` 或 `../polish/polish.config.json`

## 用法

```bash
cd F:\Humanizer\pipeline

node pipeline.mjs "C:\path\draft.txt"

# 中文稿件（語言自動判斷，不用特別指定）
node pipeline.mjs draft.md --lang zh

# 已經有 Humanizer 輸出，只跑修補
node pipeline.mjs draft.txt --humanized "C:\path\already-humanized.txt"

# 先看會執行什麼，不真的跑
node pipeline.mjs draft.txt --dry-run
```

或把原稿拖到 `run-pipeline.cmd` 上。

## 網頁 UI

不想用命令列：雙擊 [`../webui/start.cmd`](../webui/start.cmd)，開啟 <http://127.0.0.1:8790>。
貼上原稿、按開始，就能三欄對照原文／A／B、標示差異、下載報告。詳見 [`../webui/README.md`](../webui/README.md)。

## 輸出

| 檔案 | 用途 |
|---|---|
| `<name>.humanized.txt` | **A**：Humanizer 原始輸出，拿去跑第一份 Turnitin |
| `<name>.final.txt` | **B**：學術修補後，拿去跑第二份 Turnitin |
| `<name>.humanized.docx` | docx 模式的 A：Humanizer 輸出（保留標題、表格、樣式） |
| `<name>.final.docx` | docx 模式的 B：修補後（只改寫散文段落，其餘原樣） |
| `<name>.final.report.md` | 中文報告：修補明細、未自動處理、人工覆核清單 |
| `<name>.final.report.json` | 結構化結果，方便日後接自動化 |
| `<name>.humanized.json` | hz 的逐段統計：複製率、缺數字、重寫次數、耗時 |
| `<name>.pipeline.json` | 這次的輸入／輸出／段數，給網頁 UI 與自動化用 |

## DOCX

`.docx` 走的是 hz 原本的 docx 模式，再加上一層 python-docx 橋接：

1. `hz` 只改寫 body 的散文段落，跳過標題、表格、References、目錄、引言、程式碼，以及含超連結／圖片／欄位／註腳的段落。改寫會寫進段落的第一個 run，保留段落樣式、編號與第一個 run 的字元格式。
2. `docx_bridge.py` 取出原稿與 A.docx 的段落，只把 **hz 實際改寫過** 的段落送進修補層；原稿對應段落作為事實基準。
3. 修補後的段落用 python-docx 寫回 A.docx，成為 B.docx；標題、表格、References 與未改寫段落完全保留。
4. 另外輸出 A/B 的全文 `.txt`，方便跑 Turnitin 或做文字比對。

因此：

- 報告的「三稿對照」只列被修補的段落，不是整份文件；全文請看 `.txt` 或 `.docx`。
- 段落內局部的粗體／斜體，在 hz 改寫後會變成整段套用第一個 run 的格式。這是 hz 本身的已知限制，我們照它的方式保留，不會另外重建 run。
- 如果 hz 沒有改寫任何段落（例如整份都是標題、表格或引用），管線會直接報錯，不會硬寫。

需要 python-docx（本機已裝在 hz 的 uv tool venv）：

```bash
uv pip install --python "C:/Users/<你>/AppData/Roaming/uv/tools/humanize-model/Scripts/python.exe" python-docx
```

## 參數

| 參數 | 說明 |
|---|---|
| `--out-dir <dir>` | 輸出資料夾（預設與原稿同目錄） |
| `--humanized <file>` | 跳過 hz，直接修補既有輸出；docx 模式需給 A.docx |
| `--hz-bin <path>` | 指定 hz 執行檔（預設自動找） |
| `--hz-arg <arg>` | 額外傳給 hz，可重複，例如 `--hz-arg=--max-words --hz-arg=250` |
| `--dry-run` | 只印命令 |
| `--audit-only` | 只審查 A，不產生 B |
| `--verify audit\|repair\|off` | 修補後的驗證模式（預設 audit，只審查） |
| `--lang auto\|en\|zh` | 語言（預設 auto） |
| `--provider` / `--model` / `--api-key` | 原樣傳給 polish |
| `--quiet` | 關閉進度輸出 |

`--out`、`--report`、`--json`、`--draft` 由管線決定，請不要傳。

## 退出碼

- `0`：兩步都完成，沒有需要人工處理的嚴重問題
- `2`：完成了，但報告有 major／critical 待覆核，或硬性檢查未通過
- `1`：hz 找不到、App 沒開、API key 錯誤、輸入檔不存在等

退出碼 2 不是失敗；它代表「可以交付前先看報告」。

## 交付流程

1. 跑管線，拿到 A、B、報告。
2. 看報告的「未自動處理」與「人工覆核清單」，通常 0–4 項，逐項修 B。
3. A、B 各跑一次正式 Turnitin 報告，記錄 AI 指標。
4. 若 B 的分數高於 A：先看 `edit-budget` 與節奏保留率；改動超過 10% 或節奏低於 85%，把 `--verify audit` 保持、`maxPatchWords` 調到 60 再跑一次。
5. 交付 B 與修改後的 Turnitin 報告。

## 注意

- 支援 `.txt` / `.md` / `.docx`。docx 只修補 hz 實際改寫的散文段落；標題、表格、References 與含圖片／超連結的段落保持原樣。
- `hz` 的改寫有隨機性（temperature 1.0），同一份稿跑兩次 A 會不同；這是正常的。A/B 比較請用同一輪的 A 與 B。
- 報告裡的引用、數字、`(1)(2)(3)` 三項永遠人工再看一眼。
- 任何 AI 偵測結果都不保證；交付前重新跑正式報告，不要沿用舊截圖。

## 疑難排解

**`找不到 hz`**：跑 `uv tool install "git+https://github.com/sgaofen/humanizer-local-model"`，或加 `--hz-bin "C:\Users\你\.local\bin\hz.exe"`。

**`hz 回傳 ...` / 連不上**：開 Humanizer App，等它顯示 ready；或確認 `http://127.0.0.1:47615/app/status` 有回應。

**`缺少 API key` / 401**：檢查 `../polish/.env` 的 `DEEPSEEK_API_KEY`，先跑 `../polish/test-api.cmd`。

**`找不到有 python-docx 的 Python`**：把 python-docx 裝進 hz 的 uv tool venv：

```bash
uv pip install --python "C:/Users/<你>/AppData/Roaming/uv/tools/humanize-model/Scripts/python.exe" python-docx
```

**`hz 沒有改寫任何段落`**：整份文件可能只有標題、表格、References，或段落都含超連結／圖片。把要改寫的散文放在普通段落，或先用 `hz` 單獨確認。

**`修補後的段落數 ... 不一致`**：很少見，通常是模型在同一個 patch 裡動了段落分隔。B.docx 不會產生；修補後文字在 `.pipeline/polished.subset.txt`，可把 `--chunk-chars` 調大或 `--verify audit` 後重跑。

**很慢**：hz 用本機 12B，1500 字大約 1–3 分鐘；polish 用 API，通常 10–30 秒；docx 的段落抽取／寫回不到 1 秒。不要同時跑其他吃 VRAM 的程式。

完整的修補規則與報告說明見 [`../polish/README.md`](../polish/README.md)。
