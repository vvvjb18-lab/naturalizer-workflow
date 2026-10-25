# Humanizer Workflow 8.13 — 完整說明

> 一句話：**本機 hz 多候選 → 離線評分擇優（早停帶 gen 閘＋ppl 平手抉選）＋段落重組＋NLI 守門（矛盾／內容損失定向救援）＋自動段級研磨＋查重打磨＋字數預算＋引用一致性＋二級品質手術 → 確定性語法層；一鍵紅區三連發 0% AI；全程零 API、零送檔迭代；Turnitin 只花在里程碑驗證。**
>
> 版本：**7.5** · 最後更新：2026-10-24（E2-grind 送檔實測 0% AI／13% 查重／0 flags——紅區打通；grind 待整合進 v6） · 適用於 `F:\Humanizer`

## Workflow 7.5 現行管線（v6.mjs 全鏈）

```text
原稿 docx
  → plan（hz planner，覆蓋率與 hz --dry-run 同源；偵測文類 essay/form）
  → K 候選（直呼本機 App /api/completion，prompt 與 hz 指紋一致；數字斗篷 cloakNumbers）
  → 逐候選驗證（數字/引用/長度/句數/重複句）→ 離線評分（daemon：CoLA 傷率 + tmr + EditLens + 困惑度）
  → 語法手術（受傷句用 hz 局部重生，0 API）
  → 段落重組 X（逐段擇優）＋ 選擇（CV 帶硬過濾＋加權排名）＋ NLI 矛盾守門
  → grind 段級研磨（原型已驗證，整合中）：最差段反覆重生，validateUnit + NLI 守門，整份 gen 驗收
  → 機械標點 + LT 確定性語法層（零 API；API 潤飾改 opt-in --polish，默認關）
  → A 直接交付（docx 保留標題/表格/References/樣式）+ 風險卡
```

- **迭代閉環全在本機**：離線評分每次 0.01–數秒（daemon 常駐），一次 run 做上百次評分，成本≈電費。Turnitin 碼只在三個時機花：**新文類首次驗證、新配方版本、交付前最終稿**。實測：E2 全程約 250 次離線評分，只花 1 碼，結果 0% AI。
- **離線評分的角色**是守門員不是預言家：能擋住全部已知失敗模式（覆蓋率不足、CV 平滑、AI 修訂 delta、語法傷），但不預測絕對分數（反例：V2 離線 0.959 → Turnitin 0%；final6.0 離線 0.058 → 56%）。校準集 17 點見 `pipeline/v6-test/calibration.json`。
- 雙目標：`--target balanced`（預設，零傷高品質）／`--target ideal`（衝極低 AI，殘餘傷率帶 0–0.2）。

## Workflow 5.0 重點

- **Skill 合約**：API rewrite 注入 `academic-humanizer` 的編輯合約（最小改動、不新增／不丟內容、保留引用數字、學術語域）；可切換 `avoid-ai-writing`。
- **Quality judge**：rewrite 候選先由獨立 rubric 評分（meaning／academic／facts／naturalness／register，25 分）；通過才套用，否則帶 feedback 重試，再不過保留 A。
- **監督層 hz 優先**：未解決項先用本機 hz 對原稿對應句重生 5 次；通過事實／引用／結構／節奏＋judge 才採用；數次不過才交 API。每輪最多 8 個問題走 hz、12 個 action，最多 3 輪。
- **監督輪只自動修客觀缺陷**：grammar／structure／fact／citation／register 才進監督輪；meaning／terminology／cohesion 只列人工覆核，避免為了同義詞把 hz 的節奏改平。第一輪 repair 仍可依缺陷清單處理這些類型，但監督輪不會無限追。
- **Patch-first**：minor 只准 patch；rewrite 只限 major/critical 或結構問題。grammar／fact／citation 的碎片可以跨兩句合併或拆分；其餘一次一句。
- **25% 硬預算**：累計 A→B 改動達 `maxEditRatio`（預設 0.25）就停止監督輪，下一個修補不再套用；剩餘項目列人工。這是防止 5.0 為了「全修」而過度改寫的最後閘門。
- **不再回退到 AI 原稿**：API 改寫也過不了，就保留 A、列人工；judge 通過的 rewrite 不會因「缺陷數沒下降」被誤刪。
- **docx**：hz 只改寫散文段落；python-docx 寫回；標題、表格、References、樣式保留。管線會顯示「hz 改寫 N 段」；交付前要確認 N 等於 `hz --dry-run` 列出的散文段數。
- **覆蓋率與 hz 隨機性**：同一份稿跑兩次 hz，結構可能完全不同。實測第一次把 paragraph 4 拆成 `The 'S' (specific).` 這類碎片，第二次沒有。建議跑 2–3 次 A，選結構最完整的一份再修補。
- **報告**：原文／A／B 三稿對照、格式核對清單、監督輪（hz/API）、judge 分數與退回原因；結論分「不建議交付／可交付但需覆核／通過」。
- **5.0 Strong mode**：API rewrite 最多 3 次，每次帶上一次失敗原因；critical/major 若 judge 的 meaning／facts ≥4、academic ≥3、total ≥16，即使 naturalness／register 低也會**強制套用**，報告標明「強制修正（核心維度通過）」。
- **Rewrite model 可獨立設定**：`rewriteProvider`／`rewriteModel`／`rewriteApiKey`；目前用 Gemini native（`gemini-native`）+ `gemini-3.6-flash` + `thinkingBudget: 0`，經 `rewriteProxyUrl` 走支援地區；失敗自動 fallback DeepSeek。judge 保持 DeepSeek。
- **不再做全篇改寫**：85% 的全篇 rewrite 已證明會把 AI 率拉高；5.0 只改被標記的句子／段落，絕不重寫整份文件。
- **入口**：CLI `pipeline.mjs`、網頁 UI（右上角 Workflow 5.0 徽章）、拖放 `.cmd`。

---

## 目錄

1. [這個 workflow 解決什麼](#1-這個-workflow-解決什麼)
2. [全貌與為什麼順序不能反](#2-全貌與為什麼順序不能反)
3. [五分鐘上手](#3-五分鐘上手)
4. [輸入、輸出與命名](#4-輸入輸出與命名)
5. [階段一：Humanizer（hz）](#5-階段一humanizerhz)
6. [階段二：學術修補層](#6-階段二學術修補層)
7. [修補層的硬性規則](#7-修補層的硬性規則)
8. [報告怎麼讀](#8-報告怎麼讀)
9. [DOCX 詳細行為](#9-docx-詳細行為)
10. [設定：API、模型、參數](#10-設定apimodel參數)
11. [成本與時間](#11-成本與時間)
12. [交付前的 A/B Turnitin 驗證](#12-交付前的-ab-turnitin-驗證)
13. [疑難排解](#13-疑難排解)
14. [檔案結構](#14-檔案結構)
15. [隱私、安全與責任邊界](#15-隱私安全與責任邊界)
16. [一頁流程卡](#16-一頁流程卡)

---

## 1. 這個 workflow 解決什麼

Humanizer 的本職是打散 AI 味的句法節奏。它的 prompt 明確要求「reorganize as you see fit」，temperature 又是 1.0。這讓它很擅長降低 AI 偵測特徵，但代價是第一單常出現的幾種破壞：

- 語法被改壞：殘句、缺字、搭配錯誤、逗號拼接。
- 學術語域被改成口語：`So…`、`But…`、`a big deal`、`Basically`、`struggle to unplug`。
- 文本結構被改壞：散文被拆成 `(1)(2)(3)`、項目符號或奇怪的小標。
- 事實與引用受損：數字、年份、`(Smith & Lee, 2021)` 這類標記消失或掛錯位置。
- 限定語被刪：原稿的 `appears to`、`may`、`似乎` 消失，主張強度被拉高。

如果直接叫一個完整大模型「潤色全文」，它會把整篇改成均勻、抽象、連接詞很多的標準學術英文——那正好是偵測器最熟悉的特徵，等於把 Humanizer 的成果抵銷。

所以這個 workflow 的目標不是「再寫一次」，而是：

1. **保住 Humanizer 已經拿到的節奏與降 AI 率優勢。**
2. **只修被標記的缺陷，不動沒問題的句子。**
3. **把原稿、A、B 與所有改動留下來，讓人可以核對。**

它**不是**代寫工具，也不保證任何 AI 偵測結果。

---

## 2. 全貌與為什麼順序不能反

```text
原始草稿（.txt / .md / .docx）
        │
        ▼
   hz（本機 12B，Humanizer）
        │  docx：只改寫散文段落
        ▼
   A（Humanizer 輸出）
        │
        ├─ 保留給第一份 Turnitin
        │
        ▼
   audit（API 完整模型）
        │  只回傳缺陷清單，不回傳正文
        ▼
   repair（API 完整模型）
        │  只回傳 before → after 的最小替換
        ▼
   程式逐條校驗
        │
        ▼
   verify（API，只審查）
        │  仍有缺陷
        ▼
   supervision（hz → API）
        │  hz 重生 5 次；仍不過 → API rewrite
        │  只修 grammar／structure／fact／citation／register
        │  累計改動達 25% 即停
        ▼
   再審查／校驗（最多 3 輪）
        │
        ▼
   B（修補後）
        │
        ├─ B.docx（保留標題、表格、References、樣式）
        ├─ B.txt（全文）
        ├─ report.md（中文報告）
        └─ report.json（結構化結果）
```

**順序不能反。** 先修補再 Humanizer，Humanizer 會再次把語法與結構弄壞；先 Humanizer 再修補，修補層只需要處理 Humanizer 造成的局部破壞，而且可以用原稿當事實基準。

整條流程刻意分成「誰可以做什麼」：

| 階段 | 在哪裡跑 | 會看到什麼 | 可以改什麼 |
|---|---|---|---|
| hz | 本機 12B | 整份草稿 | 重組、改寫散文 |
| audit | API | 原稿＋A | 不能改，只列缺陷 |
| repair | API | 原稿＋A＋缺陷清單 | 只能回傳局部替換 |
| 校驗 | 本機程式 | 原文＋替換 | 可以退回任何越界替換 |
| 驗證輪 | API | 修補後的文字 | 預設只審查，不改稿 |

---

## 3. 五分鐘上手

### 3.1 前置（本機已具備）

- Node.js 18+（目前 24）
- `hz` CLI：`uv tool install "git+https://github.com/sgaofen/humanizer-local-model"`
- Humanizer App：開著，`hz` 會自動找 `http://127.0.0.1:47615`
- python-docx：已裝在 `hz` 的 uv tool venv，供 docx 使用
- API key：放在 `polish/.env`，或 `polish/polish.config.json`

### 3.2 網頁 UI（最省事）

雙擊：

```text
F:\Humanizer\webui\start.cmd
```

開啟 <http://127.0.0.1:8790>。**6.1 起有兩種模式**：

- **自助服務 6.1（推薦）**：上傳 docx/txt → 選目標（標準 balanced／衝刺 ideal）→ 七階段自動跑（規劃→候選→評分→手術→選擇→修補→風險卡），完成後顯示 AI 風險卡（候選對照表＋CV／傷率／NLI／AI 修訂增量判定晶片）與 A/B 下載。
- **進階 2.0**：原有單次 hz + 修補流程，專家參數（驗證輪／語言／既有 A／只審查）。

### 3.3 CLI（推薦，參數清楚）

```bash
cd F:\Humanizer\pipeline

node pipeline.mjs "C:\path\draft.txt"
node pipeline.mjs "C:\path\draft.md"
node pipeline.mjs "C:\path\draft.docx"
```

或把原稿拖到 `pipeline\run-pipeline.cmd`。

### 3.4 已經有 Humanizer 輸出

```bash
# A 是文字
node pipeline.mjs draft.txt --humanized already-humanized.txt

# A 是 docx（必須也是 docx，才能保留格式）
node pipeline.mjs draft.docx --humanized already-humanized.docx
```

### 3.5 只想先看問題、不要改稿

```bash
node pipeline.mjs draft.docx --audit-only
```

只跑 Humanizer（或使用既有 A）＋審查，列出缺陷；不產生 B。

### 3.6 入口怎麼選

| 情況 | 建議 |
|---|---|
| **6.0 正式流程（多候選 × 離線評分）** | `node v6.mjs draft.docx`（見 §3.7） |
| 第一次用、有 Word 檔 | 網頁 UI 拖 `.docx` |
| 要批次、寫腳本、留完整參數 | CLI `pipeline.mjs` |
| 只想單獨跑修補層（已有 A） | `polish\polish.mjs` 或 CLI 的 `--humanized` |
| 只想看問題 | `--audit-only` |
| 想第二輪全自動再修 | `--verify repair`（有風險，見 §6.4） |

### 3.7 6.0 入口：v6.mjs（選擇式管線）

```bash
cd F:\Humanizer\pipeline
node v6.mjs draft.docx                     # 4 個候選 → 評分 → 擇優 → 最小修補
node v6.mjs draft.docx --candidates 6      # 更多候選
node v6.mjs draft.docx --skip-polish       # 只生成與選擇 A，不修補
```

輸出（`--out-dir` 內）：

| 檔案 | 內容 |
|---|---|
| `<name>.v6-A.docx` | 選中的候選 A（未修補） |
| `<name>.final.docx` | B（最小修補後） |
| `final6.0.docx` | B 的交付副本 |
| `<name>.v6.report.md` / `.json` | 風險卡：候選對照表、原稿基準、A→B 的 EditLens delta |
| `.v6-<name>/` | plan、各候選全文、B 的評分輸入 |

候選數、採樣、風險權重、硬過濾在 `pipeline/v6.config.json`。評分器是 `polish/detector_bridge.py`（首次執行會下載約 1.4 GB 模型到 `polish/.hf-cache`）。

---

## 4. 輸入、輸出與命名

### 4.1 輸入

| 格式 | 說明 |
|---|---|
| `.txt` | 純文字，最單純 |
| `.md` | 走文字管線；hz 會保留標題／code／table，但修補層不特別解析 Markdown。大量 code/table 的檔案建議先確認報告 |
| `.docx` | 走 hz 的 docx 模式；只修補散文段落，格式保留 |
| `.doc` | 不支援，先另存為 `.docx` |

### 4.2 輸出（以 `draft.docx` 為例）

| 檔案 | 內容 |
|---|---|
| `draft.humanized.docx` | **A**：Humanizer 輸出，保留標題、表格、References、樣式 |
| `draft.humanized.txt` | A 的全文（body 段落） |
| `draft.final.docx` | **B**：修補後，保留格式 |
| `draft.final.txt` | B 的全文（body 段落） |
| `draft.final.report.md` | 中文報告 |
| `draft.final.report.json` | 結構化結果（給自動化／UI） |
| `draft.humanized.json` | hz 的逐段統計：複製率、缺數字、重寫次數、耗時 |
| `draft.pipeline.json` | 這次的輸入／輸出／段數／退出碼 |

文字模式（`.txt` / `.md`）沒有 `.docx` 檔案，其餘命名相同。

> docx 的 `.txt` 全文只包含 body 段落；表格內容仍在 `.docx`。交付與 Turnitin 請用 `.docx`。

### 4.3 A 和 B 分別是什麼

- **A = Humanizer 原稿。** 保留給第一份 Turnitin，證明「Humanizer 這一層做到什麼」。
- **B = 學術修補後。** 保留給第二份 Turnitin，也是實際交付版本。
- 兩份要跑**同一輪**的 A/B；hz 的 temperature 是 1.0，不同輪的 A 會不一樣。

---

## 5. 階段一：Humanizer（hz）

### 5.1 它做什麼

`hz` 是 jialinyyzz/humanizer 12B 模型的官方 CLI，透過本機 Humanizer App 的引擎執行。它會：

- 重組句子與段落，刻意讓句長不均勻。
- 刪掉 hedging、開場白、只預告下一句的句子。
- 把抽象詞換成具體詞。
- 保留所有數字、單位、日期、人名、引文；缺數字會在 stderr 警告。
- 長文件分段處理，保留 Markdown 標題、code、table、link；docx 只改寫散文段落。

### 5.2 它為什麼會弄壞東西

它的 prompt 是「reorganize as you see fit」，temperature 1.0。這代表：

- 它會為了節奏犧牲語法完整度。
- 它會把正式的 `However` 換成 `But`、`So`。
- 它可能把一段散文拆成 `(1)(2)(3)`。
- 它可能刪掉原稿的限定語，讓主張變成斷言。
- 它不保證引用仍然掛在同一個論斷旁。

這不是 bug，是它的設計目標；修補層就是為此存在。

### 5.3 hz 的統計怎麼看

`draft.humanized.json` 的 `summary`：

| 欄位 | 意思 |
|---|---|
| `pieces` | 分成幾段改寫 |
| `seconds` | 本機耗時 |
| `copy_rate` | 與原稿的重疊率（越低代表改寫越多） |
| `words_in` / `words_out` | 原稿／輸出字數 |
| `flagged` | 被標記需要重寫的段數 |

複製率低不等於好；太低可能代表它改動過度。真正的品質由 B 與報告決定。

### 5.4 覆蓋率與隨機性（實際踩過的坑）

**先看覆蓋率，再看品質。** 如果一份 5 段散文的稿，A 只有 4 段和原文不同，那第 5 段根本沒有被 humanize；Turnitin 仍然會把它當 AI 文字。實測 `humanized_final2.0.docx` 就是這樣：第 1 段與原文一字不差，只有第 2–5 段是 hz 輸出，結果 59%。

交付前固定做兩件事：

1. 跑 `hz draft.docx --dry-run`，記下 `piece(s) to rewrite` 的段數（例如 5）。
2. 跑 pipeline 後看 log 的 `DOCX 段落對照：原文件 42 段 · hz 改寫 5 段`。兩個數字要對得上；少於預期就代表有散文段被跳過或回退。

**hz 有隨機性。** 同一份稿、同一台機器，兩次 A 的結構可以完全不同：

- 實測第一次：paragraph 4 被拆成 `The 'S' (specific).`、`The 'M' (measurable).` 這類碎片，修補層要花很大力氣才能救。
- 實測第二次（alt1）：同樣段落是完整句子，沒有碎片，修補只改 23%。
- 建議：正式交付前跑 2–3 次 hz，選「沒有 `(1)(2)(3)`、沒有殘句、句數合理」的 A；如果每次都要交 Turnitin，至少先用人眼挑掉明顯壞掉的那份。

---

## 6. 階段二：學術修補層

位置：`F:\Humanizer\polish`

### 6.1 四個 pass

1. **audit（審查）**
   - 模型看到：原稿、A、以及機器檢查的線索（缺數字、缺引用、結構標記、hedge 損失）。
   - 模型只回傳 JSON 缺陷清單，不回傳正文。
   - 每項缺陷必須引用 A 裡的一段原文（6–30 字），並說明問題與最小修法。

2. **repair（修補）**
   - 模型看到：原稿、A、缺陷清單。
   - 只回傳 `before → after` 的替換對；`before` 必須逐字出現在 A。
   - 程式逐條定位、校驗、套用；不合格只重試該條，再不合格就保留原文。

3. **verify（驗證輪）**
   - 預設 `audit`：對 B 再審查一次，只列出仍存在的缺陷，**不再改稿**。
   - 可選 `repair`：第二輪自動再修；模型偶爾會把一句換成鄰句的 paraphrase，造成重複 claim，所以預設不用。
   - 可選 `off`：不跑驗證輪。

4. **supervision（監督輪）**
   - 修補與驗證後仍有未解決項時，先用本機 **hz** 對原稿的對應句／段重新生成（預設 5 次）。每次生成都要通過事實／引用／結構／節奏校驗，通過才採用。
   - hz 數次都過不了，才交給 **API 完整模型**，按同一套要求改寫：
     - `rewrite`：由完整模型改寫成更自然的人類學術句；結構問題（列表、編號）改寫整個段落。
     - `patch`：若能安全局部修，回傳最小替換。
   - 模型拿到：原稿（事實／引用來源）、B（要保留的語氣）、以及明確目標（保留主張；句長不均；具體動詞；不要模板轉折、tricolon、AI 套語；不要新增內容）。
   - **Skill 合約**：API prompt 載入 `polish/skills/academic-humanizer/PROMPT.md`（最小改動、不新增／不丟內容、保留引用數字、學術語域）；可切換 `avoid-ai-writing`。
   - **監督輪只修客觀缺陷**：只有 grammar／structure／fact／citation／register 會進監督輪。meaning／terminology／cohesion 只列人工覆核；它們多半是「DRAFT B 用了近義詞」而不是真錯，硬改會把 hz 的節奏抹平。第一輪 repair 仍可處理這些類型，但不會在監督輪反覆追。
   - **Patch-first 與多句例外**：minor 只准 patch；rewrite 只限 major/critical 或結構問題。一般 rewrite 一次一句；grammar／fact／citation 的碎片（例如 `If my accuracy rate is lower than 70%. I will…`）允許跨兩句合併或拆分，最多比原本多 2 句。
   - **Quality judge**：hz 或 API 的候選先由獨立 rubric 評分（meaning／academic／facts／naturalness／register，25 分）；通過才套用。API 被退回時帶 judge feedback 重試，strong 模式最多 3 次。
   - **5.0 strong mode**：critical/major 若 judge 的 meaning／facts ≥4、academic ≥3、total ≥16，即使 naturalness／register 低也會**強制套用**，報告標「強制修正（核心維度通過）」；minor 仍只准 patch。
   - **預算閘門**：監督輪每套用一個修補，就重新計算 A→B 的實際字詞差異；累計超過 `maxEditRatio`（預設 0.25）就回滾該修補並停止。這比「改完再看」更安全，避免一次跑出 35–41% 的過度改寫。
   - **全篇改寫禁止**：只改被標記的句子／段落。全篇 rewrite 實測 85%，不採用。
   - **Rewrite model**：`rewriteProvider` / `rewriteModel` 可獨立設定；目前 `gemini-native` + `gemini-3.6-flash` + `thinkingBudget: 0`，經 `rewriteProxyUrl` 走 SG/US/JP；503 會重試，仍失敗才 fallback DeepSeek。`gemini-3.7`／`3.8` 目前常 503，不建議。
   - 每次修補或改寫後重新審查，最多 **3 輪**（`maxCleanupRounds`）；每輪最多 8 個問題走 hz（`maxHzIssues`）、12 個 action（`maxCleanupActions`）。若一輪沒有讓缺陷數下降，judge 通過的 rewrite 會保留，其餘整輪回滾。
   - 若 hz 的改寫沒有淨效果，下一輪改由 API 重試；API 也過不了就**保留 A** 並列人工，不會回退到 AI 原稿。
   - 最後剩下的只會是「原稿本身就有」、「需要作者判斷」或「風格／語意建議」的項目，報告會標明原因。

### 6.2 一個實際例子

A（Humanizer 輸出）：

> Recent research shows remote work may enhance productivity. But it seems to vary based on task complexity and management support. … This shows productivity boosts are contingent, not absolute.

B（修補後）：

> Recent research shows remote work may enhance employee productivity (Smith & Lee, 2021). However, the effect appears to depend on task type and supervisory support. … These findings indicate that productivity gains are conditional rather than universal.

修補層做了什麼：

- `But it seems` → `However, the effect appears`（正式連接詞＋保留 hedge）。
- `task complexity` → `task type`、`management support` → `supervisory support`（還原原稿術語）。
- `This shows` → `These findings indicate`（還原證據連結）。
- `contingent, not absolute` → `conditional rather than universal`（還原原稿對比）。
- 補回 `employee` 與引用。
- 沒有重排段落，沒有加新論點。

### 6.3 它刻意不做什麼

- 不重寫沒被標記的句子。
- 不為了風格而合併、拆分或重排句子；只有 grammar／fact／citation 的碎片才允許跨兩句修復。
- 不自動修 meaning／terminology 的同義詞（例如 `productivity gains` → `benefits`）；這類只列人工覆核，因為硬改會改變作者主張的強度。這是監督輪的規則；第一輪 repair 仍可能依缺陷清單處理。
- 不加過渡句、主題句、總結句。
- 不加新論點、例子、證據。
- 不把樸素動詞升級成抽象名詞。
- 不為了「更學術」而加 `moreover`、`furthermore`、`crucial`、`multifaceted`。
- 不恢復 Humanizer 刪掉的冗餘 hedging；只在原稿本來就有、而 B 變成過度斷言時放回該處。

### 6.4 驗證輪模式

| 模式 | 行為 | 建議 |
|---|---|---|
| `audit`（預設） | 再審查一次，列出待人工覆核項 | 交付前有人看報告時用這個 |
| `repair` | 第二輪自動再修 | 想減少人工項時可試，但務必比對 A/B |
| `off` | 不跑第二輪 | 趕時間、或已人工確認 B |

監督輪另外由 `cleanup` 控制（預設開）。不想自動改寫就設 `"cleanup": false`；改寫不過校驗時會保留 A，不會回退到原稿。

---

## 7. 修補層的硬性規則

### 7.1 確定性檢查（不靠模型）

| 檢查 | 做法 |
|---|---|
| 數字 | 原稿有、B 沒有的數字 → 嚴重問題；B 多出的數字 → 疑似發明。`three` 與 `3`、`six` 與 `6` 視為同一事實。 |
| 引用 | 原稿有、B 沒有的 `(Author, Year)`、`[1]` → 嚴重問題；引用內的年份不當成獨立數字。 |
| 結構 | 新增 `(1)(2)(3)`、`（1）`、項目符號、Markdown 標題 → 結構問題 |
| 截斷 | 最後一句沒有終止標點 → 嚴重問題 |
| 重複句 | 同一句幾乎逐字出現兩次 → 結構問題；另用 token 重疊（containment ≥0.8）抓近似重複句 |
| 括號／引號 | 不成對 → 提示 |
| 口語 | `a big deal`、`Basically`、`其實`、`基本上` 等 → 語域問題 |
| 句首 But/So | 句首 `But` / `So` → 語域問題（`So far` 不算） |
| AI 套語 | `delve`、`crucial`、`underscores`、`綜上所述` 等 → 提示 |
| 節奏 | 句長變異係數（CV）保留率 |
| 改動幅度 | 最終 A→B 的實際字詞差異 |

### 7.2 替換校驗（每條 patch 都要過）

- `before` 必須逐字出現在 A，且必須覆蓋被標記的缺陷。
- 不能弄丟數字、引用、專有名詞。
- 不能新增列表、編號、標題、換行。
- 不能新增 AI 套語、第二人稱、縮寫。
- patch 不能新增或刪除句子；grammar／fact／citation 的多句碎片會自動轉成 rewrite，允許最多比原本多 2 句。
- 不能重複既有句子、近似重複句或同一個內容片語（`productivity gains … productivity gains`）。
- 數字詞與阿拉伯數字視為同一事實（`six hours` → `6 hours` 不算弄丟數字）。
- 句首不能變小寫；句中不能突然大寫。
- 不能重複使用同一個轉折詞（`However` 已經用過就不能再加第二個）。
- 文法／銜接修補的相似度不能低於門檻（防止整句換句話說）。
- 長度必須在原句 0.45–2.2 倍之間。
- 重疊的兩條 patch 只留第一條，其餘退回。

### 7.3 最終門檻

| 門檻 | 意義 |
|---|---|
| 語言一致 | A、B 語言不能漂移 |
| 句長節奏 | B 的 CV ≥ A 的 80%（少於 120 字或句數少於 8 不判定） |
| AI 套語 | B 不能比 A 多 |
| 結構 | B 不能比原稿多出列表／編號／標題 |
| 數字／引用 | B 必須包含原稿全部數字與引用 |
| 修改幅度 | 最終差異 ≤ max(40 字, 總字數 25%)；監督輪套用每個修補前會先檢查，超過就回滾並停止 |
| 重複句 | B 不能比 A 多；另檢查近似重複句 |
| 截斷 | B 不能停在半句 |
| 語域 | 第二人稱／縮寫不能增加 |

任何一項不通過，報告會標紅，CLI 退出碼為 2。即使硬性檢查全過，只要仍有 critical 未解決，報告結論仍會是「不建議交付」；有 major 但無 critical 時，結論是「可交付，但仍有 N 項 major 建議人工覆核」。

---

## 8. 報告怎麼讀

報告 `*.final.report.md` 的順序：

1. **結論**：三種判定之一——「不建議交付」（硬性檢查失敗或有 critical）、「可交付，但仍有 N 項 major 建議人工覆核」、或「通過」。
2. **硬性檢查**：每一項 ✅／⚠️ 與說明。
3. **三稿對照（格式核對）**
   - 一張表：原文／A／B 的字數、段落、句數、平均句長、CV、列表標記、數字、引用、口語詞、縮寫、第二人稱。
   - 三份全文（docx 模式為 hz 實際改寫、本次修補的段落）。
   - 一份可直接勾的格式核對清單。
4. **指標對照（A → B）**：更細的句長、短句／長句比例、hedge、問句等。
5. **修補明細**：每一處 `before → after`、issue id、輪次（第一輪／驗證輪／監督輪）。`rewrite` 代表完整 AI 改寫（保留事實與引用）。
6. **未自動處理**：修補、驗證、監督輪後仍存在的項目，附原因。
   - 「監督輪無法安全改寫；已保留 A」：客觀缺陷，但候選過不了校驗／judge，請人工修。
   - 「風格／語意建議，未自動改寫；請人工核對」：meaning／terminology／cohesion，工具刻意不自動改，避免過度改寫。
7. **人工覆核清單**：數字／引用未找回、結構殘留、硬性檢查失敗等。
8. **執行紀錄與錯誤**。

### 8.1 三個數字先看

- **改動百分比**：一般 2–15%。15–25% 要逐項看是不是在救碎片；25% 是硬停點，超過的修補會被回滾。
- **節奏保留率**：B 的 CV ÷ A 的 CV。低於 80% 代表句子被抹平；80–90% 要覆核，90% 以上通常安全。
- **未解決數**：0–8 項都可能在報告出現；「風格／語意建議」不算失敗，但 critical 必須 0，major 要逐項看。

### 8.2 退出碼

| 碼 | 意義 |
|---|---|
| `0` | 完成，沒有需要人工處理的嚴重問題 |
| `2` | 完成，但有 major/critical 待覆核，或硬性檢查未通過 |
| `1` | 無法執行（hz、API、檔案、docx 等問題） |

`2` 不是失敗；它是「交付前先看報告」。

---

## 9. DOCX 詳細行為

### 9.1 hz 的 docx 模式

- 只處理 body 的散文段落。
- 跳過：標題（Heading/Title/Subtitle/outline level）、表格、空段落、圖說、引用區塊、程式碼、目錄、References / Bibliography / 參考文獻 之後的內容。
- 跳過：含有超連結、圖片、欄位、註腳、追蹤修訂、方程式的段落（整段不動）。
- 改寫寫進段落的第一個 run，其餘 run 清空。
- 保留段落樣式、編號、第一個 run 的字元格式。

### 9.2 我們的橋接

`pipeline/docx_bridge.py` 用 python-docx：

1. 取出原稿與 A.docx 的段落（保持索引）。
2. 只把 **原稿與 A 不同的段落**（也就是 hz 實際改寫的段落）送去修補。
3. 原稿對應段落作為事實基準。
4. 修補後的段落用 `apply` 寫回 A.docx → B.docx。
5. `fulltext` 另外輸出 A/B 的全文 `.txt`。
6. log 會印 `原文件 42 段 · hz 改寫 5 段；只修補這 5 段`。這個 5 必須等於 `hz draft.docx --dry-run` 的 `piece(s) to rewrite`；少於預期就是覆蓋率不足。

### 9.3 限制

- **第一段／標題判斷**：hz 會依樣式與位置判斷哪些是標題。若第一段其實是正文，但 A 與原稿完全相同，先跑 `hz --dry-run` 確認它有沒有被列入 piece。
  - dry-run 沒有列入：手動把該段當獨立 `.txt` 跑 hz，或把整份稿的第一段前加一個真正的標題再跑。
  - dry-run 有列入但 A 仍與原文相同：通常是被修補層回退或該次 hz 失敗；先重跑 hz，仍一樣就用 `--humanized` 指定一份人工處理好的 A。實測 2.0 final 的第 1 段就是原文，等於 5 段只 humanize 了 4 段。
- 段落內局部的粗體／斜體，改寫後會變成整段套用第一個 run 的格式。這是 hz 的已知行為，我們照它保留。
- 含超連結／圖片／註腳／方程式的散文段落，hz 完全不動；管線也不會修補它們。要處理請先移除該元素，跑完再放回。
- 報告的三稿對照只列被修補的段落，不是整份文件；標題、表格、References 請看 A/B.docx。
- `.txt` 全文只包含 body 段落；表格內容只在 `.docx`。
- 如果修補後段落數與 hz 改寫段數不一致（很少見），B.docx 不會產生；修補文字在 `.pipeline/polished.prose.txt`，可調大 `--chunk-chars` 或改 `--verify audit` 重跑。

---

## 10. 設定：API、模型、參數

### 10.1 API

`polish/polish.config.json`：

```json
{
  "provider": "deepseek",
  "apiKey": "",
  "apiKeyEnv": "DEEPSEEK_API_KEY",
  "temperature": 0,
  "verifyRound": "audit",
  "rewriteProvider": "gemini-native",
  "rewriteModel": "gemini-3.6-flash",
  "rewriteApiKeyEnv": "GEMINI_API_KEY",
  "rewriteProxyUrl": "http://127.0.0.1:7897",
  "thinkingBudget": 0,
  "rewriteFallback": true
}
```

`polish/.env`（已 gitignore）：

```text
DEEPSEEK_API_KEY=sk-...
GEMINI_API_KEY=...
```

### 10.2 provider preset

| `provider` | 端點 | 預設模型 |
|---|---|---|
| `deepseek`（預設） | `https://api.deepseek.com/v1` | `deepseek-chat` |
| `openai` | `https://api.openai.com/v1` | `gpt-4.1` |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-pro`（OpenAI 相容層） |
| `gemini-native` | `https://generativelanguage.googleapis.com/v1beta` | `gemini-3.6-flash`（原生 `generateContent`，rewrite 用） |
| `openrouter` | `https://openrouter.ai/api/v1` | `openai/gpt-4.1` |
| `moonshot` | `https://api.moonshot.cn/v1` | `moonshot-v1-32k` |
| `qwen` | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| `zhipu` | `https://open.bigmodel.cn/api/paas/v4` | `glm-4.5` |

任何 OpenAI 相容端點都可以用：`--base-url` 與 `--model` 自行指定。

### 10.3 模型選擇

- 這一步要的是「嚴格遵守格式、只改被點名的缺陷」，不是創意。
- 一般對話模型（`deepseek-chat`、`gpt-4.1`）比 reasoning 模型更合適。
- **Gemini 版本**：`gemini-2.5-flash` 已對新用戶下架；`gemini-3.7-flash`／`3.8-flash` 目前常回 503。實測穩定的是 `gemini-3.6-flash`。用原生 adapter 時設 `thinkingBudget: 0`，否則 thinking 會吃掉 `maxOutputTokens`，JSON 被截斷。
- Gemini 只在支援地區可用；代理出口需 US／JP／SG。TW／HK 會回 400 `User location is not supported`。503 會自動重試 4 次，仍失敗才 fallback DeepSeek。
- reasoning 模型容易把 `maxOutputTokens` 花在思考上，也可能無視「只回 JSON」；要用就把 `maxOutputTokens` 調到 6000 以上，先 `--ping`。
- 不建議用本機小模型做這一層；它會同時跟 hz 搶 VRAM，而且指令遵循較弱。

### 10.4 主要參數

| 參數 | 預設 | 說明 |
|---|---|---|
| `--draft` | 無 | 原稿（punctuation 事實基準） |
| `--humanized` | 無 | 跳過 hz，使用既有 A；docx 需給 A.docx |
| `--out` | 自動 | B 輸出路徑 |
| `--report` / `--json` | 自動 | 報告路徑 |
| `--audit-only` | 關 | 只審查，不產生 B |
| `--verify` | `audit` | `audit` / `repair` / `off` |
| `--lang` | `auto` | `auto` / `en` / `zh` |
| `--provider` | `deepseek` | preset 名稱 |
| `--model` | preset | 覆蓋模型 |
| `--api-key` | 空 | API key |
| `--chunk-chars` | 6000 | 每次送模型的字元數（中文自動降到 3200） |
| `--max-edit-ratio` | 0.25 | 改動字數硬預算（另有 40 字下限）；超過即停止監督輪 |
| `--max-output-tokens` | 3000 | 單次回應上限 |
| `--max-patch-words` | 180 | 單次替換字數上限 |
| `--quiet` | 關 | 關閉進度 |
| `--dry-run` | 關 | 只印命令（管線） |
| `--hz-arg` | 無 | 額外傳給 hz，可重複 |

進階：`minCvRetention`（0.8）、`maxIssuesPerChunk`（20）、`repairBatch`（12）、`timeoutMs`（300000）。
監督輪：`cleanup`（true）、`maxCleanupRounds`（3）、`maxCleanupActions`（12）、`hzRetry`（true）、`hzRetries`（5）、`maxHzIssues`（8）、`hzTimeoutMs`（180000）。監督輪只自動修 grammar／structure／fact／citation／register；meaning／terminology／cohesion 留給人工覆核，避免為同義詞過度改寫。`maxEditRatio`（0.25）是硬預算，累計改動超過就停止，不再套用下一個修補。
Skill 與品質：`skill`（academic-humanizer）、`judge`（true）、`judgeProvider` / `judgeModel` / `judgeApiKey` / `judgeApiKeyEnv` / `judgeBaseUrl`（建議用獨立模型）、`judgeMinScore`（18）、`judgeMinDimension`（3）、`judgeFailOpen`（false）。
Strong 模式：`mode`（strong／safe）、`strongAttempts`（3）、`forceFix`（true）、`forceMinScore`（16）；rewrite 模型：`rewriteProvider`（目前 `gemini-native`）、`rewriteModel`（`gemini-3.6-flash`）、`thinkingBudget`（0，關閉 thinking 以免吃掉輸出額度）、`rewriteProxyUrl`（本機 Clash 代理，預設 `http://127.0.0.1:7897`）、`rewriteApiKeyEnv`（`GEMINI_API_KEY`）、`rewriteFallback`（true）。Judge 保持主模型 DeepSeek（`judgeProvider` 留空）。

> Gemini 版本注意：`gemini-2.5-flash` 已對新用戶下架；`gemini-3.7-flash`／`gemini-3.8-flash` 目前常回 503。實測穩定可用的是 `gemini-3.6-flash`（伺服器端回報 modelVersion 3.6）。Gemini 只在支援地區可用，代理出口需為 US／JP／SG；TW／HK 會回 400 `User location is not supported`。

> 用 `pipeline.mjs` 時，`--draft`、`--out`、`--report`、`--json` 由管線自動設定；上表主要給 `polish.mjs` 單獨使用或需要微調時參考。

---

## 11. 成本與時間

| 階段 | 時間 | 成本 |
|---|---|---|
| hz（本機 12B） | 約 10 秒–3 分鐘（1,500 字）；實測 675 字約 34 秒 | 0 |
| docx 段落抽取／寫回 | < 1 秒 | 0 |
| audit + repair（API） | 約 10–30 秒 | 約 15k–30k input、2k–4k output tokens |
| 驗證輪（audit） | 約 5–15 秒 | 約 5k–10k input |

以 DeepSeek 的價格，一份 1,500 字稿件大約 **HK$0.05 以內**。實際依 provider 與模型而定。Gemini 3.6 Flash 目前可用（視 key 的配額與速率限制）；503 會重試，仍失敗才 fallback DeepSeek。

監督輪若啟動：每個未解決項最多讓 hz 重生 5 次（每次約 5–15 秒），每輪最多處理 8 個問題（`maxHzIssues`）、12 個 action（`maxCleanupActions`）；hz 全部失敗才會呼叫 API。每個候選再加 1 次 quality judge（約 0.5–1.5 秒）。Gemini 正常回覆約 1–3 秒；遇到 503 重試可能單次 50–120 秒。實測 675 字、22 項缺陷、3 輪，總時間約 6–9 分鐘。累計改動達 `maxEditRatio` 就停止，剩餘項目列入手動覆核。

VRAM：hz 會佔用約 12 GB；跑 hz 時不要同時跑其他吃 VRAM 的程式。修補層用 API，不佔 VRAM。

---

## 12. 交付前的 A/B Turnitin 驗證

固定流程：

1. **先確認覆蓋率**：`hz draft.docx --dry-run` 記下應改段數；pipeline log 的 `hz 改寫 N 段` 要一致。
2. 同一份原稿跑一輪，拿到 A 與 B；A/B 必須同一輪（hz 有隨機性）。
3. A、B 各跑一次正式 Turnitin 報告，記下 AI 指標。
4. 若 **A 本身就有段落沒被改寫**：
   - 不要急著看 B；先重跑 hz 或手動處理該段。實測 2.0 final 第 1 段是原文，5 段只改了 4 段，這種 A 的 59% 不是修補層造成的。
5. 若 **B 明顯高於 A**：
   - 先看 `edit-budget` 與節奏保留率。
   - 改動 > 15% 或節奏 < 80%，通常是模型越界。
   - 把 `maxEditRatio` 降到 0.15、`maxPatchWords` 降到 120；必要時 `cleanup: false` 只做第一輪。
6. 若 **B 與 A 接近**：
   - 看報告的「未自動處理」；grammar/structure/fact/citation 的人工修完，meaning/terminology 只挑真的影響主張的。
   - 再跑一次 B 的正式報告。
7. 交付 B 與修改後的 Turnitin 報告。

注意：

- 任何修改都可能改變分數；不要沿用修改前的截圖。
- 報告裡的 `(1)(2)(3)`、引用、數字三項永遠人工再看一眼。
- **59% 的實際案例**：2.0 final 只有 4/5 段 humanized，而且 hz 的 A 本身可能已經接近這個模型的下限。B 是「修好 hz 的破壞、保住節奏」，不是「把 59% 變成 10%」的保證。如果 B 仍然 >20，先換一份結構乾淨的 A（多跑 2–3 次 hz），再考慮換更強的 humanizer；不要用全篇 rewrite（實測 85%）。
- Turnitin 低於 20% 的分數可能不會顯示；以正式報告的頁面為準。

### 12.1 本次實測（2026-10-23）

- 2.0 final：5 段散文只有 4 段和原文不同，第 1 段是原文；Turnitin 59%。這不是修補層造成的，是覆蓋率不足。
- 第一次 5.0 hz：paragraph 4 被拆成 `The 'S' (specific).` 等碎片，修補層要改 41% 才能救，節奏掉到 0.403。
- 第二次 hz（alt1）：paragraph 4 是完整句；自動 B 改動 23.1%、CV 0.446 → 0.414（保留 93%），仍有 10 項 major（多為 meaning/terminology）與 5 項 grammar minor。
- 人工局部校對後：612 字、34 句、CV 0.442；7 個數字與 5 個引用全部保留，無重複句、無 AI 套語、無縮寫；References 未動。
- **Turnitin 實測（2026-10-24）**：`final5.0`（自動 B，hz 腔調保留）**低於 20%**（Turnitin 顯示 `*%`，低於門檻不顯示數字）；`final5.1`（更學術化的改寫）**25%**；`final3.0` 低於 20%；`final2.0` 59%。
- **關鍵發現**：把文字修得愈接近標準學術英文，AI 率反而上升。final5.0 的 hz 不規則句法正是它低於 20% 的原因；final5.1 的 polish 把它拉回 25%。所以正確做法不是「改到完美」，而是**只修客觀錯誤、保留 hz 的句法**。
- 建議流程：以 `final5.0`（低於 20%）為底，只做 detached citation、`For 'S' for…`、`to revise`、`app blocking`、`next evening`、重複 `check/test` 等最小修補；每次只改一組，重新跑 Turnitin 確認仍在 20 以下。不要直接把 final5.0 改成 final5.1 的學術腔。
- 結論：5.0 能修好 hz 的破壞並保住節奏，但**不保證每一版都低於 20%**；AI 率主要由 A 的句法與 polish 的改動量決定。若 B 仍高，先換一份乾淨的 A，或減少 polish，而不是加大改寫。

### 12.2 解決路線：AI-safe 優先，quality-first 另開一條線

**不要繼續迭代 final5.1 的 polish。** 5.1 的方向是「更像標準學術英文」，這正好與 <20 的目標相反；你已經有 final5.0 <20、final5.1 25% 的實測。再往 5.1 修，只會在「品質好一點、AI 高一點」之間來回。

把 5.0 拆成兩個明確模式：

| 模式 | 目標 | 允許的改動 | 不允許 |
|---|---|---|---|
| **AI-safe（交付預設）** | 先守住 <20，再修客觀錯誤 | citation 標點、冠詞、主謂一致、時態、代詞、重複句、`to revise` 這類搭配；改動 ≤5–8% | 不改寫句法、不恢復原稿的學術腔、不加 `Therefore`／`Furthermore`、不把 hz 的具體動詞抽象化、不重寫整段 |
| **Quality-first（可選）** | 品質優先，接受 AI 可能 25% | 現有 5.0 strong／clean：grammar、structure、register、必要時 meaning | 全篇 rewrite；也不要假裝它一定 <20 |

**Turnitin-gated patch loop（不要一次上 14 個 patch）：**

```text
A（hz，2–3 個候選，選結構乾淨的）
  → B0 = 最小修補（citation 標點 + 冠詞 + 重複句；≤5%）
  → Turnitin
      <20 → 交付 B0；再逐組加品質修補，每組重測
      ≥20 → 換下一個 A 或縮小 patch 組
              仍 ≥20 → 換 humanizer／模型，不要繼續 polish
```

- **一次只加一組 patch**：citation → articles → duplicate → agreement → tense。每組交一次 Turnitin；過 20 就回退該組。
- **A 的選擇比 polish 重要**：先跑 2–3 次 hz，選沒有碎片、沒有 `(1)(2)(3)`、句數合理的那份。A 本身不乾淨，polish 只會愈救愈糟。
- **quality-first 只能當第二份輸出**：客戶不以 <20 為硬條件時才交；若客戶要求 <20，交 AI-safe，並把 quality-first 的 25% 如實告知。
- **禁止全篇 rewrite**：85% 的實測已經證明它會把 AI 率拉高；這不是「更強的 polish」，是反向操作。

**下一步很具體：** 先交 `final5.0.minfix.docx`。若仍 <20，把它的 14 個修補當成 AI-safe 的第一版規則；若 ≥20，改交 `final5.0.safe.docx`；若兩份都 ≥20，代表 final5.0 的 <20 很脆弱，下一個杠杆是換 A／humanizer，不是再改 B。

---

## 13. 疑難排解

| 症狀 | 處理 |
|---|---|
| `找不到 hz` | `uv tool install "git+https://github.com/sgaofen/humanizer-local-model"` |
| hz 連不上 | 開 Humanizer App，等 `ready`；確認 `http://127.0.0.1:47615/app/status` |
| `缺少 API key` / 401 | 檢查 `polish/.env` 的 `DEEPSEEK_API_KEY`，跑 `polish/test-api.cmd` |
| 429 / 餘額不足 | 換 key 或降低頻率；工具對 429/5xx 會自動重試 4 次（2/4/6/8 秒 backoff） |
| 一直無效 JSON | 先 `--ping`；把 `maxOutputTokens` 調高到 4000–6000 |
| `before not found verbatim` | 模型沒逐字複製；重跑通常會好，否則列人工 |
| `找不到有 python-docx 的 Python` | `uv pip install --python "<uv tools>/humanize-model/Scripts/python.exe" python-docx` |
| `hz 沒有改寫任何段落` | 文件可能只有標題／表格／引用，或段落含超連結／圖片 |
| `修補後段落數不一致` | 很少見；B.docx 不產生，修補文字在 `.pipeline/polished.prose.txt` |
| 網頁 8790 被佔用 | `set PORT=8791 && node server.mjs` |
| UI 開不起來 | 雙擊 `webui\start.cmd`；確認 Node 在 PATH |
| 分數反而上升 | 降低改動幅度（`maxEditRatio: 0.15`、`maxPatchWords: 120`），保持 `--verify audit`；必要時 `cleanup: false` 只做第一輪 |
| 監督輪很慢 | 降低 `maxHzIssues`（例如 4）或 `hzRetries`（3），或設 `hzRetry: false`；API 會接手 |
| hz 重生一直被拒 | 正常，會自動交 API；若 API 也過不了，保留 A 並列人工 |
| judge 一直退回 | 看報告的 judge 分數與 problems；必要時換 `judgeModel`，或先 `judge: false` 用硬性檢查 |
| rewrite 被句數／長度擋 | grammar／fact／citation 的碎片現在可跨兩句；meaning／register 仍一次一句。若仍被擋，改用 patch 或人工修 |
| Gemini 503 high demand | 換 `gemini-3.6-flash`；3.7／3.8 目前常 503。工具會重試 4 次，仍失敗 fallback DeepSeek |
| Gemini 400 location | key 有效，但所在地區不支援；代理出口需 US／JP／SG（TW／HK 會回 400） |
| Clash 代理 | `rewriteProxyUrl` 預設 7897（Verge）；Clash for Windows 用 7890。先 `curl -x http://127.0.0.1:7897 https://www.cloudflare.com/cdn-cgi/trace` 確認 `loc=SG/US/JP` |
| 全篇 rewrite 85% | 不要全篇；5.0 只改缺陷句／段，全篇改寫已列為禁止 |
| 強制修正後品質仍低 | 關 `forceFix`、提高 `forceMinScore`，或換 `judgeModel` |
| B 仍有未解決 | 先看原因：`監督輪無法安全改寫` 是客觀缺陷，人工修；`風格／語意建議` 只挑影響主張的。`maxCleanupRounds` 預設已是 3 |
| A 有段落和原文一樣 | 覆蓋率不足；先跑 `hz --dry-run` 對段數，重跑 hz 或手動處理該段，不要直接交 A/B |

---

## 14. 檔案結構

```text
F:\Humanizer\
├─ Humanizer.exe              官方 desktop app（提供 hz 的引擎）
├─ engine\                    llama-server 引擎（cpu / cuda / vulkan）
├─ pipeline\
│  ├─ pipeline.mjs            原稿 → hz → 修補 → B
│  ├─ docx_bridge.py          python-docx 段落抽取／寫回／全文
│  ├─ run-pipeline.cmd        拖放原稿
│  ├─ samples\                示範原稿與 docx demo
│  └─ README.md
├─ polish\
│  ├─ polish.mjs              修補層 CLI
│  ├─ src\                    text / checks / prompts / llm / pipeline / report
│  ├─ test\                   30 項測試（含 mock API、Gemini adapter）
│  ├─ polish.config.json      API 與參數
│  ├─ .env                    API key（gitignored）
│  ├─ run-polish.cmd          只跑修補層
│  ├─ test-api.cmd            API 連線測試
│  └─ README.md
├─ webui\
│  ├─ server.mjs              本機 HTTP + NDJSON 進度
│  ├─ public\                 index.html / app.js / styles.css
│  ├─ start.cmd               啟動並開瀏覽器
│  ├─ runs\                   每次執行的產物（自動清理）
│  └─ README.md
└─ WORKFLOW.md                本文件
```

---

## 15. 隱私、安全與責任邊界

- **hz 在本機跑**；稿件不會離開這台電腦。
- **修補層會把段落送到你選的 API provider**（預設 DeepSeek）；若 provider 選 `ollama` / `lmstudio`，則留在本機。若客戶資料不能上雲或出境，請改用本機模型，或先取得客戶同意並更新私隱條款。
- API key 只存在 `polish/.env` 或 `polish/polish.config.json`；`.gitignore` 已排除，報告與 UI 不會顯示。
- 網頁 UI 只綁 `127.0.0.1`，不要改成 `0.0.0.0` 或放上公網。
- `webui/runs` 保留每次執行的原稿與產物；兩天或超過 30 次會自動清理。下載的檔案不受影響。
- 這是編輯工具，不是代寫工具：它不生成新內容，只修 Humanizer 造成的破壞。
- 引用與數字以原稿為準；工具不會發明引用，但也無法判斷原稿本身的引用是否正確。
- 任何 AI 偵測結果都不保證。交付前請重新跑正式報告。
- 客戶條款若禁止 AI 輔助，依客戶條款辦理。

---

## 16. 一頁流程卡

```text
□ 原稿（txt/md/docx）
□ hz draft.docx --dry-run：記下應改段數（例如 5）
□ 跑 hz → A（建議跑 2–3 次，選沒有碎片、沒有 (1)(2)(3) 的那份）
□ 確認 log 的「hz 改寫 N 段」＝ dry-run 的段數
□ 跑 audit + repair → B
□ 看報告：
   □ 三稿對照：段落／數字／引用／列表標記
   □ 改動 %（0–25%；>15% 逐項看，25% 是硬停）
   □ 節奏保留（≥80%；80–90% 覆核）
   □ 監督輪：hz 重生 5 次 → 仍不過 API 改寫
   □ 只自動修 grammar／structure／fact／citation／register
   □ 每輪最多 8 個 hz、12 個 action，最多 3 輪
   □ 累計改動達 25% 即停
   □ Quality judge：通過才收；退回帶 feedback 重試
   □ Strong rewrite：最多 3 次；核心維度通過可強制修正
   □ 未解決 0–8 項；critical 必須 0，major 逐項看
□ 人工修 B 的客觀缺陷與影響主張的 advisory
□ 人工校對另存 <name>.final.clean.docx / .txt，不覆蓋自動 B
□ A、B 各跑一次 Turnitin（同一輪）
□ 交付 B.docx / B.txt + 正式報告
```

> 人工校對後建議另存 `.final.clean.docx`，不要直接覆蓋 `.final.docx`；這樣報告裡的 before/after 仍然對得上自動 B，出事可以回頭比對。

常用命令：

```bash
cd F:\Humanizer\pipeline

# 完整流程
node pipeline.mjs draft.docx

# 先看 hz 會改哪幾段（不呼叫模型）
hz draft.docx --dry-run

# 已有 A
node pipeline.mjs draft.docx --humanized draft.humanized.docx

# 只審查
node pipeline.mjs draft.docx --audit-only

# API 連線
cd ..\polish
node polish.mjs --ping

# 測試
cd ..
node --test polish/test/*.test.mjs
```

網頁 UI：<http://127.0.0.1:8790>（`webui\start.cmd`）

---

## 附錄：變更記錄

### 7.4（2026-10-24）— 類型邊界地圖 + 數字斗篷

**類型離線體檢結論（樣稿自製，模仿學生作業；樣稿產生器 `v6-test/samples/make_samples.py`）：**

| 類型 | 樣稿 | 結果 | 最佳離線體檢 | 死因 |
|---|---|---|---|---|
| 反思型 essay（對照組） | 拖延文 | **<20% ×2 + 查重 1%/3% + 0 旗標** | gen 0.03–0.05 | —（基準配方） |
| essay plan（form/label 型） | F1 | ❌ | gen 0.264 | label 列表結構=AI 訊號；hz 改 label 段是負優化（原稿 0.209 → 候選 0.26–0.91） |
| SBA 報告（標題+數據） | R3 | ❌ | gen 0.280（cloak 後；前 0.68） | 正式語域地板；數字牆已破（覆蓋 75%→100%） |
| 議論文（引用+統計） | E2 | ❌ | gen 0.690 | 同正式語域；三候選 100% 覆蓋、CV 帶內，仍被 gen 擋 |
| 中文計劃書 | C4 | ⚠️ 無驗證路徑 | — | hz 中文輸出自然；NLI 英文模型誤殺已修（zh 跳過）；turnitai 只支援英/日/西 |

- **類型邊界的真實維度是語域，不是文體**：個人敘事/第一人稱反思＝綠區（hz 有打散空間）；正式第三人稱（議論文、報告、計劃書）＝紅區（hz 改完 gen 仍 0.28–0.92）。數據密度是第二道牆（已解）。
- **數字斗篷（cloakNumbers）**：改寫前把數字 token 換成 `ZXQnK` 佔位符，hz 繞著改，驗證後還原。詞表含文字數字鏈（"twenty percent"、"sixty-two"、"twenty-first century"——序數詞是 E2 教訓：hz 把 twenty-first 合法改寫成 21st，factNumbers 誤判掉 20）與阿拉伯數字；裸 "First," 開頭不 cloak。殘留 `ZXQnK` 加入 validateUnit 拒絕條件。R3 實測覆蓋 75%→100%。生成與手術兩路徑已接。
- **ideal 預設 `minGrammarDamage` 0.05→0**：H4 實證 damage 0.024 亦 <20%（保護來自節奏非語法傷）；舊地板反過來淘汰了 E2 三個 100% 覆蓋好候選。
- **API 減法死路確認**：GLM-5.3-Flash 兩種合約（保語域／降中學生語域）對 R3：gen 0.96→0.885→0.966。LLM 改寫 LLM 文本仍是 LLM 分佈。
- **R3 段落解剖**：事實密集段（200 人、62%）hz 能到 gen 0.026；抽象評價段（"three main benefits…"）hz 改完仍 0.96——**具體性決定人化空間**。
- `rerank.mjs`（離線重排既有候選）、`grind.mjs`（7.5 原型：段級 tmr 指標反覆重生最差段落）、`glm_deai.mjs`（API 減法實驗，已證死路）入庫。
- zh 修正：NLI 守門跳過中文（英文 cross-encoder 亂判誤殺 C4）。
- avoid-ai-writing skill 警告納入合約設計：減法而非注入（「humanizer 腔」本身就是新指紋）。
- form 修正：formMode 豁免 shortSentenceDensity；form 只看 cvRatio 不看絕對 CV 帶。

### 7.5（2026-10-24 下午）— grind 段級研磨原型打通；E2 達送檢帶

**E2-final2（config 修復驗證）**：`minGrammarDamage` 0.05→0 後，E2 六候選管線首次走完（此前三個 100% 覆蓋好候選全被舊地板淘汰）。選定**重組 X**（逐段取自 cand{5,4,5,5,1,1}）：gen 0.175 / CV 0.567（帶內）/ 零傷 / NLI maxContradict 0.001——E2 從紅區（前測最佳 0.690）回到可測試帶，甚至低於原稿 0.240。本輪早停沒觸發：shouldStopEarly 要求 CV 在帶內，六候選 CV 0.39–0.653 全帶外，照跑全部 6 個（K 開大仍是正解）。

**grind.mjs 修復後首跑**（此前因 `splitSentences` 匯入錯誤——它在 `polish/src/text.mjs`、candidates.mjs 未再匯出——從未成功啟動）：

- 修：匯入 bug、寫暫存檔死碼、<20 詞段落（標題）佔最差三名額、**daemon 洩漏**（Windows 上子進程活得比父進程久，每跑一次漏一隻 ~7.5GB commit 的 python；兩次就把分頁檔撐爆，os error 1455。現在結束時 `closeDetector()` + `process.exit(0)`；撞到 1455 先 `taskkill` 殘留 daemon 再跑）。
- 加：**NLI 矛盾守門**（對原稿段，contradict > 0.5 拒收，與 v6 選擇同門檻——研磨原本只驗數字引用，語義漂移不設防）、增益門檻參數（預設 0.02）、三段溫度梯（1.0/1.1/0.95）。
- **量測尺度教訓**：逐段 tmr 全在 0.82–0.98（短文本單獨過 tmr 嚴重膨脹），整份 tmr 0.17–0.28。研磨內部的逐段分數只做相對比較；驗收一律回整份尺度。

**R3 研磨**（cand3 0.280 起步）：gen 0.280 → 0.171（3 輪）→ 0.168（gain 0.02 續磨）；CV 0.469→0.508 帶內、字數 470 穩定、copyRate 0.014。p2（正式語域開頭段）11 次嘗試卡 0.98——**語域地板在段級重現**。≤0.10 未達，但離原稿 0.963 已 −83%。

**E2 研磨**（candX 0.175 起步，3 輪、gain 0.02、NLI 守門）：**整份 gen 0.030——達 ≤0.10 送檢門檻**。逐段斬獲 p2 0.98→0.05、p6 0.96→0.13、p4→0.66、p3→0.74；edit 0.146 不變（無 AI 修訂訊號）、CV 0.621（x1.66）、數字與四組引用全保留（"two years"→"2 years" 屬詞數字等價，非發明）。

**E2-grind 送檢實測（2026-10-24 13:31，碼 F20A277274）：Turnitin AI 0%、查重 13%、0 integrity flags。** 全校準集首個 0%，紅區文類（正式議論文＋引用＋統計）首次完全通過。離線 gen 0.030 ↔ Turnitin 0%，與 H2/H4 的檔位規律一致；查重 13% 是糖稅主題的常見文獻重疊（9% 網路＋4% 出版物，學生論文 0%）；0 flags 代表數字斗篷與研磨沒有留下操縱指紋。送檔 `E2-grind.docx`（研磨段落經 docx_bridge apply 寫回原稿結構），報告存 `pipeline/v6-test/turnitin/E2-grind_AI.pdf` / `E2-grind_similarity.pdf`。

**結論**：紅區不是死牆——重組 X 把壞段先換掉、段級研磨再把最差段反覆重生，議論文能推進送檔帶並實測 0%。R3 的殘餘阻力是正式報告語域段（p2/p6 類），研磨對它的成功率低（多數嘗試 no gain）。產物：`E:\download\wf7.2-typetest\E2-final2\.v6-E2_argument_essay\candX.grind.prose.txt`。

### 8.2（2026-10-25 凌晨）— 客戶 QA 清單落地＋查重打磨；一鍵三連發全 0%

**背景**：客戶以 E2-oneclick81 對照 E2-grind 提出 7 項品質 QA（標題黏連、論點弱、引用年份錯、嵌套括號、文法小錯、語氣武斷、內容損失）。8.2 把可自動化的 6 項全部變成管線層：

1. **標題保護**（plan 層）：≤9 詞、無句末標點、無引用的目標段判定為標題，不改寫——hz 會把「The Case for…」重寫成「標題＋自創論點」黏連行。run10 起標題永遠原樣。
2. **引用年份一致性**（選定後）：內文 (Author, Year) 與 References 交叉比對；References 為準，唯一候選年自動對齊（實測：Colchero 2016→2017），多義年供人工。零 AI 訊號。
3. **嵌套括號**（mechanicalPolish）：`(for the benefit … (Bandy et al., 2020)).` → 拆外層、引用移句尾。零 AI 訊號。
4. **內容損失救援**：NLI 的 entail 首次參與決策——pair entail < 0.6（filters.minEntail）標記「內容損失」，rescueContradictions 擴展為雙模式（矛盾/內容損失）定向重生。run10 選中候選 entail 0.992，原稿的三理由論點句（This essay argues…）在成品中保留。
5. **選擇器 ppl 平手抉選**：全部 eligible 候選做完 NLI 再選；risk 差 ≤0.02 內選 ppl 較高者（離線查重代理：13%@ppl30.5／22%@ppl23.6 前／16%@ppl23.6 後）。
6. **查重打磨（5.6 步）**：逐句 GPT-2 ppl，重生最 stock（最低 ppl）的 3 句，接受條件＝新句 ppl 嚴格更高＋CoLA＋NLI；整份驗收＝留在送檢帶（gen/傷率/CV/引用），出帶即回退。run10：3 句改寫（ppl 16→20/16→18/16→22），整份 ppl 22.9→23.6。
7. **二級品質手術（5.7 步）**：CoLA 0.7 門檻（0.5 放行的彆扭句）、最多 4 句、從原句重生、逐段 NLI 守門回退。run10 修 1 句（Hypothetical pricing studies…→As an example, hypothetical UK taxation studies…）。

**送檢實測（2026-10-25，碼 #5 05B0C1E1EB，第 19 點）：E2-oneclick82 = Turnitin AI 0%／查重 16%／0 flags**（Submission ID trn:oid:::26334:983976997，664 詞）。**一鍵三連發全 0%**（81 版 0%/22%、82 版 0%/16%，加手動版 0%/13%）；**查重 22%→16%，低於 20% 理想線**，ppl↔similarity 相關性第三點驗證。用戶 QA 7 項：標題✓ 論點句✓ 引用年✓ 嵌套括號✓ 文法（1 句二級手術，殘餘見下）✓ 內容損失（entail 救援就位）✓；語氣武斷屬內容編輯（--quality-edit 待定價，未做）。

**殘餘與 8.3 候選**：hz 在結論段自造「Conclusion In summary」黏連（與標題黏連同源的鏡像行為，plan 層保護管不到重寫輸出——需機械規則剝段落開頭的孤立 heading 詞）；「There are many factors.」碎片與 one of the leading cause 類主謂一致仍在 CoLA 0.7 之下（可試 0.75 但 churn 上升）；Mytton 數字歸屬需人工對文獻；References 的 et al. 展開需作者資料（皆人工欄位）。

**碼帳本：5 碼全用罄**（#1 H2、#2 H4、#3 E2-grind、#4 oneclick81、#5 oneclick82）。校準集 19 點／19 課。

### 8.1（2026-10-25）— NLI 定向重生救援 ＋ 早停 gen 閘；**一鍵紅區首發 0% AI**

**8.1 主項**：`rescueContradictions`（grind.mjs）——NLI 拒收的候選不再整體跳過，只對矛盾段（contradict > 0.5）定向重生（validateUnit＋逐句 CoLA＋NLI 三閘），全候選複驗通過即採用。實戰未被觸發（run9 的星級候選 NLI 0.001 一次過），但機制就位。

**實測逼出的三個鍊路級修正（8.1 加碼）**：

1. **早停 gen 閘（最重要）**：`shouldStopEarly` 原本只看 CV/傷率——與 gen 無關，六輪一鍵實測中「3 個節奏合格但統計上極差（0.5–0.8）的候選」反覆觸發早停，而星級（0.028/0.032）總在第 3–4 位之後被跳過。修正：候選生成時即時 `scoreTexts` 評分，早停條件加 `gen ≤ genGate(0.10)`。**修完首發即中**。
2. **damage 原始刻度**：min-max 歸一化把 0.040 傷率的星級（cand4, gen 0.029）對著 0.045 離群值打成滿格懲罰。改 `dmg/maxGrammarDamage` 有界刻度。
3. **cold final retry**：unit 重試的最後一次用 temp 0.7/topP 0.9——針對 unit 1 引言段「長度暴走」（ratio 30–36）殺 coverage 的失效模式。
4. 研磨溫度梯 3→4 檔（1.0/1.15/0.9/1.05）、輪數 3→5、grind no-op 動作。

**九輪一鍵紅區迭代（E2 原稿，全程零手動介入）**：run1 回退閘正確觸發（研磨後傷率 0.172 超限→回退）→ run2 no-op＋早停 → run3 **0.611→0.106**（gram 閘兩次攔截、NLI 拒矛盾候選）→ run4 全滅暴露早停問題 → run5 0.385→0.134 → run6 0.621→0.220（星級 cand3 0.032 被 damage 歸一化埋沒——促成修正 2）→ run7/8 被藍屏打斷／取樣極差輪（no-op 守門正確）→ **run9：cand3 gen 0.020、CV 0.477 帶內、術後傷率 0.000、NLI 0.001，早停正確命中，研磨跳過，19 分鐘交付。**

**送檢實測（2026-10-25，碼 #4 B398E0B859，第 18 點）：E2-oneclick81 = Turnitin AI 0%／查重 22%／0 Integrity Flags**（Submission ID trn:oid:::26334:530291696，569 詞）。數字（7.6%/1.3%/180,000）與四組引用全存活；0 flags 證明鏈路無操縱指紋。**全校準集第 4 個 0%、第一個完全自動化（無手動研磨、無手動選稿）的 0%。** 查重 22% 高於手動版的 13%（同一主題通用網路來源：lebensmittelverband.de 4%、d-nb.info 3%、who.int 2% 等，Bibliography 已過濾）——客戶訂單若對查重有硬指標，另行壓查重處理。

**離線↔實測檔位再驗證**：gen 0.020 ↔ 0%，與第 13/14/17 點（0.031/0.048/0.030 → <20%）完全一致；≤0.10 送檢紀律線第三次命中 0%。

**8.1 待辦**：星級候選的 damage 帶寬問題（cand3 0.032 + 傷率恰 0.080 被懲罰墊底——校準顯示 5.0 傷率 0.086 反而 <20%，maxGrammarDamage 對 ideal 目標可放寬到 0.12）；查重壓低（22%→<15%）需獨立配方；webui 已同步 8.0（含研磨步與字數欄位），8.1 無 UI 變更。

### 8.0（2026-10-24 深夜）— grind 進主鏈 ＋ webui 對齊；一鍵紅區全鏈打通

**架構**：grind.mjs 重構為函式庫（`grindParas({origParas, paras, lang, rounds, worst, gain, gate, gramCheck, temps, log})`）＋CLI 外殼保留。v6.mjs 新增 **5.5/7 段級研磨**步：essay 選定後、預算/機械/LT 之前執行——gen ≤ genGate（預設 0.10，送檢紀律線）跳過；否則研磨 worst-3 段，**採用條件三閘**：整份 gen 不升、語法傷率 ≤ maxGrammarDamage（0.08）、有段改善（否則 no-op）。form 模式一律跳過（V2 配方）。`--no-grind` 停用；config `grind` 區塊可調。風險卡新增「段級研磨」節（動作、前後 gen、嘗試統計）。

**8.0.1（三次一鍵實測逼出的三個修正）**：

1. **grind 逐句 CoLA 閘（`gramCheck=0.5`）**：首跑研磨救活 3 段（p2 0.976→0.191、p5 0.967→0.019）但引入傷率 0.172 → 整體回退把好段一起丟掉。修正：重生成候選逐句過 CoLA，爛句在閘內拒收，好段保留——次跑同一閘兩次正確攔截（`ungrammatical (1/5 sentences)`），最終傷率 0.000。
2. **選擇器 min-max 刀鋒修正（burst/damage/frag 改原始有界刻度）**：實測 cand1 gen 0.028（final5.0 同檔：CV 0.436 僅差帶下限 0.014）因歸一化把 3% 帶外距離放大成滿格懲罰（risk 0.603 全場最差）被埋沒。修正後權重 burst 0.55→0.3、gen 0.05→0.25、damage 0.3 不變；ranking 單測確認該輪廓排第一。
3. **grind no-op 動作**：0 段改善時不再標「採用」。

**三次一鍵紅區實測（E2 原稿，全程零手動）**：run1 觸發回退閘（研磨後傷率超限→回退，正確）；run2 無段改善早停＋no-op（正確）；**run3 全綠：grind 0.611→0.106（Δ−0.505）、傷率 0.000、NLI 閘拒掉矛盾候選（0.689）、LT 層 0 處**。0.106 距送檢線 0.10 差 0.006——按紀律不送檢；離線帶內已屢現 0.028–0.030 星級候選（每輪取樣都有），瓶頸是「星級候選同時過 NLI＋低傷」的取樣運氣，不是鏈路邏輯。候選 8.1 方向：NLI 拒收的候選改為「對矛盾段定向重生重試」而非整體跳過。

**webui 對齊 8.0**：版本徽章 7.1→8.0；v6 模式補 `--final-name original.final`（修好修訂稿 .docx 下載一直錯位的問題）；進度步驟加「研磨與修整」；新增字數上限／下限欄位（7.6 預算直通）。localhost 冒煙測試過（/api/version → workflow 8.0）。

**定位**：8.0 = 一鍵全鏈（候選→手術→重組→NLI→**研磨**→預算→LT）首次閉環。E2-grind 的 0% 仍由手動鏈保持（第 17 點）；一鍵產品送檢待離線 ≤0.10 的輪次（碼 #4 B398E0B859 留給它）。

### 7.6（2026-10-24 傍晚）— Word Budget：字數上限層（刪除優先）

**動機**：客戶作業常有字數上限。壓縮＝摘要＝LM 最擅長的「編輯平滑化」，正好撞上已驗證的檢測機制（潤飾每級 +10–15%）。故 7.6 的第一原則：**寧可刪，不要改寫**——刪整句零 AI-edit 訊號、零節奏破壞（剩餘文本原封不動）；改寫壓縮是備援，且全程在 validateUnit＋NLI 閘後面。

**實現**：

- **配置**：`v6.config.json` 新增 `wordBudget` 區塊（`enabled/maxWords/floorWords/maxCutRatio=0.3`，預設關閉）；CLI `--max-words`／`--floor-words`／`--force-budget` 覆蓋。
- **計數規則**：References／Works Cited／Bibliography 區塊與其後段落不計（學術字數慣例）；空段不計；中英文各用 `wordCount` 的 lang-aware 實現。
- **刪除優先（`applyWordBudget`，candidates.mjs）**：kept 段（未改寫段）優先刪——那裡零改寫訊號，刪了也不增加任何指紋；目標段其次。句子級篩選：首句／末句（論點與收束）不刪、含數字或引用的句不刪、<6 詞短句不刪、每段最多刪到 40% 保留地板（防止段落被掏空）。
- **定向壓縮（備援）**：刪除後仍超標，只對「超自身比例配額 15% 以上」的目標段跑 hz 壓縮重生成（指令「壓到約 N 詞、可刪細節、不得改義」），最多 3 次嘗試：validateUnit（數字/引用/長度/重複）＋ NLI 矛盾閘（>0.5 拒收）全數適用。**kept 段永不重寫**。
- **超額保險**：削幅 >30% 直接報錯不交付（`--force-budget` 覆蓋，提示人工確認取捨）；低於 floorWords 亦報錯（刪過頭比超標更難救）。風險卡新增「字數預算」節：前後詞數、刪句數、壓縮段數、削幅、CV 警告。
- **CV 警告**：壓縮會平滑節奏——預算步後重算 CV，低於安全帶下限 ×0.9 在風險卡與日誌標 ⚠（本次刪除-only 未觸發）。
- **流程位置**：選擇＋NLI 之後、機械標點／LT 之前（後兩者不改詞數）；kept 段刪減透過 docx map 一併寫回 docx。

**端到端實測（procrastination 文章，615 正文詞，上限 500）**：688 → 476 詞（獨立複核 496），刪 8 句 −212 詞、定向壓縮 0 段、削幅 27%——刪除優先一路達標，壓縮輪全程未啟用即零新增 AI 訊號。正文事實數字（1971/1997/2010/2013/7/70%/9）與引用全數存活（原稿 `(Word count: 599)` 為元資料行、非目標段，不計）；CV 警告未觸發；exit 0，交付 `wb76-final.docx`。離線單測另驗：References 排除、引用句保護、30% 拒收、force 刪除。

**定位**：7.6 是能力層（不動鏈路拓撲、不動選擇與研磨邏輯）。grind 進主鏈（8.0）之前，這是最後一個小版本。

### 7.5 待辦（依證據排序）

1. ~~E2 研磨版送 Turnitin~~ ✅ **0% AI／13% 查重／0 flags（第 17 點已回填）**。下一個動作：**把 grind 整合進 v6**（選擇後自動段級研磨，風險卡加 grind 前後 delta）——與 7.6 一起構成 8.0 的兩大件
2. R3 紅區續磨：p2 類正式語域段嘗試拆句研磨或換 A（0.168 已是研磨天花板跡象）
3. form label 分離改寫（label 前綴剝離、只送內容、回填）
4. webui 對齊 7.x（現仍 6.0 路徑）
5. H1 polish 崩潰根因（--polish 模式，暫態 GLM 疑似）
6. 長會話注意：llama-server commit 會膨脹（實測 20.8GB），長跑後重啟 Humanizer App 釋放
7. turnitai 提交流程已可全自動：提交（DataTransfer 塞 hidden input[type=file] + JS click）→ 輪詢 → 攔截 `downloadFile` anchor → 頁內 fetch 拿 PDF；每碼 1 次，餘 2 碼（B398E0B859、05B0C1E1EB）

### 7.3（2026-10-24）— LT 確定性語法層：品質與偵測特徵脫鉤

- **核心發現**：Turnitin 訊號在節奏/困惑度，不在語法正確性。對 H2（已證 <20%）套 LanguageTool 安全規則修復（H3 實驗）：**CoLA 傷率 0.062→0.031（減半）、CV 0.534 不變、p_ai_gen 0.031→0.032、ppl −1.9**——品質修復與低 AI 特徵完全脫鉤。確定性規則（非 LLM）零 AI-edit 訊號，不像 API 潤飾（final6.1：零傷＋潤飾＝29%）。
- **`polish/lt_fix.py`**：LT 6.8＋便攜 JRE 17（`tools/jdk-17…`，免裝）；安全類別白名單（TYPOS/GRAMMAR/PUNCTUATION/CASING/CONFUSED_WORDS/TYPOGRAPHY），風格規則黑名單；**引用保護**（`(Author, 2024)` 括號與 References 段不動，專有名詞大寫詞 MORFOLOGIK 不改——首版把 Baumrind 改成「Baum rind」的教訓）；單一 server 復用（每段開 server 會炸 port）；`fixmap` 命令供管線逐段處理；中文自動跳過。
- **v6 整合（7.3 預設配方）**：機械標點後、寫 A 前跑 LT 層；**API 潤飾改為 opt-in（`--polish`）**，`--skip-polish` 廢棄——校準集第 13 點證明潤飾是 Turnitin 風險（+10–15%/級）。風險卡新增 `ltFixes` 計數。
- H3＝evolve seed14＋LT（傷 0.031）；H4＝7.1 生產 A＋LT（CV 0.498、p_ai_gen 0.048、傷 ~0.02）——**H4 送檢 code#2 結果：<20%（不顯示數字）**。生產配方全鏈貫通：選擇→手術→機械→LT→零 API 潤飾＝低 AI＋可交付品質（校準集第 14 點）。
- 工具：`language-tool-python`（[PyPI](https://pypi.org/project/language-tool-python)）、[LanguageTool](https://github.com/languagetool-org/languagetool)；參考過 [mrshibly/Humanizer](https://github.com/mrshibly/Humanizer)（定性 prompt 技巧，本管線的量化 CV 帶已覆蓋其「burstiness 工程」訴求）。

### 7.2（2026-10-24）— H2 實測 <20%，ideal 假設成立

- **H2（evolve seed 14）送檢結果：Turnitin AI <20%**（報告直接不顯示數字，註明「低於 20% 門檻因假陽性風險不顯示」）。這是整條管線首次進入理想區，且**零 API 成本**（純 hz temp 1.05/topP 0.95 + 7 次手術 + 擇優，無潤飾）。
- **第 13 個校準點確立主規律**：final6.1（零傷＋API 潤飾）= 29% vs H2（傷 0.059＋無潤飾）= <20%。**潤飾度每升一級，Turnitin 約升 10–15%；殘留粗糙度是保護層**。要進 20% 以下，API 潤飾必須極輕或不用，把 CoLA 傷率停在 0.05–0.15 帶內。
- H2 特徵：CV 0.534（原稿 0.393，ratio 1.36）、傷 0.059、p_ai_gen 0.031（全數據集最低）、ppl 36.2、676 詞。報告存 `pipeline/v6-test/turnitin/H2_ideal_AI.pdf`，校準集已回填第 13 點。
- turnitai.club 下載法備忘：報告按鈕是 anchor click → `downloadFile?fileId=…&downloadFileName=…pdf`；在頁內 fetch（帶 cookie）即可拿真 PDF，不經任何下載視窗。查重報告按鈕旁的 QR 圖是微信廣告，別搞混。

### 7.1（2026-10-24）

- **Rewrite 切換 GLM-5.3-Flash（低思考）**：智譜開放平台，香港直連免代理、Flash 系免費；`rewriteExtraBody` 攜帶 `thinking.level=low`＋`reasoning_effort=low`（API 對未知欄位靜默忽略，兩種寫法都帶保險）。實測 1.2s 完成 rewrite JSON。Fallback 鏈：GLM-5.3-Flash → DeepSeek；judge 保持 DeepSeek。Gemini 相關設定（proxy/thinkingBudget）已從 config 移除。
- **用戶 QA（6.1 vs 7.0）驅動的品質修正**：7.0 交付 A（回退跳過修補）證實 **CoLA 看不見冠詞/單複數/搭配錯**（`each upcoming assignments`、`put more efforts`、`in next evening`）與**標點類錯誤**（`failure. (Baumrind, 1971).` 句點位置、`Hanna et al., 2010) 'T'` 缺句點、直彎引號混用）。結論：回退 A 的品質代價太高，6.1 的「手術＋修補全走完又不掉帶」才是正確操作點。
- **修補嚴格節奏**（`polishCvRetention: 1.0`）：v6 傳 `--min-cv-retention` 給 pipeline，per-patch `rhythmOk` 改為吃同一參數——修補過程中每個 patch 都不得壓低段落 CV，從源頭杜絕「A 0.458 → B 0.377」的抹平。CV 守門保留為最後防線。
- **機械標點修正**（`mechanicalPolish`）：確定性正則——引用句點歸位（`word. (Cit).` → `word (Cit).`）、引用括號後接 SMART 標籤補句點、直彎引號統一、雙句點與空格標點清理。在寫入 A 前套用，B 繼承。
- 43 項測試。

### 7.0（2026-10-24）

- **偵測器 daemon**（`detector_bridge.py` 重構出 `gram_list/nli_list`、新增 `detector_daemon.py`、Node 端 `detector_client.mjs`）：常駐進程、模型只載入一次，評分從每次 30–60s 降到 **0.01s**；整體管線時間約砍 30–50%（650 字 essay 約 35–60 分 → 15–25 分）。斷線自動重拉。
- **自適應早停**（`shouldStopEarly`）：先跑 3 個候選，任一已落在可交付區（balanced：CV 帶內＋零傷；ideal：傷率帶 0.03–0.2；form：傷率 ≤0.05）即停止生成。實測首跑省 3 個候選。
- **採樣多樣化**：預設 samplings 加入 temp 0.9／1.1／top_p 0.90 變體（前 3 個保持原生採樣，早停安全）。
- **段落級重組**（`assembleCrossover`）：逐段從所有候選中選最好（傷率→CV 帶距→黏性 tie-break，保持單一聲音），重組體 X 進入最終排名與 NLI 守門；風險卡標明每段取自哪個候選。
- **手術重複句閘門**：修補產生的重複句（6.1 的 P1／T 段案例）現在手術當場被 nearDuplicate（containment ≥0.8）擋下重做。
- **form 模式引用/數字彙總檢查**：原稿 vs 交付稿的引用與數字清單比對進風險卡，補全品質檢查表四維。
- **CV 守門（B 側）**：修補不得把節奏磨出安全區（B CV/原稿 CV < 1.05 即 6.0 的 56% 特徵）；A 零傷則**回退交付 A**，A 有殘傷則標記人工覆核。首跑實測：A 0.458 → 修補後 B 0.377，觸發回退，交付 A＋人工微修 2 處。
- 42 項測試。

### 6.1（2026-10-24）

- **Turnitin 實測（第 7 次提交）：final6.1 = 29%，用戶裁定可交付**（<30 可接受、<20 理想）。以最佳品質（零語法傷、學術乾淨）落在可接受區，成為預設操作點。
- **新增 CoLA 語法眼 + NLI 守門**（`detector_bridge.py gram/nli`，CPU 秒級）：實測 cand2/cand3 型傷句（`Procrastination too much for…` 0.322、`beat my procrastinate problem` 0.170）與乾淨句（0.9+）乾淨分離；NLI 抓到「contributed to → directly caused」的主張加強（entail 0.41）。這就是「JEV 能力」的落地——型別化語法判斷與蘊含檢查，不需要 JEV 品牌。
- **語法手術**（`surgicalRepair`）：受傷句（P(gram)<0.5）用 hz 對「原稿對應句」局部重生成（本機、零 API、零 AI-edit 訊號），每句最多 3 次、每候選 8 處；從右到左拼接保 offset。爆裂候選不再整體淘汰。
- **排名重構**：burst（CV 帶距離）0.55 + damage（術後語法傷率，硬上限 0.08）0.3 主導；tmr/EditLens/perplexity 降為 tie-breaker（兩個文件族都證明它們在候選間失明）。
- **文件型別分流**（`detectDocType`，模板 label 率 ≥0.15 判 form）：essay → CV 帶 + 手術 + L1 修補；**form/模板 → V2 配方：hz 後幾乎不動，A 直接交付**（唯一被 0% 驗證的操作點）。`--form`／`--essay` 可強制。
- **雙目標模式**（`--target`）：`balanced`（預設，6.1 實測 29%）與 `ideal`（衝 <20：手術門檻放寬到 0.35、保留殘餘傷率帶 0.05–0.2——校準顯示 5.0=0.086/3.0=0.245 才 <20、6.1=0.000 得 29%，**殘餘語法粗糙是保護訊號**；未經驗證，僅給需要 <20 的訂單）。
- **NLI 矛盾守門**：選定候選逐段 (原稿段, 候選段) 檢查，maxContradict >0.5 換下一個 eligible。
- 風險卡新增欄位：傷率（術前/術後）、手術數、NLI 矛盾。

### 6.0（2026-10-24）

- **選擇式管線**：從「單一 A + 重修補」改為「K 個候選 → 離線評分 → 擇優 → 最小修補」。核心依據：EditLens（ICLR 2026）證明「AI 修訂」是獨立可偵測訊號，5.1 的 25% 正是 polish 造成；錯誤改用「淘汰壞候選」解決，不再用 API 修補硬救。
- **離線 AI 風險評分器**（`polish/detector_bridge.py`，全 CPU）：GPT-2 perplexity + tmr-ai-text-detector（RAID 訓練，AI 生成分）+ EditLens ai-detector（AI 生成/修訂分）。歷史回測通過：兩個 <20% 文本正是 p_ai_gen 最低兩個；5.1 是唯一 EditLens 飆升者（0.240 vs 基線 0.147）。
- **候選生成**（`pipeline/candidates.mjs`）：直呼 App `/api/completion`，prompt 與 hz byte-exact（指紋 `cc51d66b4c593fbe` 校驗），採樣可配置；逐段驗證數字/引用/長度/句數/重複句。
- **規劃與 hz 完全一致**（`docx_bridge.py plan`）：直接 import hz 的 `hz_docx.plan`，覆蓋率定義與 `hz --dry-run` 相同。
- **選擇器**：硬過濾（覆蓋率 100%、句數膨脹 ≤1.5、短句密度 ≤0.4、copy_rate ≤0.6）→ 加權風險排名（`pipeline/v6.config.json` 可校準）。
- **v6 入口**（`pipeline/v6.mjs`）：plan → K 候選 → 評分 → 選擇 → 交 pipeline.mjs 做最小修補 → B 再評分 → 風險卡（A→B 的 EditLens delta = 修補新增的 AI 修訂味）。
- 開源偵測器都是 proxy，不是 Turnitin；排序用途合法，絕對分不可信；權重需用 Turnitin 數據點季度校準。
- **6.0 首跑實測（2026-10-24）**：4 候選中 2 個碎片型被硬過濾淘汰（碎片率 50%，證明選擇器必要）；選定候選 gen 0.025（原稿 0.559，降 96%）；修補後 B 的 EditLens delta +0.001（5.1 的教訓值 +0.09）。**人工修補鐵律**：只修語法，不還原原稿措辭——實測 13 處「還原 draft 用語」把 p_ai_gen 從 0.047 拉回 0.420；6 處純語法修正後 0.058（與 <20% 的 final5.0 同檔）。EditLens 對人工編輯不敏感，證實 AI 修訂味與人手修改是不同訊號。
- 評分請用**純正文**（hz 改寫的段落）；References 列表是超低困惑度文本，混入會污染分數。
- **6.0 Turnitin 實測（2026-10-24）：final6.0 = 56%，失敗，原因已定位。** 選擇器當時以「碎片」為由淘汰了兩個高節奏候選（CV 0.591/0.495），選出最平滑的 cand4（CV 0.387）——**比 AI 原稿（0.393）還平滑**。校準集（`pipeline/v6-test/calibration.json`，6 個真實 Turnitin 點）顯示：**句長 CV（burstiness）是最強預測因子**——通過者 CV 0.414（5.0）/0.644（3.0），比原稿平滑或帶 AI 修訂 delta 者失敗；tmr/EditLens/perplexity 在 hz 候選之間失去鑑別力（5.0 gen 0.046 通過、6.0 gen 0.058 失敗）。
- **6.0.1 選擇器修正**：新增 `cv`/`cvRatio` 特徵；硬性規則「候選 CV 不得低於原稿 CV 的 1.1 倍」；排名以 CV 帶（預設 0.45–0.65，權重 0.4）為主；句數膨脹不再是硬過濾（爆裂節奏正是 Turnitin 容忍的風格，其語法傷害交由 unit 驗證與修補層處理）；候選數提高到 8。教訓：hz 的「平滑候選（語法好）」與「爆裂候選（Turnitin 抗性）」反相關，通過者是中間的抽樣——選擇器的職責是把 K 開大、往 CV 帶裡選，而不是製造通過者。

### 5.0（2026-10-23）

- hz 重生由 2 次提高到 5 次；5 次仍不過才交 API。
- Rewrite 預設 Gemini Flash（`gemini-native`，經 `rewriteProxyUrl`），judge 保持 DeepSeek；Gemini 被地區擋或 503 時自動 fallback DeepSeek。
- **Gemini 實測修正**：`gemini-2.5-flash` 已對新用戶下架；`3.7`／`3.8` 常 503；改用 `gemini-3.6-flash` + `thinkingBudget: 0`，503 重試 4 次。
- **Strong mode**：API rewrite 最多 3 次，帶上一次失敗原因；critical/major 的核心維度（meaning/facts≥4、academic≥3、total≥16）通過就強制套用，報告標「強制修正」。
- API rewrite 模型可獨立設定（`rewriteProvider`/`rewriteModel`/`rewriteApiKey`）；新增原生 Gemini adapter（`gemini-native`）。
- **多句語法修復**：grammar／fact／citation 的碎片可跨兩句合併或拆分；之前 1→2 一律被擋，是 `The 'S' (specific).` 修不掉的主因。
- **數字詞等價**：`three`＝3、`six`＝6；引用內年份不算獨立事實。
- **近似重複句**：token containment ≥0.8 會擋，避免 `I have always…` / `This has always been…`。
- **只自動修客觀缺陷**：監督輪只處理 grammar／structure／fact／citation／register；meaning／terminology／cohesion 列人工，避免為同義詞過度改寫。
- **25% 硬預算**：每個修補套用前檢查 A→B 累計差異，超過就回滾並停止；實測把 41% 的過度改寫壓到 23%，節奏保留 93%。
- **覆蓋率檢查**：pipeline 顯示 `hz 改寫 N 段`；要等於 `hz --dry-run` 的段數。2.0 final 的 59% 案例是 5 段只改了 4 段。
- **交付判定**：critical 未清零＝不建議交付；有 major＝可交付但需覆核；全過＝通過。
- 全篇改寫正式禁止：全篇 rewrite 實測 85%，5.0 只改缺陷句／段。
- 30 項測試。

### 4.0（2026-10-23）

- API rewrite 注入 `academic-humanizer` skill 合約（最小改動、來源忠實、保留引用數字、學術語域）；保留 `avoid-ai-writing` 作替代合約。
- 加入獨立 **quality judge**（25 分 rubric；建議不同模型）；通過才套用，失敗帶 feedback 重試一次，仍不過保留 A。
- Patch-first：minor 只准 patch；rewrite 只限 major/critical 或結構問題，且一次一句。
- hz 重生 → API 改寫 → judge → 重審；judge 通過的 rewrite 不會因缺陷數未下降被誤刪。
- 27 項測試。

### 3.0（2026-10-23）

- 監督輪改為 **hz 重生優先**（預設 2 次）→ API 改寫 fallback → 重新審查；加入整輪回滾與 hz/API 統計。
- 移除預設「回退到原稿」；改寫失敗保留 A 並列人工。
- 新增 docx 支援（hz docx 模式 + python-docx 橋接）與三稿對照報告。
- 新增本機網頁 UI、Workflow 版本徽章、差異標示、A/B/docx 下載。
- 修補層 26 項測試。

### 2.0（2026-10-23 早）

- 加入 audit → repair → verify 與最小替換的硬性校驗；API（DeepSeek）優先。
