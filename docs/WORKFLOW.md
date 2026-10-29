# Humanizer Workflow 10.0 — 完整說明

> **一句話**：先路由（四語域特徵 × 五狀態）→ 雙引擎並聯抽樣（routeb 去 AI 腔＋routea 學生語域）→ 逐段擇優＋CV 保底 → 確定性修復層（語法規則庫／縮寫展開／LT／字數預算）→ **雙軌驗收**（分數軸＋質量軸，兩軸都過才交付）→ 帳本與風險卡。
>
> **版本**：10.0 · **最後更新**：2026-10-29 · **代碼倉庫**：`naturalizer-workflow`（權威）· **運行時安裝**：`F:\Humanizer`（截至 10-28 只到 9.0.5，**未含 10.0 代碼**）
> **校準**：23 個數據點（22 個舊引擎族＋1 個 10.0 新族錨點）· 兩條檢測渠道（turnitai／OriginCheck）· 23 條課訓
> **實戰**：23 次真實送檔——**6 次 0% AI**、共 11 次 <20%（含 10.0 的 <20%／6% 查重／0 flags）

> **閱讀順序**：① 本節「文件狀態與勘誤」→ 知道哪些內容可信；②「現行管線」→ 知道怎麼跑；③ 附錄 A 變更記錄 → 查版本；④ [`docs/history/`](history/README.md) → 讀每個決定的失敗背景。

> **10.0 仍是 opt-in**（`ARCH10=1`）；默認路徑 = 9.0.5（`--arch90` 可開，9.0 的 L0–L5 仍在）。三條鏈並存是刻意的：10.0 的新引擎族校準只有 1 個錨點。

---

## 文件狀態與勘誤（2026-10-28 校訂）

本文件在 9.0.5 做了一次完整校訂。**前一版存在以下偏差，全部已改正**：

| # | 前一版的問題 | 實際情況 | 影響 |
|---|---|---|---|
| 1 | **8.3–8.19 共 17 個版本記錄全部缺失** | 這些版本對應真實存在的代碼（`shredder.py`／`style_vector.py`／`mcts_searcher.py`／`zmq_bridge.py`／`ablate_rhythm.py`…）與 8 個校準點 | 讀者無法追溯現有模塊的來歷；「為什麼有這些檔案」無解 |
| 2 | 變更記錄**時序錯亂**（9.0.5 → 9.0 → 7.4 → 7.5 → 8.2 → 8.1 → 8.0 → 7.6 → 7.3…） | 8.x 系列被插在 7.4/7.5 之後，且 8.3–8.19 整段遺失 | 無法按時間重建決策鏈 |
| 3 | 標題寫「Workflow 9.0」但「現行管線」章節停在 **8.13** | 實際交付鏈已是 8.19 + `--arch90`（9.0.5） | 讀者會用錯入口與參數 |
| 4 | 「8.1 三個數字先看」「8.2 退出碼」是**指南章節**，與版本號 8.1／8.2 撞名 | 指南章節已改為 §8A.1／§8A.2 | 檢索「8.1」時混出兩份內容 |
| 5 | 8.17 記錄稱「light 模式砍掉 LRR 與二階 surprisal 熵省時間」 | 實測：LRR 邊際成本 **≈0 ms**（673 詞 0.666s vs 0.667s）；ent2 從未涉及額外前向；真正的槓桿是 **torch 線程數**（4→8 線程：638→333 ms） | 曾據此錯誤地從評分器移除 LRR，使「羅盤」少一軸（8.17.1 已回補） |
| 6 | 校準「點數」與「版本號」混用（如「第 9 點」「第 22 點」與 v9.0 混淆） | 已統一：**點 = 校準集條目**（1–23），**版本 = 軟件里程碑** | 引用時易錯 |
| 7 | 未記錄檢測渠道差異 | turnitai（Submission ID 前綴 `26334`）與 OriginCheck（前綴 `3532`）是**兩個不同的官方 API 帳號池**，同文本實測差 ±3 個百分點 | 誤以為單一真值 |

| 8 | `README.md` 寫「模型後端 `http://127.0.0.1:8080`」 | 實際是 **47615**（`candidates.mjs` 的 `APP_URL`，可用 `HZ_APP_URL` 覆蓋） | 照 README 設定會連不上引擎 |
| 9 | `README.md` 證據表寫「一鍵 8.1/8.2 → 第 18–19 點」「compare-stores → 第 20–21 點」 | 實際：8.1/8.2 = **第 16／17 點**；0.983=第 18、0.782=第 20、0.573=第 21 | 校準引用錯位 |
| 10 | `README.md` 說「polish/test（43 測試）」；WORKFLOW 舊版說「30 項」；9.0 commit 說「71/71」 | 現況 **6 個測試檔、82 個 test()**（`node --test` 為準） | 測試規模說法不一 |
| 11 | 10.0 的真碼錨點（CV 0.465／ai_mk 0.13 → <20%／6%／0 flags）只寫在 `history/08-v10.md` 與 `WORKFLOW-10.0.md`，**未進校準集** | 已補為第 23 點；**送檢碼未記錄**（文件只寫渠道），這是流程缺口 | 最新結論無法被工具引用 |
| 12 | 同時存在 `docs/WORKFLOW.md`（舊 9.0）與 `docs/WORKFLOW-10.0.md` | 本版已把 WORKFLOW.md 升為 10.0 的完整記錄；`WORKFLOW-10.0.md` 定位為**架構規格書**（見 `docs/README.md`） | 兩份「workflow」互相矛盾的風險 |

| 13 | 存在兩份工作副本，狀態不同步 | 倉庫 `E:/download/naturalizer-workflow` 是 10.0 權威；`F:/Humanizer` 是運行時安裝，**停在 9.0.5**（無 `integrate10.mjs`／`l2_fix.py`／`register.py`／routea-routeb 引擎設定） | 在 `F:/Humanizer` 跑 `ARCH10=1` 會直接失敗；請以倉庫為準 |

**仍然存在的已知限制（不美化）**：

- 校準集 23 點中，只有 9 點做過「真實檔案分＋CV」雙重對齊（`mapping/rescored.json`）；其餘為歷史標籤，部分已證明偏低（8.11 金絲雀發現）。
- 膝點區（CV 0.5–0.55 附近、gen 0.76–0.85）只有 2–3 個實測點，插值仍有風險。
- 所有結論僅對「英文學術文體」有效；中文、表格密集、腳註密集的 docx 從未實測。
- Turnitin 會版本漂移；本文件的映射有保質期（金絲雀制度是唯一主動偵測手段）。

---

## 現行管線（10.0）

```text
原稿 docx
  ↓ L0 路由（router.mjs 五狀態 × register.py 四語域特徵，<5 ms）
  ↓ L2 並聯生成（批次調度：先整篇跑完 B×3，再切模型跑 A×2；一次切換約 3 s）
      路徑 α（student，p1≥2.0）：B×3 + A×2
      路徑 β（academic，p1<1.0 且 nom≥3.5 或段均≥120 詞）：B×3 + A×1
      路徑 γ（mixed）：B×2 + A×3
  ↓ 逐段擇優（assembleCrossover：CV 保底 −w3·max(0, 0.42−cv) −w4·max(0, ratio−1.12)）
  ↓ L2.5 確定性修復（順序不可換）
      ① l2_fix.py 語法規則庫（15 條：可數性/主謂一致/單複數/冠詞/量化詞/代詞/冗餘/句首重複）
      ② 確定性縮寫展開（學術區展開；學生區保留）
      ③ LanguageTool 6.8（safe categories，en-GB）
      ④ applyWordBudget（刪除優先，目標 ≤1.12）
  ↓ L3 雙軌驗收
      分數軸：CV ≥0.42 · ai_mk ≤0.20 · 數字/日期/單位 100% · 引用 100% · NLI ≥0.85 · 結構一致
      質量軸：語法硬傷 0 · 段落字數比 ≤1.20 · 全篇 ≤1.12 · 縮寫率 ≤0.20 · 句均詞 14–28
  ↓ L4 帳本＋風險卡（兩軸指標並列）
  ↓ 交付 docx
```

**命令**：`ARCH10=1 node pipeline/v6.mjs draft.docx`（可加 `ARCH10_POOL=routeb,routeb,routea,routea`）；離線整合測試 `node pipeline/integrate10.mjs beta 3`；語域路由 `python pipeline/register.py draft.txt`；單獨修語法 `python pipeline/l2_fix.py fix in.txt out.txt en-GB`。

**10.0 的已知未閉合項**：B 的系統性長度膨脹 1.22–1.36（prompt 指令無效、選擇只能取相對最短→1.204），必須接 `applyWordBudget` 壓回 1.12。

## 現行管線（9.0.5，默認路徑；10.0 未開時）

### 默認鏈（無旗標）

```text
原稿 docx
  → 接單預檢（precheck.mjs：文檔畫像 gen/CV → 文檔族 → 報價與耗時預期）
  → plan（hz planner；標題保護 ≤14 詞；文檔畫像分流：正常 6 候選／中度 4／極端 4）
  → K 候選（/api/completion；數字斗篷 cloakNumbers；第三次冷終試）
      ＋ 逐單元驗證（數字／引用／長度比／句數／重複句）
  → 離線評分（daemon：CoLA 傷率＋tmr＋EditLens＋GPT-2 四特徵；早停帶 gen 閘）
  → 語法手術（受傷句局部重生）→ 段落重組 X → 排名（CV 主導）→ NLI 守門（矛盾／內容損失定向救援）
  → [極端文檔] 機械節奏手術（mechanicalBurstify，零模型）→ 模型 burstify 備援
  → 段級研磨（grind：worst-N × 多輪；句級降級；收斂即停）
  → 查重打磨（stock 句重生）→ 二級品質手術（CoLA 0.7）→ 字數預算（刪除優先）
  → 機械標點 → LT 確定性語法層 → 語域手術（you／縮寫／口語）→ 交付終評
  → docx 回填（保留標題／表格／References／樣式）＋ 風險卡
```

### `--arch90`（9.0 分層架構，推薦）

在默認鏈之上加五層：

```text
L0 路由 router.mjs        五狀態分診：S1 保守／S2 標準／S3 重複論證／S4 退回作者(exit 3)／S5 停改令(exit 4)
L1 診斷 diagnostics.mjs    拋光金句收尾／段首尾模板／連接詞接力／三連列舉／無源量化
L2 骨架 argument_map.mjs   主張-證據-限制抽取 ＋ skeletonSurvived 交付前檢查
L3 否決環 verify_gates.mjs 第一環內容正確性（一票否決）→ 第二環格式（一票否決）→ 第三環品質（只比較）
L4 帳本 ledger.mjs        .ledger.jsonl 逐筆（句級 diff／否決紀錄／回退點／北極星四問）
L5 校準 calib_merge.mjs   族軸掃描：我方族 gen≤0.048 命中 81%／hugo 族 copula≤4.29 命中 88%，兩軸不通用
```

**交付語義（9.0.5 定案）**：交付否決 → 回退至**最低風險的綠點** → **重做確定性修復**（機械／LT／語域／衛生）→ 再驗一次 → 通過則以 `repaired` 入帳本；不通過才標記人工覆核。**回退只撤銷生成式損傷，不撤銷安全修復。**

### 輔助工具（全部 opt-in，不影響默認鏈）

| 工具 | 作用 | 版本 |
|---|---|---|
| `precheck.mjs` | 接單預檢卡（文檔族／耗時／報價／預期分） | 8.10 |
| `assault.mjs` | 極端文檔 best-of-N 編排（CV≥0.5 且 gen≤0.85 達標） | 8.10 |
| `shredder.py` / `shred_batch.py` | CPU 依存句法粉碎（voice／split／merge／reorder，事實守衛） | 8.15 / 8.18 |
| `style_vector.py` | fastText 風格向量（16k 詞流式、SIF、SVD-100） | 8.16 |
| `seed_extractor.py` | 語音種子節奏代理（自我修正／口語連接詞／hedge／碎片率） | 8.16 |
| `prompt_injector.mjs` | 風格 JSON → 「Style guidance」prompt 段 | 8.16 |
| `mcts_searcher.py` | MCTS 搜索（段落級／句級，UCT，NLI 硬閘） | 8.17 / 8.17.1 |
| `zmq_bridge.py` | ROUTER/DEALER 異步評分橋（HWM＋重試） | 8.17 |
| `deterministic_stitcher.py` | RST 過渡詞插入（硬編碼詞表，零 LLM） | 8.17 |
| `rescore_mapping.mjs` | 歷史標籤重對齊（含從 Turnitin PDF 恢復文本） | 8.11 |
| `text_hygiene.py` | 句首大小寫／縮寫／專名降格修復 | 8.19 |
| `ablate_rhythm.py` | 節奏源受控消融 | 8.18 |
| `anchor_gate.mjs` | 課程品質閘（universal FAIL／assignment WARN） | 9.0.3–9.0.4 |
| `probe_ft.mjs` / `probe_xtragpt.mjs` | 引擎能力探測（LoRA 天花板測試） | 9.0 期 |
| `canary/` | 三隻金絲雀＋已知分（每批新碼第一碼必打） | 8.11 |

### 運行時預算（實測）

| 文檔族 | 路徑 | 牆鐘 |
|---|---|---|
| 正常（gen ≤0.4，CV ≥0.5） | 默認鏈 6 候選 | 10–25 分鐘 |
| 中度（gen 0.4–0.65） | 4 候選＋研磨 | 15–30 分鐘 |
| 極端（gen >0.8） | 極速路徑（4 候選＋句級優先＋收斂停） | 12–25 分鐘（實測 12.4 分→0%） |
| `--arch90` | 路由＋否決環＋時間預算（默認 15 分鐘） | 13–30 分鐘（實測 E2 25 分→0%） |
| `--mcts --mcts-generator stub` | 結構搜索（測試用） | 3–5 秒／10 迭代 |
| `--mcts --mcts-generator app` | 12B 搜索 | 分鐘級／迭代（未做大規模實測） |

---

## 項目開發史與瓶頸回顧（2026-10-23 → 10-28）

> 這一節回答「為什麼管線長成這樣」。所有數字都來自 `pipeline/v6-test/calibration.json`、`turnitin/*.pdf` 與各次 run log，不是回憶。

### 第一階段：基礎管線（10-23，2.0 → 6.1）

起點是「hz 改寫一次 → API 修補」的單鏈。五天內迭代出選擇式管線，關鍵認知逐步累積：

| 版本 | 決策 | 依據 |
|---|---|---|
| 2.0 | audit → repair → verify 三輪；最小替換 | 全篇 rewrite 實測 85% |
| 3.0 | hz 重生優先、API fallback；docx 支援 | 修補層 26 項測試 |
| 4.0 | 獨立 quality judge（25 分 rubric） | 避免為同義詞過度改寫 |
| 5.0 | 重生 5 次；25% 硬預算；數字詞等價 | 41% 過度改寫 → 壓到 23% |
| 6.0 | **K 候選 → 離線評分 → 擇優**；EditLens 成為獨立訊號 | 5.1 的 25% 是 polish 造成 |
| 6.1 | 首次 29%（可接受區），成為默認操作點 | 第 12 點 |

**這個階段學到的第一課**：API 潤飾每升一級，Turnitin 升 10–15%。潤飾是反效果。

### 第二階段：離線評分與確定性層（10-24，7.0 → 7.3）

- **7.0**：CoLA 語法眼 + NLI 守門 + 語法手術（局部重生，零 API）+ 文件型別分流（essay／form）
- **7.1–7.2**：機械標點規則；H2 首次 <20%（第 13 點）
- **7.3**：LanguageTool 確定性語法層——**品質與偵測特徵脫鉤**的實證（LT 修語法，p_ai_gen/ppl 不動）
- **7.4**：類型邊界地圖 + **數字斗篷**（digits／word-number chains／ordinals → 佔位符）

第一道牆在這裡出現：**red-zone 議論文**的正式語域段反覆卡住。當時的解讀是「研磨參數沒調對」——這是第一次誤讀（見下文）。

### 第三階段：紅區突破與 E2（10-24，7.5）

- grind.mjs 段級研磨：worst-3 段定向重生，validateUnit + NLI 守門，整份驗收
- E2 從 0.280 → 0.030（**送檢門檻**），CV 0.621（x1.66）
- **E2-grind 送檢 0% AI／13% 查重／0 flags**（第 15 點，碼 F20A277274）
- 同時 R3 報告卡在 0.168——**語域地板在段級重現**，被記為「研磨天花板」而擱置

### 第四階段：一鍵化（10-24 深夜 → 10-25，8.0 → 8.2）

- **8.0**：grind 進主鏈（自動觸發、三閘採用、逐句 CoLA）；webui 對齊
- **8.1**：NLI 定向重生救援 + **早停 gen 閘**（決定性一修）→ 一鍵首發 0%（第 16 點，碼 B398E0B859）
- **8.2**：標題保護、引用年份對齊、嵌套括號拆解、entail 救援、ppl 平手抉選、查重打磨、二級品質手術 → 一鍵 0%／查重 22%→16%（第 17 點，碼 05B0C1E1EB）

**一鍵三連發全 0%** 是這個階段的高點。

### 第五階段：純 AI 文檔攻堅（10-24 晚 → 10-25，8.3 → 8.9）

轉折點是一份真實客戶文檔（`compare-stores`）：**原稿 gen 0.983、CV 0.27**（純 AI、句構均勻）。第一次跑管線直接崩潰（候選全被 CV 帶淘汰）。

| 版本 | 突破 | 實測 |
|---|---|---|
| 8.3 | 低 CV 文檔族 fallback（burstify + 帶外交付，不再崩潰） | 從「報錯」變成「可交付但有警告」 |
| 8.4 | **句級研磨降級**（段落重生碎裂時逐句攻） | 0.983 → 0.649（手術前標籤；真實交付分 0.762，見 8.11 勘誤） |
| 8.5 | **跨渠道驗證**（OriginCheck）＋映射曲線初步 | 0.649 → 8%；0.983 → 98%（8.11 修正為 0.762 → 8%） |
| 8.6 | 品質五閘（口語開頭／第二人稱／非正式標記／碎片／鄰句重複）＋逐句 NLI | 修掉客戶 QA 的三類缺陷 |
| 8.7 | **文檔畫像分流**（plan 期一次評分定檔）＋極速路徑＋收斂停 | 0.983 → 0.573，**12.4 分鐘** |
| 8.8 | **CV 主導交付規則**（九點對齊後）＋語域手術 | 0.573 實測 **0%**（第 21 點） |
| 8.9 | 標題保護 v3＋收斂停以映射為準＋交付終評 | 純 AI → 0% 全自動閉環 |

**關鍵發現（改寫了整個交付規則）**：九個對齊點證明**單特徵 gen 映射是錯的**——

| trueGen | CV | Turnitin |
|---:|---:|---:|
| 0.030 | 0.621 | 0% |
| 0.218 | 0.579 | 3% |
| 0.341 | 0.619 | 3% |
| 0.449 | 0.681 | 1% |
| 0.529 | 0.690 | 0% |
| 0.749 | 0.539 | 0% |
| 0.762 | 0.393 | 8% |
| 0.984 | 0.378 | 41% |
| 0.983 | 0.275 | 98% |

反例：同 gen 0.98 的兩篇，CV 差 0.10 → 實測差 57 個百分點。規則：**CV ≥0.54 全過（與 gen 無關至 0.69）；CV 0.38–0.39 由 gen 決定；CV ≤0.28 必敗。**

### 第六階段：工程化與外部節奏源（10-25 → 10-26，8.10 → 8.18）

| 版本 | 內容 | 結果 |
|---|---|---|
| 8.10 | 接單預檢 `precheck.mjs`＋best-of-N `assault.mjs` | 方差實錘：同文檔七跑 0.573–0.938 |
| 8.11 | 金絲雀制度＋daemon pre-kill＋續跑 | **金絲雀首跑抓出交付標籤過期**（真分 0.218／0.762，非 0.034／0.649） |
| 8.12 | CV 主導規則落地（precheck／assault／交付閘） | 9/9 吻合 |
| 8.13 | **機械節奏手術**（零模型拆分合併，原詞保留） | 品質保持型攻堅；客戶 QA 7 項修 5 |
| 8.14 | 評分器重寫：GPT-2 單前向四特徵（perplexity／mean_surprisal／DivEye entropy2／LRR）＋CV＋PATTR | 一次前向四個特徵 |
| 8.15 | `shredder.py` 依存句法粉碎 | CV 提升的假設被**數學否定**（拆分長句/合併短句都拉向均值）；真實作用是 ppl +35% |
| 8.16 | `style_vector.py`／`seed_extractor.py`／`prompt_injector.mjs` | 風格引導進入 prompt，默認路徑 byte-identical |
| 8.17 | `zmq_bridge.py`／`mcts_searcher.py`／`deterministic_stitcher.py`／`stat_scorer.py` | 269 ms/迭代 |
| 8.17.1 | LRR/ent2 回補（邊際 0 ms）＋句級 MCTS | 線程數才是槓桿（638→333 ms） |
| 8.18 | **節奏源受控消融** | 見下表 |

**節奏源四條件消融（compare-stores 正文，同採樣）**：

| 條件 | tmr gen | CV | ppl | 複合 reward |
|---|---:|---:|---:|---:|
| base（只有 hz 指令） | 0.982 | 0.299 | 13.9 | −0.574 |
| shred（前置粉碎） | 0.986 | 0.326 | 16.2 | −0.510 |
| **guide（風格向量）** | **0.786** | 0.375 | 21.8 | −0.479 |
| shred+guide | 0.972 | **0.399** | 24.1 | **−0.443** |

結論：**只有風格引導真正壓低 tmr（−20%）**；粉碎單獨無效；兩者非可加；複合分改善但未過交付線（CV 0.399 < 0.54）。

### 第七階段：9.0 分層架構與首單（10-27 → 10-28）

**9.0（另一會話完成）**：把「搜索更好的文本」轉向「**否決更壞的文本**」——L0 路由／L1 診斷／L2 骨架／L3 三環否決／L4 帳本／L5 校準合併。

- 9.0.1：畢業考逼出五類評估器誤報並修復（量詞 one／分數詞等價／引用對齊基準／序數詞／數字集合語義）→ 71/71 測試綠
- 9.0.2：週轉保護（帶否決票的候選跳過研磨／時間預算／X 先過否決／回退選最低風險綠候選）
- **畢業考（第 22 點，碼 49C86925C8）**：E2 arch90 全鏈 → **0% AI／22% 查重／0 flags**，牆鐘 25 分鐘
- 9.0.3–9.0.4：課程品質閘（7 份 A 級樣本錨定）；**閘門拆分為 universal FAIL＋assignment WARN**（因為字數是作業參數不是品質參數）
- **9.0.5（本輪）**：首單實戰 + 兩個真實缺陷修復（見下）

### 第八階段：換引擎（10-27 → 10-29，9.0.1 → 10.0）

**動機**：9.0 已經證明「否決更壞的文本」有效，但天花板仍在——12B 生成的句子仍在 LLM 分佈內。9.0 的答案是「攔」，10.0 的答案是「換心臟」：兩條微調線並行。

| 路線 | 訓練數據 | 目標 | 結果 |
|---|---|---|---|
| A：`routea-qwen35-9b` | PELIC 學生作文 3,085 對（714 快照＋2,371 新增） | 學生語域（in-domain dist −0.045） | 可用 |
| B：`routeb-humanizer12b` | NUCLE 2,145 對（2,320 修 356＋anchor 19＋passing 2） | 去 AI 腔（ai_mk 0.76 → 0.16） | 可用 |

**10.0 的四個實驗**（完整流水見 `history/08-v10.md`）：

1. **串聯證偽**：A→B 時 B 對 A 的輸出**幾乎照抄**（編輯距離 0.000/0.068/0.078/0.085），ai_mk 完全沒降；B→A 時 A 只微調（0.15）。→ **改並聯，不串聯**
2. **D1 結構重排器三次失敗**：prompt 配額模型不聽（要 6 句給 8 句）／機械拆併使 CV 反降 40%／並聯擇優上限只到 0.465 → **取消 D1，省下最大工程塊**
3. **真碼驗證（第 23 點）**：`highAI-0983`（原判 98%）→ B/A/B/A 組合（CV 0.465、ai_mk 0.13、811 詞）→ **<20% AI／6% 查重／0 flags**。推翻「必須 CV ≥0.54」的舊族假設；確立新族門檻約 0.42
4. **質量軸審計（第三次誤讀復現）**：分數滿分但逐句讀出 **11 處語法硬傷**（make purchase／Physical store need／less customers／both two…）——全部是 NUCLE 語料特徵（GEC 學習者原文），模型忠實學到了學生微瑕。LT 只覆蓋 4/15，自建 15 條規則全修後 CV 0.472→0.474、ai_mk 不變 → **質量軸可獨立修復，不破壞分數軸**

**8.19/9.0.5 的首單實戰**（10-28）是這條線的前哨：客戶 608 詞論文，默認鏈 gen 0.016／CV 0.654；arch90 全綠交付 gen 0.055／CV 0.598，並修掉「回退丟失確定性修復」的架構缺陷。

### 九個瓶頸與五次誤讀

| # | 瓶頸 | 首次出現 | 狀態 |
|---|---|---|---|
| 1 | 文檔族錯配（管線按 E2 校準） | 10-24（R3 卡 0.168） | 已解（畫像分流 S1–S5） |
| 2 | 取樣方差（同文檔 0.573–0.938） | 10-24 | 已緩解（best-of-N；單次 ≤0.75 命中約五成） |
| 3 | 極端文檔硬崩潰（候選全滅） | 10-24 | 已解（8.3 fallback） |
| 4 | **引擎分佈天花板** | 10-24（被 E2 掩蓋） | **未解**：句級重生仍在 12B 分佈內，句級 gen 0.91–0.98 不動 |
| 5 | 交付標籤失真（手術後不重評） | 10-25 | 已解（8.9 交付終評＋8.11 金絲雀） |
| 6 | 質量退化（原稿 > 改寫版） | 10-25 客戶 QA | 部分解（8.13 機械手術＋9.0 否決環） |
| 7 | 回退粒度太粗（丟失確定性修復） | 10-28 | 已解（9.0.5 回退後重做） |
| 8 | **12B 生成引入新語法錯誤**（不能完全消除） | 全程 | 未解；只能靠候選擇優＋確定性層兜底 |
| 9 | **新引擎族只有 1 個校準錨點**（CV 0.465 → <20%） | 10-29 | 未解；膝點（0.40–0.43）與學生語域（α 路徑）待碼 |

**五次誤讀（比瓶頸本身更貴的教訓）**：

1. **R3 的語域牆被讀成「研磨待調」**（10-24）——應追根因，實際是引擎天花板。
2. **E2 的 0% 掩蓋了質量退化**（10-24）——「實測通過」不等於「交付成熟」。
3. **0.573→0% 被讀成「高 AI 問題關閉」**（10-25）——只關閉了分數軸，質量軸同時打開。
4. **8.17 把 0.4 s 的前向成本誤記到 LRR 頭上**（10-26）——據此刪了「羅盤」的一軸；實測邊際 0 ms，真正槓桿是線程數。
5. **10.0 真碼通過 ≠ 可交付**（10-29）——分數滿分但文本有 11 處語法硬傷。第三次誤讀（「實測通過＝整體成功」）在換引擎後原樣復現；這次靠「質量軸」制度化守住。

**共因**：把單一指標（分數／通過）當成整體成功，沒有同時度量質量軸與成本軸。

### 統一診斷

**管線是節奏放大器，不是節奏創造器。** 分隔一切成敗的變量是「原稿裡有多少真人節奏可以放大」：

- E2（0.232）→ 放大後 0%
- compare-stores（0.983）→ 放大後原地踏步，且質量受損
- 9.0 的答案是換戰場：**不再追求「生成更好的文本」，而是「攔住更壞的文本」**（否決環＋帳本＋回退）

### 能力邊界（誠實版）

| 文檔類 | 能力 | 證據 |
|---|---|---|
| 有真人底子（gen ≤0.4、CV ≥0.5） | 全自動 0–3%，10–25 分鐘 | 5 次實測 |
| 中度（gen 0.4–0.65） | 全自動 3–8% | 2 次實測 |
| 純 AI＋句構可拆 | 全自動 0%（12.4 分鐘） | 第 21 點 |
| **純 AI＋高質量＋句構均勻** | 需多次重跑或人類種子；8.18 消融證明 CV 仍差 0.15 | 第 18–21 點 |
| 9B LoRA 微調引擎 | 探測有效但遠離交付帶（0.987→0.613） | 第 23 點 |
| 中文／表格／腳註密集 docx | 零覆蓋 | — |

### 出路（按投入排序）

1. **引擎升級**：32B 級 GGUF 掛同一接口（管線引擎無關），重跑「語域保持重生」探針
2. **人類種子**：客戶語音 3 分鐘 → `seed_extractor.py` → 節奏錨點（8.16 已建，端到端未驗證）
3. **檢索骨架**：真人學術句法庫＋填充（報告 4 路線，數週級）
4. **新碼標定**：金絲雀第一碼＋膝點（CV 0.50/0.52/0.55）加密三碼

---

## 目錄

**當前狀態**
- [文件狀態與勘誤](#文件狀態與勘誤2026-10-28-校訂) — 前一版有哪些錯、哪些已知限制
- [現行管線（9.0.5）](#現行管線905) — 默認鏈／`--arch90`／輔助工具／運行時預算
- [項目開發史與瓶頸回顧](#項目開發史與瓶頸回顧2026-10-23--10-28) — 七個階段、八個瓶頸、四次誤讀

**操作指南**
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

**附錄**
- [A：變更記錄（2.0 → 9.0.5）](#附錄-a變更記錄20--905)
- [B：校準集索引（23 點）](#附錄-b校準集索引23-點)
- [C：文檔維護規則](#附錄-c文檔維護規則)
- [D：5.0 時代的設計原則](#附錄-d50-時代的設計原則歷史參照)

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

### 8A.1 三個數字先看（報告解讀，非版本號）

- **改動百分比**：一般 2–15%。15–25% 要逐項看是不是在救碎片；25% 是硬停點，超過的修補會被回滾。
- **節奏保留率**：B 的 CV ÷ A 的 CV。低於 80% 代表句子被抹平；80–90% 要覆核，90% 以上通常安全。
- **未解決數**：0–8 項都可能在報告出現；「風格／語意建議」不算失敗，但 critical 必須 0，major 要逐項看。

### 8A.2 退出碼（報告解讀，非版本號）

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

### 12.0 現行紀律（9.0.5，優先於下方舊流程）

1. **先跑 `precheck.mjs`**：拿文檔族、CV/gen 雙特徵預期、耗時與報價檔位。**這一步不燒碼。**
2. **只在離線條件達標時送檢**：CV ≥0.54（全過帶）或（CV 0.38–0.54 且 gen ≤0.76）。不達標就繼續攻堅或轉人工。
3. **每批新碼的第一碼打金絲雀**（`canary/`：0649 → 0983 → oneclick82）。偏離已知分 ±10 個百分點即暫停，先排查渠道漂移，再做任何映射決策。
4. **一碼一提交**：turnitai 與 OriginCheck 都是「首次上傳才激活、每碼一次」；提交前確認檔名、字數（350–30000 詞才有 AI 報告）、語言（僅英/西）。
5. **同一文本跨渠道差 ±3 個百分點**是系統噪聲底，不要當成回歸。
6. **交付前必看風險卡四項**：交付否決（9.0 全綠才交）、CV、傷率、事實/引用差異。
7. **碼用完就停**：無碼期間只做離線迭代（映射重對齊、品質閘、機械層），不猜分數。

### 12.1 舊流程（5.0 時代的 A/B 方法，保留作參照）

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

### 12.2 5.0 時代的實測記錄（2026-10-23）

- 2.0 final：5 段散文只有 4 段和原文不同，第 1 段是原文；Turnitin 59%。這不是修補層造成的，是覆蓋率不足。
- 第一次 5.0 hz：paragraph 4 被拆成 `The 'S' (specific).` 等碎片，修補層要改 41% 才能救，節奏掉到 0.403。
- 第二次 hz（alt1）：paragraph 4 是完整句；自動 B 改動 23.1%、CV 0.446 → 0.414（保留 93%），仍有 10 項 major（多為 meaning/terminology）與 5 項 grammar minor。
- 人工局部校對後：612 字、34 句、CV 0.442；7 個數字與 5 個引用全部保留，無重複句、無 AI 套語、無縮寫；References 未動。
- **Turnitin 實測（2026-10-24）**：`final5.0`（自動 B，hz 腔調保留）**低於 20%**（Turnitin 顯示 `*%`，低於門檻不顯示數字）；`final5.1`（更學術化的改寫）**25%**；`final3.0` 低於 20%；`final2.0` 59%。
- **關鍵發現**：把文字修得愈接近標準學術英文，AI 率反而上升。final5.0 的 hz 不規則句法正是它低於 20% 的原因；final5.1 的 polish 把它拉回 25%。所以正確做法不是「改到完美」，而是**只修客觀錯誤、保留 hz 的句法**。
- 建議流程：以 `final5.0`（低於 20%）為底，只做 detached citation、`For 'S' for…`、`to revise`、`app blocking`、`next evening`、重複 `check/test` 等最小修補；每次只改一組，重新跑 Turnitin 確認仍在 20 以下。不要直接把 final5.0 改成 final5.1 的學術腔。
- 結論：5.0 能修好 hz 的破壞並保住節奏，但**不保證每一版都低於 20%**；AI 率主要由 A 的句法與 polish 的改動量決定。若 B 仍高，先換一份乾淨的 A，或減少 polish，而不是加大改寫。

### 12.3 解決路線：AI-safe 優先，quality-first 另開一條線

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

## 14. 檔案結構（9.0.5）

```text
F:\Humanizer├─ Humanizer.exe              官方 desktop app（12B 引擎，/api/completion）
├─ engine\                    llama-server（cpu / cuda / vulkan）
├─ WORKFLOW.md                本文件
├─ pipeline│  ├─ v6.mjs                  主鏈（默認 8.19 鏈 ＋ --arch90 分層架構）
│  ├─ candidates.mjs          候選生成／驗證／斗篷／排名／重組
│  ├─ grind.mjs               段級研磨＋句級降級＋重複論證重組
│  ├─ detector_client.mjs     daemon 客戶端（ZMQ 之外的熱路徑）
│  ├─ docx_bridge.py          docx 段落抽取／寫回／plan
│  ├─ precheck.mjs            接單預檢卡（8.10）
│  ├─ assault.mjs             極端文檔 best-of-N（8.10）
│  ├─ rescore_mapping.mjs     歷史標籤重對齊（8.11）
│  ├─ shredder.py             依存句法粉碎（8.15）
│  ├─ shred_batch.py          粉碎批處理（8.18）
│  ├─ style_vector.py         fastText 風格向量（8.16）
│  ├─ seed_extractor.py       語音種子節奏代理（8.16）
│  ├─ prompt_injector.mjs     風格 JSON → prompt 段（8.16）
│  ├─ mcts_searcher.py        MCTS 搜索（8.17／8.17.1）
│  ├─ zmq_bridge.py           ROUTER/DEALER 異步橋（8.17）
│  ├─ deterministic_stitcher.py  RST 過渡詞（8.17）
│  ├─ ablate_rhythm.py        節奏源消融（8.18）
│  ├─ text_hygiene.py         句首大小寫／縮寫／專名（8.19）
│  ├─ router.mjs              L0 五狀態路由（9.0）
│  ├─ diagnostics.mjs         L1 診斷（9.0）
│  ├─ argument_map.mjs        L2 論證骨架（9.0）
│  ├─ verify_gates.mjs        L3 三環否決（9.0）
│  ├─ ledger.mjs              L4 版本帳本（9.0）
│  ├─ calib_merge.mjs         L5 校準合併（9.0）
│  ├─ anchor_gate.mjs         課程品質閘（9.0.3–9.0.4）
│  ├─ probe_ft.mjs / probe_xtragpt.mjs  引擎能力探測（9.0 期）
│  ├─ canary\                 金絲雀文檔＋manifest（8.11）
│  ├─ models\                 fastText 向量（681 MB，gitignored）
│  ├─ finetune\               LoRA adapter（209 MB，gitignored）
│  ├─ samples\               示範原稿
│  ├─ v6-test\               校準集、run log、Turnitin 原件、消融結果
│  └─ run-pipeline.cmd        拖放原稿
├─ polish│  ├─ polish.mjs              修補層 CLI（舊鏈）
│  ├─ detector_bridge.py      離線評分（8.14 重寫：四特徵＋CV＋PATTR）
│  ├─ detector_daemon.py      常駐評分進程（JSON-line 協議）
│  ├─ stat_scorer.py          標量 detectability（8.17）
│  ├─ lt_fix.py               LanguageTool 確定性語法層
│  ├─ src\                    text / checks / prompts / llm / pipeline / report
│  ├─ test\                   71 項測試（含 arch90 回歸）
│  ├─ polish.config.json      API 與參數（gitignored）
│  └─ README.md
├─ webui│  ├─ server.mjs              本機 HTTP + NDJSON 進度
│  ├─ public\                 index.html / app.js / styles.css
│  ├─ runs\                   每次執行產物（自動清理）
│  └─ start.cmd
└─ naturalizer\               對外落地頁（Next.js，私有 repo 同步）
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

---

## 附錄 A：變更記錄（2.0 → 9.0.5）

> 按時間倒序。每條含：做了什麼、依據什麼數據、留下什麼限制。

### 10.0（2026-10-29）— 雙引擎並聯＋雙軌驗收；真碼 <20%／6%／0 flags

**架構轉向**：9.0 是「用否決攔住壞文本」，10.0 是「換引擎讓好文本有出生率」——兩條微調線並聯取樣。

**四個實測支撐的決策**：

| 決策 | 實測依據 | 影響 |
|---|---|---|
| **不串聯、改並聯** | A→B 時 B 照抄 A（lev 0.000–0.085）；B→A 時 A 只微調（lev 0.15） | 一次改寫、無累積誤差 |
| **取消 D1 結構重排器** | 三種實作全敗：prompt 配額模型不聽／機械拆併 CV 反降 40%／並聯擇優上限 0.465 | 省下最大工程塊 |
| **CV 門檻 0.54 → 0.42** | 新引擎族 CV 0.465＋ai_mk 0.13 → Turnitin <20% | 舊族尺不適用新族 |
| **雙軌驗收** | 真碼滿分但文本 11 處語法硬傷 | 分數軸通過 ≠ 可交付 |

**L0 四語域特徵**（零模型 <5 ms）：`p1_rate`（第一人稱/百詞）、`cite_num_rate`、`nom_rate`（名詞化詞尾/百詞）、`mean_para_words`。分診（3/3 驗證）：p1≥2.0 → student；p1<1.0 且（nom≥3.5 或段均≥120）→ academic；否則 mixed。

**L2 並聯生成**：路徑 α（student）B×3+A×2／β（academic）B×3+A×1／γ（mixed）B×2+A×3。**顯存鐵律**：禁止逐句切換模型——先整篇跑完 B（8.9 GB）再卸載載入 A（6.5 GB），600 字文稿只切換一次（約 3 秒）。

**B 的長度控制不靠 prompt**（實測 prompt 加字數指令完全無效）：在 `assembleCrossover` 加懲罰項 `−w3·max(0, 0.42−cv) −w4·max(0, ratio−1.12)`，B 膨脹 36% 的段落自動輸給 A 膨脹 5% 的段落。

**L2.5 確定性修復（順序不可換）**：L2 語法規則庫 → 確定性縮寫展開 → LT 6.8 → 字數預算。理由：主謂一致會改詞形、縮寫展開會影響主謂判斷、預算會微調詞數。

**L3 雙軌驗收**：分數軸（CV≥0.42、ai_mk≤0.20、數字/引用 100%、NLI≥0.85、結構一致）＋質量軸（語法硬傷 0、段落比≤1.20、全篇≤1.12、縮寫率≤0.20、句均詞 14–28）。**兩軸都過才交付。**

**真碼驗證（第 23 點，渠道 turnitai 國際版）**：`highAI-0983`（98%）→ B/A/B/A 組合（CV 0.465、ai_mk 0.13、811 詞）→ **<20% AI／6%（Not Cited 4%＋Missing Quotations 2%）／0 flags**（Publications 4%／Internet 2%／Student Papers 0%）。**送檢碼未記錄——流程缺口，已寫入勘誤。**

**質量軸審計（同一次真碼）**：11 處讀者可見硬傷（`make purchase`／`One of the major difference`／`Physical store need`／`less customers`／`both two channels`／`he has purchased`…），全部來自 NUCLE（GEC 學習者原文）語料特徵。`lt_fix.py` 只覆蓋 4/15（僅英式拼寫與 fewer）；自建 15 條規則全修後 **CV 0.472→0.474、句數 39 不變、ai_mk 0.12 不變**。

**未閉合（誠實）**：B 系統性膨脹 1.22–1.36；`lengthConverge`（純選擇）只壓到 1.204，仍高於 1.12 → **必須接 `applyWordBudget` 壓回並複檢 CV**（CV 0.459 有 0.039 餘裕，刪 45 詞約損 0.01–0.02）。

**落地狀態**：`candidates.mjs` ENGINES/generatePool ✓、`assembleCrossover` CV 保底＋長度懲罰 ✓、`l2_fix.py` 15 條 ✓、`register.py` 四特徵 ✓、`qualityAxis` ✓、`v6.mjs ARCH10` 開關 ✓；**`applyWordBudget` 串接與新族膝點標定未完成**。

---

### 9.0.5（2026-10-28）— 首單實戰走 9.0；修「回退丟失確定性修復」

**任務**：客戶 `FINAL WRITTEN ESSAY.docx`（608 詞、11 個引用、4 個小標題、3 條 References、20 個 docx 段落）。

**預檢**：gen 0.168／CV 0.424／ppl 57.4 → 邊界帶（CV 0.37–0.5，由 gen 決定），預期 ~8%。

**A 臂：默認鏈（8.19）** 644 秒／4 候選 → 重組 X（cand{4,4,2,1,2}）→ 選定 gen 0.015 ≤0.10 研磨跳過 → 查重打磨 2 句（ppl 51.4→52.8）→ 二級手術 4 句 → 語域手術 4/6 句 → LT 2 處 → **終評 gen 0.016／ppl 40.2**；事實 33/33、結構 20 段全保留；字數 608 → 753（+24%）。

**B 臂：`--arch90` 首輪（暴露兩個真實缺陷）**

1. **X 被否決環淘汰時 `assembled = null` → TypeError**（日誌行直接讀 `assembled.grammarDamage`）。修：null 守衛。
2. **回退粒度太粗（架構級）**：交付否決（`hedgeLoss`）回退到最佳綠候選時，把 `chosen.paras` 整體換掉，**連同其後的語域手術／LT／機械標點一起丟棄**。該輪交付 gen 0.021／CV 0.453，但殘留 4 個 `you`、4 個縮寫、`garena` 小寫——**分數更好、質量更差**，正是 8.13 客戶 QA 指出的同一類失敗。

**修法（9.0.5）**：回退後**重做**確定性層（機械標點 → LT → you/縮寫語域掃描），再跑一次否決環；通過記為 `repaired` 入帳本，不通過才標記人工。**原則：回退只撤銷生成式損傷，不撤銷安全修復。**

**B 臂：修後重跑（13 分鐘）**

| 指標 | 原稿 | A：默認鏈 | B：arch90 首輪（被否決） | **B：arch90 修後** |
|---|---:|---:|---:|---:|
| 離線 gen | 0.089 | 0.016 | 0.021 | **0.055** |
| CV | 0.424 | 0.561（選定時） | 0.453 | **0.598** |
| ppl | 57.4 | 40.2 | 43.4 | 40.4 |
| 預期 Turnitin | ~8% | ~3% | ~4–6%（CV 0.453） | **~3%** |
| 字數 | 608 | 753 | 554 | **577** |
| 事實 | 33 | 33/33 | — | **33/33** |
| 交付否決 | — | 無此機制 | **未過（hedgeLoss）→ 已回退** | **全綠 ✓** |
| you／縮寫 | — | 0／0 | 4／4（修復被回退丟棄） | **0／0** |

**9.0 真正攔下的**：`hedgeLoss`（候選把限定語氣改沒了）＋`skeleton`（論證骨架受損）。帳本 6 筆可回放。這是 8.x 做不到的——8.x 只能靠人工 QA 發現語氣被軟化。

**注意**：gen 更低不代表更好——首輪 0.021 反而質量更差，因為它丟了修復層。**CV 與交付否決才是判據**，這是 8.12 雙特徵規則在真實交付上的再次驗證。

**殘留**：最後一句 `But you are taking advantage` 由人工改為 `But the advertiser is taking advantage`（語義等價）；`text_hygiene.py` 尚未自動串進 arch90 的 repaired 階段（本輪手動調用 3 段）；字數需按作業上限用 `--max-words` 控管。

---

### 9.0.4（2026-10-28）— 品質閘拆分：universal FAIL vs assignment WARN

**用戶裁定**：CCEN4003 的 rubric 是課程參考，**不是通用標準**（服務接各類學術文章）。

- **universalGate（FAIL）**：只保留文體不變式——口語／第二人稱／縮寫／來源少於 3 個 → exit 2
- **assignmentDefaults（WARN）**：字數／段落數屬**作業參數**，按單覆蓋（7 份 A 級樣本跨度 683–1713 詞）
- **檔位帶（WARN，20% 容差）**：7 樣本 A 級分佈 words 683–1713、sentenceCv 0.262–0.941、comma 48–78/1k、copula 5.3–42.5/1k、firstPerson 0–2.9/1k

**兩個反直覺發現**：① A 級論文可以**低於**我們的 CV 帶下限——**CV 是檢測軸不是品質軸**；② hugo 的 `copula ≤ 6/1k` 門檻第三次被真實 A 級樣本反駁。

---

### 9.0.3（2026-10-28）— 課程品質閘（B+）：A 級錨定語料

來源 `E:\hkuspace\ccen4003`：3 份人類 A 級樣本（essay plan A、iae essay A、research essay A+）＋官方範文＋2 份 rubric（Content 15%／Language 5%／Referencing 10%）。

- 錨定事實：sentenceCv 0.375–0.631（我們的 0.45–0.65 帶落在其中）／comma 68–84/1k（**逗號串接就是人類風格**，壓平逗號才是 AI 訊號）／copula 7.4–25.9/1k
- `anchor_gate.mjs`：三 rubric 維度 → B+ 判定；FAIL = C/D 帶風險，WARN = 低於 A 檔

---

### 9.0.2（2026-10-28）— 週轉保護（商業級）

- 帶否決票的 chosen **跳過研磨**（註定被拒的候選不浪費 20+ 分鐘）
- `--time-budget MIN`（arch90 默認 15 分鐘）：超時跳過研磨／查重打磨（增益層，非正確性層）
- **X 在選擇前先過否決環**（結構污染的重組不再進入交付階段）
- 回退改選**最低風險**綠候選（原為「最後一個」——實測選到 gen 0.966 的廢品）
- 回退成功 = 交付綠點，exit 0；無綠點可回退才 exit 2

---

### 9.0.1（2026-10-27）— 畢業考逼出的五類評估器誤報

首輪畢業考否決環連續拒交付，逐輪逼出並修復：

1. **量詞 one 對稱**（`one-penny-per-ounce` 連字號複合詞也是量詞）
2. **分數詞等價**（half ↔ 50%、quarter ↔ 25%）
3. **引用對齊基準**（evaluateText 兩側各自先過 8.2 `citationConsistency` 再比，合法的 2016→2017 對齊不再誤判）
4. **序數詞**（twenty-first ↔ 21st，7.4 斗篷教訓的評估器側）
5. **數字/引用改集合語義**（同一值出現兩次不是捏造——重組 X 把 Bandy 引用帶進兩段被誤判）

全部有回歸測試，**71/71 綠**。

---

### 9.0（2026-10-27）— 分層架構（--arch90 opt-in）：路由／否決制／版本帳本

**核心立場轉向**：從「搜索更好的文本」改為「**否決更壞的文本**」；確定性否決環是主閘，離線模型分與 NLI 是參考；每次改動可測量可回退；承諾邊界寫死（**不保證任何檢測分數**）。

- **L0 路由**（`router.mjs`）五狀態：S1 論證完整→保守編輯（跳過候選生成）／S2 標準鏈／S3 重複論證→先去重／**S4 純 AI 缺作者分析→退回作者（exit 3）**／**S5 引用無法核實→停改令（exit 4）**
- **L1 診斷**（`diagnostics.mjs`）：拋光金句收尾（v2.1 91% 屍檢教訓）、段首尾模板重複、連接詞接力、三連列舉、無源量化。輸出問題清單，**不輸出目標剖面**
- **L2 骨架**（`argument_map.mjs`）＋S3 重組（`grind.mjs repetitionReorg`）：主張/證據/限制抽取；S3 文檔前置確定性去重（實測：重複論證文檔會被「repeats a sentence」整體殺死，去重後 100% 覆蓋）
- **L3 三環否決**（`verify_gates.mjs`）：第一環內容正確性（數字/引用/限定語/專名/NLI 矛盾/發明事實）一票否決；第二環格式結構一票否決；第三環品質四維（忠實/論證/學術/文體）**只比較不否決**。取代單一加權總分
- **L4 帳本**（`ledger.mjs`）：`.ledger.jsonl` 逐行 append（崩潰可恢復），句級 diff＋否決紀錄＋回退點；北極星四問（改善/改壞/證據/停止點）由 `ledger.report()` 回答
- **L5 校準合併**（`calib_merge.mjs`）：我方 21 點＋hugo 8 點。**族軸掃描：我方族 gen≤0.048 命中 81%、hugo 族 copula≤4.29 命中 88%，兩軸互不通用**——「逐族校準」由推論變量測結論
- 測試 61→64→66→71 項逐步增長；煙霧：S1 保守交付 exit 0／S2 全鏈（否決環真實攔截 `inventedNumbers`）／S3 去重→候選→交付 exit 0／默認路徑零改動

---

### 8.19（2026-10-28）— 首單交付（默認鏈）＋確定性衛生層

**客戶文檔**：`FINAL WRITTEN ESSAY.docx`（608 詞 → 預檢 gen 0.168／CV 0.424）。

**默認鏈實跑（644 秒）**：4 候選全 100% 覆蓋 → 重組 X（cand{4,4,2,1,2}）→ 研磨跳過（0.089 ≤0.10）→ 查重打磨 2 句（ppl 51.4→52.8）→ 二級手術 4 句 → 語域手術 4/6 句 → LT 2 處 → **交付終評 gen 0.016／CV 0.654**；事實 33/33；結構 20 段全保留。

**新增 `text_hygiene.py`（確定性衛生層）**——客戶 QA 反覆指出但管線未覆蓋的三類：

1. 句首小寫（`and the best defence is…` → `And …`）
2. 縮寫（doesn't→does not、it's→it is、he's→he is…共 15 組）
3. 專名被降格（garena→Garena、free fire→Free Fire）

規則保守：References 區塊與 URL/DOI 行永不動；輸出逐條 diff 供人工覆核。本次修 4 段 9 處。

---

### 8.18（2026-10-26）— 外部節奏源端到端：受控四條件消融

**接線**：`--shred`（`shred_batch.py` 一次進程處理全部 plan units）＋既有 `--style-guide`／`--seed`。消融工具 `ablate_rhythm.py` 繞過管線過濾，直接量測生成結果。

| 條件 | tmr gen | CV | ppl | 複合 detectability | reward |
|---|---:|---:|---:|---:|---:|
| 原稿 | 0.983 | 0.303 | — | — | — |
| base（只有 hz 指令） | 0.982 | 0.299 | 13.9 | 0.678 | −0.574 |
| shred | 0.986 | 0.326 | 16.2 | 0.612 | −0.510 |
| **guide（風格向量）** | **0.786** | 0.375 | 21.8 | 0.625 | −0.479 |
| shred+guide | 0.972 | **0.399** | 24.1 | **0.587** | **−0.443** |

**貢獻拆解**：① 風格引導是唯一壓低 tmr 的組件（−20%）；② 粉碎單獨無效（把均勻句法餵給模型，模型又還原）；③ 兩者非可加（guide 的 tmr 優勢被 shred 吃掉，但 CV 最高）；④ **複合分單調改善、tmr 不單調——兩個代理分道揚鑣**；⑤ 仍未跨交付線（CV 0.399 < 0.54，預期 ~35–40%）。

**管線級端到端誠實記錄**：`--shred` 兩臂（baseline／shred，各 2 候選）都因既有過濾規則被擋（`cvRatio < 1.1`：原稿 CV 0.303、改寫後 0.24–0.29；另有 unit 3 反覆「drops number 1」致 coverage 75%），30 分鐘超時前無交付檔。**結論：節奏源在生成層有效，交付層被為 E2 校準的過濾器擋住。**

**側寫**：guide 條件下模型輸出明顯變短（unit1 290 詞 vs base 771 詞），引導中的句長目標抑制了過度生成。

---

### 8.17.1（2026-10-26）— LRR/ent2 回補；句級 MCTS

**推翻了 8.17 的成本判斷**（誠實勘誤）：

| 配置 | 673 詞耗時 |
|---|---:|
| full（LRR＋ent2） | 0.666 s |
| light（僅 ent2） | 0.667 s |
| 4 執行緒 | 638 ms |
| **8 執行緒** | **333 ms** |
| 12 執行緒 | 281 ms |

- **LRR 邊際成本 ≈0 ms**；ent2 從未涉及額外前向（由 surprisal 差分算出）；真正的槓桿是 `torch.set_num_threads`（8.14 為避讓 llama-server 設成 4）
- 修：`DETECT_THREADS` 環變（預設 8）；light 模式**恢復 LRR＋ent2**，只跳過 EditLens/tmr → 實測 **334 ms < 0.4 s**
- **句級 MCTS**（`--mcts-unit sentence`）：目標選擇＝嘗試次數最少→長句優先；App 路徑帶學術語域指令；stub 路徑做語法安全變體（`, which X`→`. This X`／`, but X`→`. However, X`／`, and X`→`. In addition, X`／句首副詞後移）；硬閘＝事實子集＋句級 NLI＋句級 CoLA ≥0.6
- 實測：樹正常生長、閘門生效、每迭代中位 0 ms（memo）／首迭代 3.0 s（冷啟）

---

### 8.17（2026-10-26）— MCTS 離散搜索＋ZMQ 異步橋＋確定性拼接

依《從統計指紋到邏輯連貫》報告落地四件（全部 opt-in）：

1. **`zmq_bridge.py`**：ROUTER（CPU 評分）／DEALER（客戶端）。`SNDHWM/RCVHWM=1000`、超時重試＋指數回退（吸收 ROCm 式延遲尖峰）、`LINGER=0` 防退出卡死。生成仍走 App `/api/completion`
2. **`mcts_searcher.py`**：段落級 MCTS——UCT（c=1.2）→ 最差段落擴展 k=3 → 整份評分 → 反向傳播；**NLI contradict>0.5 硬拒**（不進獎勵）；數字/引用必須存活；獎勵 `-(0.6·detectability + 0.4·penalty)`
3. **`deterministic_stitcher.py`**：spaCy 解析＋四類 RST（Contrast/Cause/Concession/Elaboration）＋硬編碼過渡詞表，只插連接詞、不改詞、不刪句、零 LLM
4. **`stat_scorer.py`**：任務假設的前三步產物（實際是 `detector_bridge.py`），補薄封裝。light 模式使單次評分 ~0.4 s（延遲達標的關鍵）

**驗收**：ZMQ ping/score 往返 ✓；MCTS 10 迭代輸出候選 ✓；stitcher 3 句插 2 過渡詞、內容零損失 ✓；`v6 --mcts` exit 0 ✓；單迭代 **269 ms**（v6 實跑）／121 ms（--zmq）✓

**已知邊界**：stub 生成器只做結構重排（reward 持平 −0.513→−0.503，+0.010）；「token 級前綴樹」降級為**段落級**（App 只給文本不給 logits）；`--zmq` 僅服務 MCTS 評分路徑。

---

### 8.16（2026-10-26）— Syntax-RAG 落地：風格向量＋prompt 注入＋人類種子

依《重塑學術文風》報告落地三件（默認路徑零改動）：

1. **`style_vector.py`**：fastText 靜態嵌入的語料風格向量。`*.vec.zip` 以 zip 成員**流式讀取前 N 行**（默認 16000 詞），不落 4 GB 解壓；`*.bin` 受 1 GiB 常駐上限保護。計算＝**去停用詞後**的 SIF 加權均值（a=1e-3）＋L2；`TruncatedSVD` 降 100 維；輸出節奏統計。實測：**vocab 16000／dim 300／常駐 19.2 MB**，4 秒
2. **`seed_extractor.py`**：Whisper 轉錄 → 節奏代理（句長分佈／碎片率／自我修正／口語連接詞／hedge／填充音／第一人稱頻率）。模擬轉錄實測：self_repair 6.98/100w、connectives 5.81、hedges 2.33、碎片 12.5%
3. **`prompt_injector.mjs`**：「Style guidance: …」條列文本，CLI 或 import

**注入驗證（HTTP 層攔截請求體）**：引導確實進入 prompt、hz 事實約束仍在、以 SEP 結尾；**默認 prompt 完全不含引導（171 字元差）**。

**誠實偏差**：任務指定 `wiki.en.bin`（~3.5 GB）與「不加載 >1 GB 模型」衝突 → 改用 `wiki-news-300d-1M.vec.zip`（681 MB）＋`limit=16000`；風格鄰居詞仍是「主題鄰域」而非抽象文風詞（靜態嵌入本質）。

---

### 8.15（2026-10-26）— Deterministic Distribution Shredder（`shredder.py`）

依《Evading Detection at the Edge》報告：先用 CPU 做非生成式句法擾動，把可預測的 AI 骨架打散，再讓 LLM 在較鬆框架上重寫。

**四操作＋概率門（0.50）**：

| 操作 | 觸發條件 | 要點 |
|---|---|---|
| voice 主動→被動 | VERB 為 ROOT 且同時有 nsubj＋dobj，主/賓子樹無子句 | aux 保留（have→been）、無 aux 按時態/數選 be、VBN 不規則表＋規則推導、**狀態動詞黑名單**（concern/involve/include…） |
| split | >35 詞且（有 cc，或逗號兩側都有定式動詞） | cc 換正式連接詞（but→However、so→As a result）；不產生碎片 |
| merge | 相鄰兩句 <8 詞且共享主語 lemma | 分號連接＋第二句首字母小寫；專名開頭放棄 |
| reorder | 句長 ≥10 詞 | 句首單詞狀語→主語後括號式；句尾 PP→句首 |

**安全網**：每句最多一操作；哈希種子（同輸入同輸出）；數字與引用逐字存活否則整段回退；被動化後檢查殘留限定詞與連續標點；References 與標題永不擾動。

**驗收**：E2 518 詞 **0.08 s**；事實 30/30 零損失；轉換語法正確。

**兩個誠實發現**：① **CV 不會因此上升**（E2 0.395→0.380、AI 樣本 0.333→0.323）——拆分高於均值的長句、合併低於均值的短句，兩者都把分佈拉向均值，sd 只會下降；報告「重構自然帶來更大句長變異」的推論在統計上不成立。② 真實作用是**提高困惑度**（AI 樣本 ppl 21.5→29.0，+35%），但單獨不足以降綜合分。

---

### 8.14（2026-10-26）— 評分模塊重寫：GPT-2 單前向四特徵

依《Engineering a Zero-Shot CPU Daemon》：舊 `perplexity()` 跑了完整前向卻只取聚合 loss，**token 級 surprisal 序列被丟棄**。

**改動（只動 `detector_bridge.py`）**：

| 特徵 | 來源 | 實測價值 |
|---|---|---|
| perplexity（向後兼容） | 同前 | 既有 |
| mean_surprisal | 同一次前向 | = log(perplexity) |
| **surprisal_entropy2** | DivEye 二階差分熵（bins=20） | 分離正確 |
| **lrr** | DetectLLM log-rank（logit 比較向量化，無 argsort） | **無鑑別力**（10.824 vs 10.823），如實不給權重 |
| **burstiness_cv** | 正則分句 | 九點校準最強預測因子 |
| **pattr** | 懲罰修正 TTR（target 400／alpha 0.01） | 詞彙多樣性 |
| **ai_risk_score** | 0.55×cv_risk＋0.45×p_ai_gen | 臨時混合 |

**守門**：`gram_list`／`nli_list` 簽名不動；`detector_daemon.py` 零改動；`p_ai_gen`／`p_ai_edit` 語義不動；新欄位純增量。加 `torch.set_num_threads` 封頂（同機有 12B）。

**驗證**：canary 雙樣本（label 98%/8%）risk 0.913 vs 0.722；daemon 端到端四協議全通（首跑 14.3 s 含加載，熱跑 1.2 s）。

---

### 8.13（2026-10-26）— 質量保持型攻堅：機械節奏手術

**客戶 QA 第三輪判詞**：質量排序 `original > assault-final > assault-gen0649 > final`——局部閘全過、全局退化，根因是**用模型重生做結構重造**。

**修法**：

1. **`mechanicalBurstify`（零模型 CV 手術）**：確定性句子拆分（≥24 詞在最後 `, and/but/so/yet` 邊界切開，連接詞轉正式副詞）＋短句合併（相鄰 ≤7 詞以分號連接）。原句原詞全保留，**新語法錯誤在構造上不可能**
2. **機械優先、模型備援**：mechanicalBurstify → CV 仍 <0.5 才模型 burstify → **質量保持閘**（CV ≥0.5 且 gen ≤0.85 → 免研磨；數據：0.749/0.539→0%、0.762/0.393→8%）
3. **`mechanicalPolish` 三規則**：引用主語斷句（`…(2023). Analysed…`→`…(2023) analysed…`）、`).,` artifact、hz 自造段落標題剝離（`Conclusion To sum up`→`To sum up`）

**QA 複檢**：7 項修 5（標題✓、Li et al. 重複引用 2→1✓、comparison stub✓、These cost✓、So/Oh 開頭→0✓、Conclusion 黏連✓）；殘餘 3 小缺陷（you 殘 2、citation-split 殘 1、拼接點缺句號），根因定位為「語域手術在 polish 後產生新文本」。

**工程教訓**：Python heredoc 寫正則時 `\b` 會被寫成控制字符 0x08（bash 轉義吃層），正則修補一律走文件式修補器。

---

### 8.12（2026-10-26）— CV 主導交付規則確立

**九點對齊映射**（`rescore_mapping.mjs`，含從 Turnitin 報告 PDF 恢復已丟失檔案的文本）：0.030/CV0.621→0%、0.218/0.579→3%、0.341/0.619→3%、0.449/0.681→1%、0.529/0.690→0%、0.749/0.539→0%、0.762/0.393→8%、0.984/0.378→41%、0.983/0.275→98%。

**9/9 吻合雙特徵規則**：CV ≥0.54 全過（與 gen 無關至 0.69）；CV 0.38–0.39 看 gen（0.76 過／0.98 敗）；CV ≤0.28 敗。

**架構含義**：極端文檔交付判據從 gen 改為 **CV ≥0.5**——burstify（結構重造）升為主攻，研磨降 gen 為輔。precheck 分類、assault 達標、帶外交付警告全部改 CV 規則。**單特徵 gen 映射正式廢棄**（0.529→0% vs 0.749→0% 非單調；同 gen 0.98 因 CV 差 0.10 而差 57 個百分點）。

**誠實現狀**：compare-stores 單跑實測——爛種子上 burstify 有天花板（CV 卡 0.329，36 分鐘），管線正確拒絕虛假交付。

---

### 8.11（2026-10-25 深夜）— 金絲雀制度；首跑即抓出交付標籤過期

**Qwen 六條建議判決**：採納 5（金絲雀，但修正其盲區——本地評分器是靜態的，偵測不了 Turnitin 漂移，只能偵測自身漂移；真 Turnitin 金絲雀＝每批新碼第一碼）／6（耐跑）；建議 3 轉數據管道；建議 4 列路線圖；建議 1 的 spread 分級被 run84 反駁（n=3 被離群值支配）；建議 2 的「四跑皆樣本」誤讀（無標籤跑分不能進概率模型）。

**金絲雀首跑立功**：三隻（0.983 精確復現 Δ0.000，證明評分器確定性）抓出**交付標籤過期**——8.9 前手術步驟改文本但 `chosenScore` 不重評，0.034/0.649 實為手術前分數，真實分 **0.218／0.762**。膝點隨之右移至 0.76–0.85。

**落地**：`killStaleDaemons()`（防 os error 1455）／assault 續跑（`.assault-N` 復用）／金絲雀 manifest＋`precheck --canary` 自漂移檢查／**交付終評**（LT 後重評，標籤永不再過期）／攻堅閾值 0.65→0.75。

---

### 8.10（2026-10-25）— 接單預檢＋best-of-N 攻堅；方差實錘

- **`precheck.mjs`**：離線 ~1 分鐘 → 文檔族分類（正常/中度/攻堅/極端）＋現狀 Turnitin 預期＋管線路徑＋耗時＋報價建議。修復：**References 必須剔除**（全文計分把 0.573 讀成 0.849）
- **`assault.mjs`**：hz 取樣方差實錘——同一份 0.983 文檔七跑：0.573／0.649／0.691／0.723／0.798／0.914／0.938，單次 ≤0.65 命中率 ~40–50%。編排跑 N 次按交付 gen 擇優，達標即停；未達標 exit 2 轉人工

**誠實邊界**：方差無法消除（12B 取樣特性），best-of-N 是統計緩解（N=3 ≈75–87%，N=5 ≈95%）。

---

### 8.9（2026-10-25）— 語域手術；純 AI 文檔 12.4 分鐘 → 0%

- **語域手術（5.8 步，LT 後掃最終文本）**：you／縮寫／口語填充的整篇掃描，冒犯句從原稿對應句以學術語域指令重生，styleGuard＋逐句 NLI＋整體帶內驗收。修復 `completeUnit` 未導入 bug 後 **you=0、縮寫=0**
- **標題保護 v3**：短標題閾 9→14 詞（12 詞純標題漏網實錘）
- **收斂停以映射為準**：極端文檔 weakBar 0.005／minRounds 10（0.782 停=41% 失敗的教訓）
- **定音實測（第 21 點，碼 XU1M-PM9Z-TMFS）**：客戶純 AI 樣本（0.983/98%）→ 全自動 **12.4 分鐘** → 0.573 → **Turnitin 0%**；you=0、標題乾淨、傷率 0.024
- **位置教訓**：手術必須掃 LT 後的**真終文本**（中間態文本與交付文本不同）；此前語域手術在手術前跑，導致 regen 產物繞過確定性修復層

---

### 8.8（2026-10-25）— 二級品質手術；CV 規則與崩潰修復

- **二級品質手術（5.7 步）**：CoLA 0.5 放行但 0.7 不過的彆扭句（`massive amount of free sugars` 類）從原句重生、逐段 NLI 守門
- **極端文檔收斂放寬**：roundsExtreme 8→15、worst 4、連續兩輪無改善才停（0.611→0.106、0.385→0.134、0.621→0.220 三輪實測）
- **`cvRatio` 過濾器暴露**：原稿 CV 0.303 的文檔，改寫後 0.24–0.29 恆被 `cvRatio ≥1.1` 擋——這是為 E2 校準的規則在扁平文檔族上失效（8.18 再次撞到，仍未完全解決）
- 二級手術加**整體帶內檢查**：發現它曾把離線分從 0.573 推高到 0.849（真系統那輪原諒了，儀器漂移不可接受）

---

### 8.7（2026-10-25）— 文檔畫像分流＋極速路徑；12.4 分鐘

- **plan 期一次 daemon 評分定檔**：正常 6 候選／中度 4／極端 4（極端：句級優先研磨 15 輪、收斂即停）
- 極端路徑段落重生**只試 1 次**（實測必然碎裂，省 ~10 分鐘/輪）
- **收斂停**：連續兩輪總增益 <0.02 即停（收益遞減偵測）
- 實測：0.983 → 0.573，**746 秒**（瘦身前同類需 50+ 分鐘）
- 教訓：`minRounds` 太急會誤停（run4 在 649 秒停在 0.984 的爛種子）；方差與種子質量耦合

---

### 8.6（2026-10-25）— 句級研磨五道品質閘

客戶 QA 第二輪（當時標為 0.649 的交付文本；後證實真實分 0.762。問題：口語化／碎片／you／重複／原意偏移）全部轉為管線層：

| 操作 | 閘門 |
|---|---|
| 句級重生 | **styleGuard**：口語開頭（So/Oh/Well/Maybe）／第二人稱（原句無 you 則禁止）／非正式標記（E.g./etc./I guess）／修辭問句／碎片（<4 詞或無終止標點）／鄰句重複（token 重疊 ≥75%） |
| 逐句 NLI | 改寫句對映**原稿對應句**（非整段）做蘊含檢查——整段比對會被 20 句稀釋，漏掉原意漂移 |
| 標題保護 v2 | 首段 ≤45 詞含問號＝標題＋作業問句，整段不改寫 |

**教訓**：句級重生用孤立句子跑 hz，丟失段落語境（口語化、碎片就是這麼來的）；必須用學術語域指令＋逐句閘補回。

---

### 8.5（2026-10-25）— 跨渠道驗證與映射曲線

- 新渠道 OriginCheck（`origincheckai.com`，自稱對接 Turnitin 官方 API，Submission ID 前綴 `3532`，與 turnitai 的 `26334` 不同帳號池）
- **渠道驗證**：以已知真值樣本 E2-oneclick82（turnitai 0%、離線 0.034）→ OriginCheck **3%**，同系統噪聲範圍 → 可信
- 映射初步：0.983→98%、0.649→8%（後修正為 0.762→8%）、0.573→0%
- **結論反轉**：離線 tmr 在 0.3–0.7 區間**高估** AI 味——Turnitin 對結構重造＋句級混合節奏的文本遠比 tmr 寬容（與「CV 是最強預測因子」一致）

---

### 8.4（2026-10-25）— 高 AI 攻堅：句級降級研磨

**問題**：純 AI 文檔（0.983、CV 0.27）全線失效——6 候選 0.94–0.98、段落研磨 12 次全碎（28 句段落高溫重生 → 12/28 語法碎裂）。

**三項突破**：

1. **句級降級研磨**（`sentenceModeRegen`）：段落重生碎裂時自動降級為逐句攻堅——段內 tmr 最高 5 句逐句重生（temp 0.9），接受條件＝句級 tmr 降 ≥0.02＋CoLA ≥0.75＋validateUnit；整段完成後對原稿段 NLI 複檢，矛盾即回退。**這是核心突破**：段落粒度下「必然碎裂」的文本，句粒度下每輪都有單調增益（單句最大 0.97→0.65）
2. **burstify v2**：句長對比指令（3-6 短句／10-15 中句／25-35 長句）＋逐段 CV 目標 0.45＋CoLA 閘
3. **自動升級**：gen >0.8 研磨輪數 5→8

**實測軌跡**：0.983 →（6 候選＋結構重造＋8 輪研磨＋92 次嘗試 13 個句級改善）→ **0.649**（手術前標籤；交付檔真實分 0.762），傷率 0.023 帶內。段級：p3 0.98→0.53、p5 0.94→0.82、p2 0.98→0.98（頑固）。

---

### 8.3（2026-10-25）— 低 CV 文檔族 fallback：不再崩潰

**事件**：首份真實客戶文檔（gen 0.983、CV 0.27）跑管線**直接報錯**——6 候選 CV 0.29–0.36 全低於校準帶下限 0.45，`沒有候選通過硬過濾`。

**修法（兩段）**：

1. **burstiness 重造**：對被 CV 帶淘汰的候選（按 gen 排序取前 2）做「句長對比」指令重生，驗收＝CV 升 ≥10%＋validateUnit＋NLI
2. **帶外交付**：重造後仍無 eligible → 選「CV/分數最佳」候選交付，風險卡打 ⚠ 帶外警告（不再死給你看）

**同輪抓到的 bug**：fallback 選定後流程仍繼續跑重組／選擇迴圈（`chosen` 已設定但代碼未跳過）→ 二次崩潰 `所有 eligible 候選都被 NLI 擋下`；修：整段包進 `if (!chosen)`。

**教訓**：管線的硬過濾是為 E2 族校準的；新文檔族進來時，「報錯」不是保護而是故障。

---

### 8.2（2026-10-25 凌晨）— 客戶 QA 清單落地＋查重打磨；一鍵三連發全 0%

**背景**：客戶以 E2-oneclick81 對照 E2-grind 提出 7 項品質 QA（標題黏連、論點弱、引用年份錯、嵌套括號、文法小錯、語氣武斷、內容損失）。

**落地 6 項（可自動化的）**：

1. **標題保護**（plan 層）：≤9 詞、無句末標點、無引用 → 不改寫（hz 會把標題重寫成「標題＋自創論點」黏連行）
2. **引用年份一致性**：內文 (Author, Year) 與 References 交叉比對；References 為準，唯一候選年自動對齊（實測 Colchero 2016→2017），多義年供人工。零 AI 訊號
3. **嵌套括號**（mechanicalPolish）：`(for the benefit … (Bandy et al., 2020)).` → 拆外層、引用移句尾
4. **內容損失救援**：NLI 的 entail 首次參與決策——pair entail <0.6 標記「內容損失」，rescue 擴展為雙模式（矛盾/內容損失）
5. **選擇器 ppl 平手抉選**：risk 差 ≤0.02 內選 ppl 較高者（離線查重代理）
6. **查重打磨（5.6 步）**：逐句 GPT-2 ppl，重生最 stock 的 3 句，接受＝新句 ppl 嚴格更高＋CoLA＋NLI；整份驗收＝留在送檢帶，出帶即回退
7. **二級品質手術（5.7 步）**：CoLA 0.7 門檻、最多 4 句、從原句重生、逐段 NLI 守門回退

**送檢（第 17 點，碼 05B0C1E1EB）**：**0% AI／查重 16%／0 flags**（664 詞）。一鍵三連發全 0%（81 版 0%/22%、82 版 0%/16%、手動版 0%/13%）；**查重 22%→16%，低於 20% 理想線**。

**殘餘**：hz 在結論段自造「Conclusion In summary」黏連（plan 層保護管不到重寫輸出，需機械規則）；「There are many factors.」碎片仍在 CoLA 0.7 之下。

---

### 8.1（2026-10-25）— NLI 定向重生救援 ＋ 早停 gen 閘；一鍵紅區首發 0% AI

**8.1 主項**：`rescueContradictions`——NLI 拒收的候選不再整體跳過，只對矛盾段（contradict >0.5）定向重生（validateUnit＋逐句 CoLA＋NLI 三閘），全候選複驗通過即採用。

**實測逼出的四個鏈路級修正**：

1. **早停 gen 閘（最重要）**：`shouldStopEarly` 原本只看 CV/傷率——與 gen 無關。六輪一鍵實測中「3 個節奏合格但統計極差（0.5–0.8）的候選」反覆觸發早停，星級（0.028/0.032）總在第 3–4 位之後被跳過。修：候選生成時即時評分，早停條件加 `gen ≤0.10`。**修完首發即中**
2. **damage 原始刻度**：min-max 歸一化把 0.040 傷率的星級（gen 0.029）對著 0.045 離群值打成滿格懲罰。改 `dmg/maxGrammarDamage` 有界刻度
3. **cold final retry**：unit 重試最後一次用 temp 0.7/topP 0.9——針對引言段「長度暴走」（ratio 30–36）殺 coverage 的失效模式
4. 研磨溫度梯 3→4 檔、輪數 3→5、grind no-op 動作

**九輪一鍵迭代**：run1 回退閘正確觸發（研磨後傷率 0.172 超限）→ run2 no-op＋早停 → run3 **0.611→0.106** → run4 全滅暴露早停問題 → run5 0.385→0.134 → run6 0.621→0.220（星級 cand3 0.032 被 damage 歸一化埋沒）→ run7/8 被藍屏打斷／取樣極差輪 → **run9：cand3 gen 0.020、CV 0.477 帶內、術後傷率 0.000、NLI 0.001，19 分鐘交付**。

**送檢（第 16 點，碼 B398E0B859）**：**0% AI／查重 22%／0 flags**（569 詞）。**全國首個完全自動化（無手動研磨、無手動選稿）的 0%。**

---

### 8.0（2026-10-24 深夜）— grind 進主鏈 ＋ webui 對齊；一鍵紅區全鏈打通

**架構**：grind.mjs 重構為函式庫（`grindParas`）＋CLI 外殼保留；v6 新增 **5.5/7 段級研磨**步：essay 選定後、預算/機械/LT 之前；gen ≤ `genGate`（預設 0.10）跳過；否則研磨 worst-3 段，**採用三閘**（整份 gen 不升、傷率 ≤0.08、有段改善）；form 模式一律跳過；`--no-grind` 可停用。

**8.0.1（三次一鍵實測逼出的三修正）**：

1. **grind 逐句 CoLA 閘**：首跑研磨救活 3 段但引入傷率 0.172 → 整體回退把好段一起丟。修：重生成逐句過 CoLA，爛句閘內拒收
2. **選擇器 min-max 刀鋒修正**：cand1 gen 0.028 因歸一化把 3% 帶外距離放大成滿格懲罰（risk 0.603 全場最差）被埋沒。改原始有界刻度；權重 burst 0.55→0.3、gen 0.05→0.25
3. grind no-op 動作（0 段改善不再標「採用」）

**三次一鍵紅區實測**：run1 回退閘正確 → run2 no-op → **run3：grind 0.611→0.106、傷率 0.000、NLI 拒矛盾候選 0.689、LT 0 處**。0.106 距送檢線 0.006，按紀律不送檢。

**webui 對齊**：版本徽章、進度加「研磨與修整」、字數上/下限欄位（7.6 直通）、修好修訂稿 docx 下載錯位（`--final-name original.final`）。

---

### 7.6（2026-10-24 傍晚）— Word Budget：字數上限層（刪除優先）

**動機**：壓縮＝摘要＝LM 最擅長的平滑化，正好撞檢測機制。原則：**寧可刪，不要改寫**。

- **配置**：`wordBudget`（enabled/maxWords/floorWords/maxCutRatio=0.3）；CLI `--max-words`／`--floor-words`／`--force-budget`
- **計數**：References／Works Cited／Bibliography 區塊不計；中英各用 lang-aware 計數
- **刪除優先**：kept 段（未改寫段）先刪——那裡零改寫訊號；句子級篩選：首末句不刪、含數字/引用句不刪、<6 詞短句不刪、每段留 40% 地板
- **定向壓縮（備援）**：刪除後仍超標，只對超配額 15% 的目標段跑 hz 壓縮，最多 3 次：validateUnit＋NLI 全數適用；**kept 段永不重寫**
- **保險**：削幅 >30% 報錯（`--force-budget` 覆蓋）；低於 floorWords 報錯；風險卡新增「字數預算」節＋CV 警告
- **位置**：選擇＋NLI 之後、機械標點/LT 之前（後兩者不改詞數）

**端到端實測（procrastination 615 正文詞，上限 500）**：688 → 476 詞（獨立複核 496），刪 8 句 −212 詞、定向壓縮 0 段、削幅 27%——刪除優先一路達標；事實（1971/1997/2010/2013/7/70%/9）與引用全存活。

---

### 7.5（2026-10-24 下午）— grind 段級研磨原型打通；E2 達送檢帶

**E2-final2（config 修復驗證）**：`minGrammarDamage` 0.05→0 後，E2 六候選首次走完（此前三個 100% 覆蓋好候選全被舊地板淘汰）。選定**重組 X**（逐段取自 cand{5,4,5,5,1,1}）：gen 0.175／CV 0.567／零傷／NLI 0.001。

**grind.mjs 修復後首跑**（此前因 `splitSentences` 匯入錯誤從未成功啟動）：

- 修：匯入 bug、寫暫存檔死碼、<20 詞段落（標題）佔最差三名額、**daemon 洩漏**（Windows 子進程活得比父進程久，每跑一次漏一隻 ~7.5 GB commit 的 python；兩次就把分頁檔撐爆，os error 1455）
- 加：**NLI 矛盾守門**；增益門檻參數（0.02）；三段溫度梯
- **量測尺度教訓**：逐段 tmr 全在 0.82–0.98（短文本單獨過 tmr 嚴重膨脹），整份 0.17–0.28。研磨內部逐段分數只做相對比較；驗收一律回整份尺度

**R3 研磨**（0.280 起步）：0.280 → 0.171（3 輪）→ 0.168（續磨）；CV 0.469→0.508 帶內。p2（正式語域開頭段）11 次嘗試卡 0.98——**語域地板在段級重現**。

**E2 研磨**：**整份 gen 0.030——達 ≤0.10 送檢門檻**。逐段 p2 0.98→0.05、p6 0.96→0.13、p4→0.66、p3→0.74；edit 0.146 不變；CV 0.621；數字與四組引用全保留。

**送檢（第 15 點，碼 F20A277274）**：**0% AI／13% 查重／0 flags**。全校準集首個 0%，紅區文類首次完全通過。

---

### 7.4（2026-10-24）— 類型邊界地圖 + 數字斗篷

- **類型邊界**：個人敘事（第一人稱）＝綠區（gen 0.03–0.05 可達）；正式第三人稱（argumentative/report）＝紅區；數據密度＝第二道牆（由斗篷解決）
- **數字斗篷（`cloakNumbers`）**：digits＋word-number chains＋ordinals → `ZXQnK` 佔位符；hz 在佔位符周圍改寫；交付前逐字還原；殘留 ZXQ＝驗證拒絕
- 修：`twenty-first century` 被 hz 寫成 `21st century`（正當詞數等價，不是發明）；`twenty percent` 被丟——擴充 `_W` 詞表＋chains
- 教訓：斗篷只鎖事實本身，句法自由——這正是「查重與 AI 防禦可同時做」的機制基礎

### 7.5 待辦（依證據排序，2026-10-24 版，保留作歷史）

1. ~~E2 研磨版送 Turnitin~~ ✅ 0%
2. R3 紅區續磨：p2 類正式語域段嘗試拆句研磨或換 A（0.168 已是研磨天花板跡象）
3. form label 分離改寫（label 前綴剝離、只送內容、回填）
4. webui 對齊 7.x ✅（8.0 完成）
5. H1 polish 崩潰根因（--polish 模式，暫態 GLM 疑似）
6. 長會話注意：llama-server commit 膨脹（實測 20.8 GB），長跑後重啟 App
7. turnitai 提交流程全自動化 ✅（8.x 完成；每碼 1 次）

---

### 7.3（2026-10-24）— LT 確定性語法層：品質與偵測特徵脫鉤

- LanguageTool 6.8＋portable JRE 17；安全類別（TYPOS/GRAMMAR/PUNCTUATION/CASING/CONFUSED_WORDS/TYPOGRAPHY）
- 引用括號＋專有名詞＋References 保護；en-GB
- 實測：修語法後 p_ai_gen/ppl 不動——**品質與檢測特徵可脫鉤**的關鍵證據
- 坑：per-paragraph 各起一個 LanguageTool 實例 → 端口耗盡；改單一 server 重用
- 坑：LT 改壞引用（Baumrind→Baum rind、Baumeister→Paymaster）；正則加 `_CITE_PAREN` 保護＋專名 skip

### 7.2（2026-10-24）— H2 實測 <20%，ideal 假設成立

- H2（第一人稱敘事）實測 1% → 首次 <20%
- ideal 模式假設成立：殘餘語法粗糙是保護訊號（5.0 傷率 0.086、3.0 傷率 0.245 均 <20%）

### 7.1（2026-10-24）

- 機械標點層（引用句點位置、引號統一）
- H4（生產鏈＋LT）實測 3%：**零語法傷也能 <20%**（保護來自節奏不是傷率）

### 7.0（2026-10-24）

- **CoLA 語法眼＋NLI 守門**：受傷句（P(gram)<0.5）與乾淨句（0.9+）乾淨分離
- **語法手術（`surgicalRepair`）**：受傷句用 hz 對「原稿對應句」局部重生成（本機、零 API、零 AI-edit 訊號），每句最多 3 次、每候選 8 處
- **排名重構**：burst（CV 帶距離）0.55＋damage 0.3 主導；tmr/EditLens/ppl 降為 tie-breaker
- **文件型別分流**（`detectDocType`，模板 label 率 ≥0.15 判 form）：form → V2 配方（hz 後幾乎不動，A 直接交付）
- 風險卡新增：傷率（術前/術後）、手術數、NLI 矛盾

### 6.1（2026-10-24）

- 首次 29%，用戶裁定可交付（<30 可接受、<20 理想），成為默認操作點
- 最佳品質（零語法傷、學術乾淨）落在可接受區

### 6.0（2026-10-24）

- **選擇式管線**：單一 A＋重修補 → K 候選 → 離線評分 → 擇優 → 最小修補
- **離線評分器**（`polish/detector_bridge.py`，全 CPU）：GPT-2 ppl＋tmr（RAID）＋EditLens
- **候選生成**：直呼 App `/api/completion`，prompt 與 hz byte-exact（指紋 `cc51d66b4c593fbe` 校驗）
- **首跑**：4 候選中 2 個碎片型被硬過濾淘汰；gen 0.025（原稿 0.559，降 96%）；B 的 EditLens delta +0.001
- **人工修補鐵律**：只修語法、不還原原稿措辭——實測 13 處「還原 draft 用語」把 gen 從 0.047 拉回 0.420
- **Turnitin 實測 56% 的失敗案例（第 6 點）**：選擇器以「碎片」為由淘汰了兩個高節奏候選（CV 0.591/0.495），選出最平滑的 cand4（CV 0.387，比原稿 0.393 還平滑）
- **6.0.1 修正**：新增 cv/cvRatio；硬規則「候選 CV 不得低於原稿 1.1 倍」；排名以 CV 帶為主
- 評分請用純正文（References 是超低困惑度文本，混入污染分數）

### 5.0（2026-10-23）

- hz 重生 2→5 次；5 次不過才交 API
- Rewrite 預設 Gemini Flash（`gemini-native`），judge 保持 DeepSeek；地區擋/503 自動 fallback
- **Gemini 實測修正**：`2.5-flash` 對新用戶下架；3.7/3.8 常 503；改 `3.6-flash`＋`thinkingBudget: 0`，重試 4 次
- **Strong mode**：API rewrite 最多 3 次帶失敗原因；critical/major 核心維度（meaning/facts≥4、academic≥3、total≥16）通過就強制套用
- **多句語法修復**：grammar/fact/citation 碎片可跨兩句合併或拆分
- **數字詞等價**：three＝3、six＝6；引用內年份不算獨立事實
- **近似重複句**：token containment ≥0.8 會擋
- **只自動修客觀缺陷**：meaning/terminology/cohesion 列人工
- **25% 硬預算**：A→B 累計差異超限回滾並停止；實測把 41% 過度改寫壓到 23%，節奏保留 93%
- **覆蓋率檢查**：pipeline 顯示 `hz 改寫 N 段`；2.0 final 的 59% 案例是 5 段只改 4 段
- 30 項測試

### 4.0（2026-10-23）

- API rewrite 注入 `academic-humanizer` skill 合約（最小改動、來源忠實、保留引用數字、學術語域）
- 獨立 **quality judge**（25 分 rubric）；通過才套用，失敗帶 feedback 重試一次
- Patch-first：minor 只准 patch；rewrite 只限 major/critical 或結構問題，一次一句
- hz 重生 → API 改寫 → judge → 重審
- 27 項測試

### 3.0（2026-10-23）

- 監督輪改為 **hz 重生優先**（2 次）→ API fallback → 重審；加入整輪回滾與 hz/API 統計
- 移除預設「回退到原稿」；改寫失敗保留 A 並列人工
- 新增 docx 支援（hz docx 模式＋python-docx 橋接）與三稿對照報告
- 新增本機網頁 UI、版本徽章、差異標示、A/B/docx 下載
- 修補層 26 項測試

### 2.0（2026-10-23 早）

- audit → repair → verify 與最小替換的硬性校驗；API（DeepSeek）優先
- 全篇 rewrite 實測 85%——這是「禁止全篇改寫」的起點

---

## 附錄 B：校準集索引（23 點）

> 前 22 點來自 `pipeline/v6-test/calibration.json`（舊引擎族）；第 23 點是 **10.0 新引擎族的第一個錨點**，於 2026-10-29 由真碼驗證得出（記錄在 `history/08-v10.md`，本版補入此表；**送檢碼未記錄**）。

| # | 名稱 | gen | CV | Turnitin | 渠道 |
|---:|---|---:|---:|---|---|
| 1 | original | 0.559 | 0.393 | ~100(presumed) | turnitai |
| 2 | final2.0 | 0.255 | 0.410 | 59 | turnitai |
| 3 | final3.0 | 0.151 | 0.644 | <20 | turnitai |
| 4 | final5.0 | 0.046 | 0.414 | <20 | turnitai |
| 5 | final5.1 | 0.375 | 0.538 | 25 | turnitai |
| 6 | final6.0 | 0.058 | 0.390 | 56 | turnitai |
| 7 | A1計劃 40a (終修版) | 0.975 | 0.756 | 40 | turnitai |
| 8 | A1計劃 40b Template(2) | 0.746 | 0.726 | 40 | turnitai |
| 9 | A1計劃 V3 | 0.730 | 0.795 | 24 | turnitai |
| 10 | A1計劃 V2 | 0.959 | 0.726 | 0 | turnitai |
| 11 | A1計劃 V7 | 0.980 | 0.846 | 31 | turnitai |
| 12 | final6.1 | 0.249 | 0.504 | 29 | turnitai |
| 13 | H2_ideal (evolve seed14) | 0.031 | 0.534 | <20 (not surfaced) | turnitai |
| 14 | H4_prodLT (production A + LT) | 0.048 | 0.498 | <20 (not surfaced) | turnitai |
| 15 | E2-grind (X + grind) | 0.030 | 0.621 | 0 AI / 13 similarity / 0 flags | turnitai |
| 16 | E2-oneclick81 (一键 8.1, code B398E0B859) | 0.020 | 0.477 | 0 AI / 22 similarity / 0 flags | turnitai |
| 17 | E2-oneclick82 (一键 8.2, code 05B0C1E1EB) | 0.034 | 0.582 | 0 AI / 16 similarity / 0 flags | turnitai |
| 18 | highAI-0983 (OriginCheck, code ADAC) | 0.983 | 0.270 | 98 AI (origincheck channel) | OriginCheck |
| 19 | assault-0649 (8.4 句級研磨, OriginCheck, code RCVS) | 0.762 | 0.310 | 8 AI (origincheck channel) | OriginCheck |
| 20 | assault-0782 (8.6/8.7 攻堅, OriginCheck, code UBVS) | 0.782 | 0.356 | 41 AI (origincheck channel) | OriginCheck |
| 21 | assault-0573 (8.8/8.9 攻堅, OriginCheck, code XU1M) | 0.573 | 0.374 | 0 AI (origincheck channel) | OriginCheck |
| 22 | E2-arch90 (9.0 graduation, code 49C86925C8) | 0.158 | 0.544 | 0 AI / 22 similarity / 0 flags | turnitai |
| 23 | **10.0 雙引擎並聯（B/A/B/A）** | —（新族用 ai_mk 0.13） | 0.465 | **<20% AI（未揭露）／6% 查重／0 flags** | turnitai 國際版 |

**渠道完整性**：turnitai（Submission ID 前綴 `26334`）與 OriginCheck（前綴 `3532`）是兩個不同的官方 API 帳號池；同文本跨渠道差 ±3 個百分點（E2-oneclick82：0% vs 3%）。

**雙特徵規則（舊引擎族，9/9 吻合）**：CV ≥0.54 → 全過（與 gen 無關至 0.69）；CV 0.38–0.39 → gen 決定（0.76 過／0.98 敗）；CV ≤0.28 → 敗。
**新引擎族（10.0）**：樣本 n=1，CV 0.465 → <20%，推論門檻約 0.42；**膝點（0.40–0.43）未標定**。

**已用檢測碼**：F20A277274、B398E0B859、05B0C1E1EB、ADAC-K9TP-TITM、53O0-ZT0M-QAVG、RCVS-8VN7-LUJ0、UBVS-YRL2-MX0B、XU1M-PM9Z-TMFS、49C86925C8（＋H2/H4 各一碼；10.0 真碼未記錄）。

---

## 附錄 C：文檔維護規則

1. **每個版本一條記錄，永不刪除**；發現前一版有錯，改該條並在「文件狀態與勘誤」登記。
2. **數字必須可追溯**：引用分數時寫明來源（校準點號／run log／渠道）。
3. **誠實邊界必寫**：任何「有效」的結論都要同時寫「在什麼條件下不成立」。
4. **校準點與版本號分開計**：點 = 數據（1–23）；版本 = 軟件里程碑。
5. **新增校準點時同步**：`calibration.json` → 附錄 B 表 → 相關版本的記錄。
6. 文檔改動與代碼改動**同一 commit**（避免文檔落後於現實，這是本次勘誤的根因）。

---

## 附錄 D：5.0 時代的設計原則（歷史參照）

> 這些規則仍然支配著**修補層**（`polish/polish.mjs` + `pipeline.mjs`，即 API 潤飾那條舊鏈）；v6 選擇式管線誕生後，它們不再是主鏈行為。保留於此是因為「為什麼默認不潤飾」的答案在這裡。

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
