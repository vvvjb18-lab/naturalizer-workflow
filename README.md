# Naturalizer Workflow

本地化學術文本「去 AI 味」處理管線（Humanizer 12B GGUF ＋ 學術修復層），目標：低 Turnitin AI 偵測（<20%）＋ 可交付品質（B+ 錨點門）。

**目前版本：10.0**（雙引擎並聯：routeb 去 AI 腔 ＋ routea 學生語域，配新引擎族的 CV 下限與雙軌驗收；`ARCH10=1` 啟用，預設仍走 9.0。架構見 `docs/WORKFLOW-10.0.md`）

**9.0**（8.18 選擇式管線之上加入分層架構 opt-in：L0 五狀態路由／L1 診斷／L2 論證骨架／L3 三環否決／L4 版本帳本／L5 族軸校準，`--arch90` 啟用，預設路徑不變。沿革見 `docs/WORKFLOW.md`，藍圖見 `docs/ROADMAP-9.0.md`）

### 10.0 實測要點

| 項目 | 結果 |
|---|---|
| S4 純 AI 文檔（原 98% AI） | 並聯擇優後 **<20% AI / 6% 查重 / 0 flags** |
| 新引擎族 CV 門檻 | **0.42**（舊族 0.54 不適用；實測 CV 0.465 即過） |
| A → B 串聯 | **無效**——B 對已像人寫的輸入照抄（lev 0.00–0.085） |
| 語法修復對分數的影響 | **無**（l2_fix 修 15 處後 CV 0.472→0.474、ai_mk 不變） |
| 未閉合 | 字數膨脹 1.20–1.30，需接 `applyWordBudget` 壓回 1.12 |


**新讀者請先讀「逐步詳解」一節**——它解釋管線每一步在做什麼、為什麼存在、失敗時會發生什麼。

**完整開發史**（10-23 → 10-29，每個設計決定背後的失敗與實測）見 **[`docs/history/`](docs/history/README.md)**：
從 E2 的 59%、R3 的誤讀、極端文檔崩潰、引擎天花板，到 10.0 的三次 D1 失敗與真碼驗證。

---

## 這條管線在解決什麼問題

兩條實測規律決定了整個設計：

1. **「潤飾度每升一級，Turnitin 約 +10–15%」**（校準集第 13 點：零傷＋API 潤飾 = 29% vs 無潤飾 = <20%）。所以不能「先改寫再美化」——每一步修復都必須以「整份留在送檢帶」為驗收條件，任何一步把分數推高就整體回退。
2. **「離線指標不能預測 Turnitin 分數」**（1,800 篇學習者＋4,670 篇期刊、169 特徵的因子研究：分類器 AUC 0.998 但對真實分數完全飽和，留一回歸 MAE 33 個百分點）。所以管線從不對著 Turnitin 迭代，只對著離線代理（gen／ppl／CV）收斂，Turnitin 檢測碼只花在里程碑驗證。

因此整條管線的形狀是：**多候選抽樣方差 → 離線擇優 → 定向修復（每步帶內驗收）→ 確定性語法層 → 風險卡交付**。

## 快速部署（Windows）

```
git clone https://github.com/vvvjb18-lab/naturalizer-workflow.git
cd naturalizer-workflow
scripts\setup.bat        # 檢查 Node/Python、裝依賴、探測模型服務
scripts\start-all.cmd    # 啟動 WebUI → http://127.0.0.1:8790
```

**模型後端（必需，單獨安裝）**：管線透過 `http://127.0.0.1:8080` 呼叫本地 llama.cpp 服務（Humanizer App 或自架 `llama-server -m <12B GGUF>`）。模型權重與 llama.cpp 二進制不入庫（見 `.gitignore`）。

**離線評分（可選，跑 daemon）**：`python polish/detector_daemon.py`（需要 torch 與對應 detector 權重）。

**配置**：`pipeline/v6.config.json`（管線參數）；`polish/polish.config.example.json` → 複製為 `polish.config.json` 並按需填 API key 環境變數（金鑰不入庫）。

**命令行用法**：`node pipeline/v6.mjs <原稿.docx>`，或把原稿拖到 `pipeline/run-pipeline.cmd`。常用旗標：`--out-dir <dir>`、`--max-words N`（字數預算）、`--arch90`（9.0 分層架構）、`--seed <txt|json>`（風格種子／作者錨定）、`--no-grind`／`--polish`（見第 6/7 步）。

---

## 管線總覽（v6.mjs 全鏈）

```text
原稿 docx
  → 第 0 步   接單預檢（precheck.mjs：文檔畫像 gen/CV → 文檔族分類 → 耗時與風險預期）
  → 第 1/7 步 規劃（docx→plan 單元切分、標題保護、form/essay 型別、9.0 路由）
  → 第 2/7 步 候選生成（K≤6 個抽樣候選；數字斗篷；逐單元事實驗證；自適應早停）
  → 第 3/7 步 離線評分（daemon 常駐：CoLA 傷率＋tmr gen＋EditLens edit＋GPT-2 ppl）
  → 第 4/7 步 語法手術（受傷句 hz 局部重生；重複句閘門）
  → 第 5/7 步 選擇＋段落重組＋NLI 守門（CV 帶過濾；逐段取優 X；矛盾/內容損失定向救援）
  → 第 5.5 步 段級研磨（gen 超門檻時：最差段定向重生，整份改善才採用）
  → 第 5.6 步 查重打磨（重生最 stock 的句子，打散 n-gram 指紋）
  → 第 5.7 步 二級品質手術（CoLA 0.7 彆扭句重生，逐段 NLI 守門）
  → 第 5.8 步 語域手術（縮寫/第二人稱/口語碎片掃描重生，整體帶內驗收）
  → 第 5.9 步 字數預算（刪除優先）＋引用一致性（文中年份對齊 References）
  → 第 6/7 步 交付（機械標點＋LT 確定性語法層；API 潤飾僅 --polish opt-in；CV 守門）
  → 第 7/7 步 風險卡（候選對照表＋A→B 變化＋校準結論對照＋9.0 帳本）
```

---

## 逐步詳解

### 第 0 步：接單預檢（`precheck.mjs`）

**做什麼**：在不動用任何改寫的前提下，對原稿跑一次離線畫像——gen（tmr AI 機率）、CV（句長變異係數）、語域、長度——把文檔歸入已知族（個人敘事／正式論證／報告／表單……），輸出本單的預期路徑、耗時與風險。

**為什麼**：校準集反覆證實「文檔族決定難度」——第一人稱個人敘事是綠區（gen ≤0.4 全自動可到 0–3%），正式第三人稱論證文是紅區（必須靠 grind 破境），純 AI＋句構均勻類是 12B 引擎天花板（自動化路徑不存在）。預檢把「這單能不能接、要走哪條路」提前說清楚，避免跑了兩小時才發現是天花板類。

### 第 1/7 步：規劃（hz planner）

**做什麼**：
- `docx_bridge.py plan` 把 docx 解析成 `plan.json`：段落 → 改寫目標（`targets`）→ 單元（句級 `units`＋`joiner`），同時記錄不改寫的部分（`kept`：標題、References、表單欄位等）。
- **標題保護**：≤14 詞、無句末標點、無引用的目標段判定為標題，原樣交付——hz 會把短標題「改寫」成「標題＋發明的論點」黏成一句（run9 實測）；首段 ≤45 詞且含問號的「題目＋作業提示」同樣跳過。
- **文件型別偵測**：按 label 率（表單欄位特徵）分 `form／模板`（V2 配方，CV 帶不適用）與 `essay`（CV 帶選擇）。`--form`／`--essay` 可覆蓋。
- **8.18 `--shred`（opt-in）**：前置粉碎——`shredder.py` 在進 hz 之前做確定性依存樹擾動（語態轉換／拆句／併句／語序重排），並帶事實守衛（丟數字即回退）。用於原稿太「乾淨整齊」、hz 輸出重複率會爆的場景。

**9.0（`--arch90`）在這一步做三件事**：
- **L4 版本帳本**：建立 `ledger.jsonl`，原稿入帳作為回退基準——之後每個階段的每次改動都留 before/after＋否決紀錄，最終交付可整體回滾。
- **L0 路由（文本期）**：`router.mjs` 按文本特徵定 S1–S5 狀態。**S5（引用無法核驗）→ 停改令，直接退出**（本管線不處理幽靈引用）；S3（重複論證文檔）→ 警告並進行**前置去重**：在 plan 層刪除 token 重疊 ≥0.85 的近重複句（保留首個）——重複論證文檔會讓 hz 輸出自帶重複句而被單元驗證器整體殺死，先刪重複再重建事實基準。
- 帳本紀錄路由決定。

**失敗行為**：plan 沒有可改寫段（全是標題／短段）→ 報錯退出。

### 第 2/7 步：候選生成（K≤6，`candidates.mjs`）

**做什麼**：對同一份 plan 生成最多 6 個完整改寫候選，每個候選用不同採樣參數（`samplings`：前 3 個 temp 1.0/top_p 0.95，其後 0.9／1.1／0.9+top_p 0.9）——**抽樣方差是主要的多樣性來源**：實測爛種子收斂早、好種子分數差異大，多候選比單候選多輪調參便宜得多。

每個候選的生成流程：
- **單元級改寫**：逐 unit 呼叫本機 Humanizer 12B（`/api/completion`，提示詞位元組精確指紋 `cc51d66b4c593fbe`），不是整篇一次過——整篇生成會丟句、丟引用。
- **數字／引文斗篷（`cloakNumbers`）**：生成前把數字與引用標記替換成佔位符，生成後還原——模型改寫數字（把 30% 寫成 three in ten）是事實事故的最大來源。
- **逐單元驗證（`validateUnit`）**：每個 unit 生成後立即驗證——數字集合一致、引用一致、長度比在帶內、無重複句。不過就重試（`unitRetries: 2`），重試仍不過記為 `failures` 並保留原句。
- **自適應早停（`adaptive`）**：先生成 3 個（`adaptiveFirst`），若已有候選落在可交付區（gen 閘＋CV 帶），跳過剩餘生成——省 20–40 分鐘。

生成中同步做：`candidateStats`（覆蓋率／句數變化／CV／cvRatio／複製率）、`grammarDamagePre`（術前 CoLA 傷率）、即時離線評分（供早停判斷）。

### 第 3/7 步：離線評分（daemon：CoLA ＋ tmr/EditLens/perplexity）

**做什麼**：`detector_daemon.py` 常駐進程（`detector_client.mjs` 以 stdin/stdout JSON 往返呼叫，避免每次 30–60 秒的模型載入），對每個候選＋原稿輸出四把尺：

| 尺 | 模型 | 度量什麼 |
|---|---|---|
| 傷率 | CoLA | 句級語法可接受度，<0.5 記為「受傷句」，傷句/全句 = damage |
| p_ai_gen | tmr-ai-text-detector | 整份文本的 AI 生成機率——**Turnitin 的離線代理主尺** |
| p_ai_edit | EditLens | 「被 AI 編輯過」機率——偵測修復層是否反而引入 AI 指紋 |
| perplexity | GPT-2 | 用詞意外度——ppl 越低越 stock（模板化），與查重相似度相關（E2 家族：ppl 30.5 → 13% vs ppl 24.9 → 22%） |

**為什麼是離線**：見開頭規律 2——離線尺不做 Turnitin 分數預測，只做**排序與閘門**（哪個候選更好／這份能不能送檢）。送檢判定用的是校準結論（gen ≤0.05 → <20%；gen 0.24+ 一律不送），不是回歸。

### 第 4/7 步：語法手術（hz 局部重生＋重複句閘門）

**做什麼**：對術前傷率 >0 的候選，`surgicalRepair` 只把受傷句（CoLA < `grammarThreshold` 0.5）抽出來，用 hz 對原句局部重生（`surgeryTries: 3`），替代整段重寫——整段重寫會把已過驗證的好句一起賭掉。重生日誌帶**重複句閘門**：重生結果與既有句子重複即拒收。

**參數**：`grammarDamageDrop: 0.3`——術前傷率超過 0.3 的候選直接跳過手術（改寫已經把文檔打爛，手術救不回來，讓排名器去淘汰它）。手術後重算 CV／傷率（殘餘 damage）。

### 第 5/7 步：選擇＋段落重組＋NLI 守門

這是管線的核心決策步，三個子步：

**5a. 排名過濾（`rankCandidates`）**：按 `filters` 淘汰不合格候選——
- `minCoverage: 1`（事實覆蓋 100%，丟句即淘汰）
- `cvBand: [0.45, 0.65]`＋`minCvRatio: 1.1`（句長節奏必須落在人類帶且比原稿有變化——CV 是雙特徵交付規則的一軸：CV ≥0.54 全過／≤0.28 必敗）
- `maxGrammarDamage: 0.08`、`maxShortSentenceDensity: 0.45`、`maxCopyRate: 0.6`

**5b. 段落重組 X（`assembleCrossover`）**：覆蓋率 100% 的候選 ≥2 時，按逐段離線分數**每段取最優候選的那一段**拼成重組候選 X（帶 `provenance` 出處表）。直覺：不同候選各有擅長段，整份最優常是「各取所長」而非「某一個候選全贏」。9.0 下 X 必須與其他候選一樣過否決環，不過則棄用 X。

**5c. NLI 守門（`nliPairs`＋`rescueContradictions`）**：對每個存活候選，逐段跑（原段，改段）的 NLI cross-encoder：
- `contradict > 0.5`（語義矛盾）或 `entail < 0.6`（內容損失）的段 → **定向救援**：只重生冒犯的段，再整份復驗；全數修好才採用救援版。
- 全部段落乾淨才進入最終選擇；同風險分時以 **ppl 平手抉選**（ppl 高 = 用詞較不 stock = 查重相似度較低）。
- 豁免：短文檔（<6 句，cross-encoder 在短對上不可靠）與中文文稿（NLI 模型是英文的）跳過守門，由確定性環把關。

**9.0（`--arch90`）**：存活候選先過 **L3 三環否決**（`verify_gates.mjs evaluateText`）——
- **第一環 內容正確性（一票否決）**：數字丟失／發明、引用丟失／發明（先做 8.2 引用一致性對齊再比較）、限定語丟失 ≥50%（hedge loss，主張強度被拉高）、專名縮寫丟失、NLI 矛盾。
- **第二環 結構完整性（一票否決）**：結構新增（多出標題/列表項）、重複句增加、截斷（停在半句）。
- **第三環 品質維度（只記錄不否決）**：containment、證據密度等進帳本與報告。

被否決的候選即使離線分數再好也不採用；全部被否決時保留原排名續走，交付前最終否決會**回退原稿**（寧可不交也不交壞的）。

### 第 5.5 步：段級研磨（grind，`grind.mjs`）

**做什麼**：選定候選的 gen > `genGate` 0.1（還在紅區邊緣）時自動啟動——每輪取**離線分數最差的 3 個段**（`worst: 3`）定向重生，最多 5 輪（`rounds: 5`；實測正式語域段常在第 3 輪後才鬆動）。

**驗收（關鍵）**：每輪結果必須**整份分數改善 ≥0.02（`gain`）且傷率留在帶內**才採用，否則整體回退——局部變好但整份變差是常見陷阱。重生段同樣過 `validateUnit`＋NLI＋鄰句 jaccard 閘門。form 模式一律跳過。

**極端路徑（`extremePath`，原稿 gen >0.8）**：4 候選＋句級優先研磨 15 輪、前 5 輪不收斂即停（`dryStop`），目標一鍵 ≤60 分鐘。

### 第 5.6 步：查重打磨（similarityPolish）

**做什麼**：找出**逐句 ppl 最低的 3 句**（最 stock、最模板化的句子——它們與網路文本的 n-gram 重疊最高，是查重相似度的主要來源），逐句重生，用「意外用詞」打散指紋。

**驗收**：整份必須留在送檢帶（gen／傷率／CV／引用全部復查），0 句改善則文本不變。注意這步壓的是**查重（similarity）**不是 AI 偵測——兩者是 Turnitin 的不同指標。

### 第 5.7 步：二級品質手術（qualitySurgery）

**做什麼**：第 4 步手術閘是 0.5（只救「明顯病句」），這步把閘提高到 0.7——處理「CoLA 0.5 放行但 0.7 不過」的彆扭句（語法勉強對但讀起來怪，如 "massive amount of free sugars" 類），最多 4 句，從原句重生。

**守門**：每個改動的段落過 NLI，矛盾 >0.5 即回退該段——品質修復不允許引入語義風險。

### 第 5.8 步：語域手術（register surgery）

**做什麼**：掃描語域違規——縮寫（don't）、第二人稱（you）、修辭問句、句子碎片、口語填充詞——逐句以學術語域指令重生（"no contractions, no second person, no rhetorical questions…"），重生日標先過 `cloakNumbers`＋`validateUnit`。

**驗收**：整體帶內驗收（同 5.5 邏輯）——語域修正把文本推向「乾淨正式」，而乾淨正式正是 LLM 稠密區，所以每次語域手術後都必須復查 gen 沒有被推高。

### 第 5.9 步：字數預算＋引用一致性

- **字數預算（`wordBudget`，7.6）**：`--max-words` 指定時執行——刪除優先（冗餘從句、重複修飾），超配額段才定向壓縮；全程 `validateUnit`＋NLI 守門。`floorWords` 可選下限；超過 `maxCutRatio` 即拒絕（`--force-budget` 覆蓋）。刪除比壓縮安全：壓縮是改寫，會重新引入 AI 指紋。
- **引用一致性（`citationConsistency`，8.2）**：內文年份以 References 列表為權威對齊——內文寫 (2016) 但 References 是 (2017) 時修正內文。這修的是品質評分項（APA in-text matching），也讓第一環否決的引用比較不會誤判。

### 第 6/7 步：交付（機械標點＋LT 語法層；API 潤飾 opt-in）

**做什麼**：
- **預設配方（7.3）**：A 稿（選定候選）→ `docx_bridge.py apply` 寫回 docx（保留原格式）→ **機械標點**（確定性節奏修補，零模型）→ **LT 安全修復**（`lt_fix.py`，LanguageTool 6.8 en-GB，只開安全類別；引用／專有名詞／References 保護）→ 交付 A。
- **API 潤飾僅 `--polish` opt-in**：校準第 13 點（潤飾每級 +10–15% Turnitin）之後，API 潤飾從預設路徑移除——只有品質優先模式才走 `pipeline.mjs` 修補層，並產出 B 稿。
- **CV 守門**：走了 B 稿時，若 B 的 CV／原稿 CV < 1.05（節奏被磨平，校準：ratio <1.05 曾打出 56%），A 本身零傷則**回退交付 A**；A 有殘傷則保留 B 並標記人工覆核。

### 第 7/7 步：風險卡

**做什麼**：產出 `<name>.v6.report.md`＋`.json`——
- **候選對照表**：每候選的覆蓋率／CV／術前術後傷率／手術數／ppl／gen／edit／NLI 矛盾／risk 與淘汰原因；
- **A → B 變化**：EditLens delta 參考門檻 0.1（歷史：5.1 失敗值 +0.09）；
- **原稿基準**與全項目統計（budget／grind／similarityPolish／citationCheck／qualitySurgery／cvGuard）；
- **9.0（`--arch90`）附加**：路由狀態與建議、L1 診斷（`diagnostics.mjs`，可帶 `--seed` 作者真實寫作樣本做錨定）、最終否決判定與是否回退、論證骨架（L2）、帳本路徑、**錨點門**（`anchor_gate.mjs`：對照 HKU SPACE 人類 A 級樣本的 B+ 質量門）。

風險卡是唯一交付憑證：送檢與否的判定（對照校準結論）由讀卡的人做，管線不自行宣稱「會過」。

---

## 9.0 分層架構（`--arch90` opt-in）

| 層 | 組件 | 職責 |
|---|---|---|
| L0 | `router.mjs` | S1（gen≤0.4 保守編輯，跳過候選生成，僅 LT＋標點）／S2 標準全鏈／S3 重複論證（警告＋前置去重）／S4 純 AI（退回作者——引擎天花板）／S5 引用無法核驗（停改令退出） |
| L1 | `diagnostics.mjs` | 發佈前診斷：文檔族、節奏、語域，可帶作者樣本錨定 |
| L2 | `argument_map.mjs` | 論證骨架抽取（S3 文檔交付時檢查；本版僅記錄） |
| L3 | `verify_gates.mjs` | 三環否決（見第 5/7 步） |
| L4 | `ledger.mjs` | 版本帳本：每階段 before/after＋否決紀錄，支援回退原稿 |
| L5 | `calibration.json` | 族軸校準：按文檔族查送檢結論（22 點／22 課） |

設計原則：**分層只做守門與記錄，不改寫文本**——改寫仍是 v6 主鏈。預設（無 `--arch90`）行為與 8.18 完全一致。

---

## 倉庫結構

```
pipeline/   主鏈與候選生成（v6.mjs、candidates.mjs、grind.mjs、assault.mjs、precheck.mjs、
            9.0 層：router/ledger/diagnostics/verify_gates/anchor_gate/argument_map.mjs、
            docx_bridge.py、shredder.py…）＋ canary 金絲雀 ＋ samples ＋ v6-test/calibration.json
polish/     修復層（polish.mjs + src/）、LT 安全修復（lt_fix.py）、detector daemon/bridge、
            skills 合約、test/（43 測試）
webui/      本地 Web 介面（server.mjs → 127.0.0.1:8790）
scripts/    一鍵部署（setup.bat、start-all.cmd）
docs/       WORKFLOW.md 完整版更日誌＋ROADMAP-9.0.md 藍圖
evidence/   實測證據包（E2-grind 全套；turnitin-reports/ H2/H4 原件）
finetune/   9B 微調實驗（pairs_all.jsonl 714 對、QLoRA 訓練腳本、Colab 逐夜訓練器）
```

## 核心組件

| 組件 | 說明 |
|---|---|
| `pipeline/candidates.mjs` | 候選生成：單元級改寫、數字／引文斗篷、事實校驗（數字、引文、長度比、重複句）、引用一致性 |
| `pipeline/v6.mjs` | 主鏈編排：規劃 → 候選 → 評分 → 手術 → 選擇/重組/NLI → 研磨/打磨 → 交付 → 風險卡 |
| `pipeline/grind.mjs` | 段級研磨：tmr 評分最差段定向重生（5 輪 × worst-3），整份改善＋傷率帶內才採用，NLI 矛盾閘 |
| `pipeline/verify_gates.mjs` | 9.0 三環否決：內容正確性／結構完整性（一票否決）＋品質維度（記錄） |
| `pipeline/router.mjs` | 9.0 L0 路由：S1–S5 狀態機，S4/S5 停改令 |
| `pipeline/anchor_gate.mjs` | B+ 質量門：對照 HKU SPACE 人類 A 級錨點樣本 |
| `polish/lt_fix.py` | LanguageTool 6.8 安全類別修復（引用／專有名詞／References 保護，en-GB） |
| `polish/detector_daemon.py` | 離線評分常駐進程：CoLA 傷率＋tmr gen＋EditLens edit＋GPT-2 ppl |
| `pipeline/precheck.mjs` | 接單預檢：文檔畫像 → 族分類 → 路徑/耗時/風險預期 |

## 校準結論（22 點／22 課，`pipeline/v6-test/calibration.json`）

- gen ≤ 0.05 → Turnitin <20%（三例實測：H2 0.031／H4 0.048／E2-grind 0.030；一鍵 8.1/8.2 復現 0.02/0.034 → 0%）
- API 潤飾每級 +10–15% Turnitin；gen 0.24+ 一律不予送檢
- 個人敘事（第一人稱）＝綠區；正式第三人稱（argumentative/report）＝紅區，需 grind 破境
- 雙特徵交付規則（9/9 吻合）：CV ≥ 0.54 → 全過；CV 0.38–0.39 → gen 決定（0.76 過／0.98 敗）；CV ≤ 0.28 → 敗
- 離線指標（169 特徵）不能回歸預測 Turnitin（MAE 33pp），只能做排序與閘門
- 能力邊界：有真人底子（gen ≤0.4）全自動 0–3%；純 AI＋高質量＋句構均勻類為 12B 引擎天花板（自動化路徑不存在，見 WORKFLOW「項目開發史與瓶頸回顧」）

## 證據包

| 案例 | 結果 | 位置 |
|---|---|---|
| E2-grind（紅區 argumentative） | **0% AI／13% 查重／0 Integrity Flags** | [`evidence/E2-grind/`](evidence/E2-grind/) |
| H2_ideal / H4_prodLT | **<20%（不顯示數字）×2** | [`evidence/turnitin-reports/`](evidence/turnitin-reports/) |
| E2 一鍵 8.1 / 8.2 | 0% AI／22%、0% AI／16% | calibration 第 18–19 點 |
| compare-stores 攻堅（原稿 0.983） | 0.573→**0%**（碼5）＋41%/98% 標定 | calibration 第 20–21 點 |

每個證據包含：Turnitin 原件 PDF、三件套 docx（原稿/A 稿/B 稿）、終端 log、校準數據、統一報告 PDF 與其建置腳本 `build_pdf.py`。內容索引見各包內 `MANIFEST.md`。

## 完整性聲明

- `04_metrics/calibration.json` 曾因寫入中斷損壞（缺一逗號），僅補回分隔符修復，原件保留於本地 `calibration.json.bak-corrupt`
- grind log 由 stdout 重排，段落重生統計（成功 7／no-gain 9／驗證拒絕 4）與原始輸出一致

## 授權與存取

本倉庫為 **Private**，僅限擁有者與獲邀協作者存取。內含 Turnitin 提交紀錄與客戶交付證據，請勿轉公開、勿外流。
