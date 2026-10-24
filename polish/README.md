# 學術性修補（Humanizer 之後的最後一道工序）

> 完整 workflow 說明（含 docx、UI、報告、成本、交付）：[`../WORKFLOW.md`](../WORKFLOW.md)

Humanizer 的本職是打散 AI 味的句法節奏，它的 prompt 明確要求「reorganize as you see fit」，temperature 又是 1.0。代價是它偶爾會把句子改壞、把學術語域改成口語、把本來的一段散文硬生生拆成 `(1)(2)(3)`，甚至弄丟引用。這一層只做一件事：**找出這些缺陷，用最小的字串替換把它們修好，其餘一個字都不動。**

它不會「整體潤色」，不會重寫段落，不會把 Humanizer 刻意製造的長短句差異抹平。這一步用 API 上的完整大模型來做，不佔本機顯卡，也不跟 Humanizer 搶 VRAM。

---

## 一條命令跑完（推薦）

上層的 [`../pipeline`](../pipeline) 會先呼叫官方 `hz`（Humanizer 12B）改寫原稿，再跑本目錄的學術修補：

```bash
cd F:\Humanizer\pipeline
node pipeline.mjs "C:\path\draft.txt"
```

你會同時拿到 A（Humanizer 原始輸出，拿去跑第一份 Turnitin）、B（修補後）與中文報告。細節見 [`../pipeline/README.md`](../pipeline/README.md)。

原稿也可以是 `.docx`：管線用 hz 的 docx 模式，只把 hz 改寫的散文段落送來這裡修補，再寫回 B.docx；標題、表格、References 不動。報告的三稿對照就是這幾段。

不想用終端機：雙擊 [`../webui/start.cmd`](../webui/start.cmd)，開啟 <http://127.0.0.1:8790>，貼稿後可三欄對照原文／A／B 並看差異。

只想單獨跑修補時，才用下面這份說明。

## 為什麼這樣設計

一個完整大模型如果收到「請潤色這段文字」，它會把整篇改成它心目中的標準學術英文：句子長度趨於一致、連接詞變多、動詞抽象化。這正好是 Turnitin 這類偵測器最熟悉的特徵，等於把 Humanizer 的成果抵銷掉。

所以流程刻意拆成四步：

1. **審查（audit）**：模型只回傳缺陷清單，不回傳正文。每項缺陷必須引用 Humanizer 輸出裡的一段原文。
2. **修補（repair）**：模型只回傳 `before → after` 的替換對。`before` 必須逐字出現在原文中，且必須覆蓋被標記的缺陷。程式逐條驗證，通過才套用。
3. **驗證輪（預設 `audit`）**：對修補後的文字再審查一次，**只列出仍然存在的缺陷，不再改稿**。這些會進入報告的人工覆核清單。若你要全自動，可設 `repair`；但模型偶爾會把一句換成鄰句的 paraphrase，造成重複 claim，所以不建議在無人覆核下使用。
4. **監督輪（預設開）**：修補＋驗證後仍有未解決項時，先用本機 **hz** 對原稿對應句／段重新生成（預設 5 次），每次都要過事實／引用／結構／節奏校驗。hz 數次都過不了，才交給 **API**，由完整模型按同一套要求 `rewrite` 或 `patch`。
   - **Skill 合約**：API prompt 載入 `skills/academic-humanizer/PROMPT.md`（最小改動、不新增／不丟內容、保留引用數字、學術語域）；可切 `avoid-ai-writing`。
   - **Patch-first**：minor 只准 patch；rewrite 只限 major/critical 或結構問題，且一次只改一句。
   - **Quality judge**：候選先由獨立 rubric 評分（25 分）；通過才套用；API 被退回時帶 feedback 重試（strong 模式最多 3 次），仍不過保留 A。judge 通過的 rewrite 不會因缺陷數沒下降被誤刪。
   - **Strong mode（5.0）**：critical/major 若 judge 的 meaning／facts ≥4、academic ≥3、total ≥16，即使 naturalness／register 低也會強制套用，報告標「強制修正」；minor 只准 patch。
   - **Rewrite 模型可獨立設定**：`rewriteProvider`／`rewriteModel`／`rewriteApiKey`；`gemini-native` 走原生 generateContent；全篇改寫禁止。

模型從頭到尾沒有機會輸出整篇文章，所以它不可能偷偷重排段落、插入列表，或把節奏磨平。就算它想越界，校驗也會把那次替換退回。

在此之上還有一層**確定性檢查**（不靠模型）：

- 原稿有、Humanizer 輸出沒有的數字 → 嚴重問題
- 原稿有、輸出沒有的引用標記 → 嚴重問題（會請模型放回同一論斷旁；放不回就列人工清單）
- 新增的 `(1)(2)(3)`、`（1）`、項目符號、Markdown 標題 → 結構問題
- 句尾截斷、重複句、括號／引號不成對
- 口語詞、縮寫、第二人稱、反問句、AI 套語
- 句長變異係數（節奏）、改動字數比例

每一條模型替換都要再過一次這些檢查：不能弄丟數字或引用、不能新增列表、不能新增 AI 套語、不能新增或刪除句子（結構修補除外）、不能改動超過原句 2.2 倍、不能重複既有句子或同一個內容片語、不能「換句話說」到相似度低於門檻。不合格就只針對那條重試一次；再不合格就保留原文，列入未解決。

---

## 快速開始（API）

1. 打開 `polish.config.json`，把 API key 填進去：

   ```json
   {
     "provider": "deepseek",
     "apiKey": "sk-你的key"
   }
   ```

   不想把 key 寫進設定檔，就在 `polish` 資料夾建立 `.env`：

   ```
   DEEPSEEK_API_KEY=sk-你的key
   ```

   config 裡的 `apiKeyEnv` 已指向這個變數名。也可以直接設 Windows 環境變數 `POLISH_API_KEY`。

2. 先測連線：

   ```bash
   cd F:\Humanizer\polish
   node polish.mjs --ping
   ```

   成功會顯示模型名稱、端點與延遲。失敗會直接告訴你是 key、模型名稱、端點還是餘額的問題。

3. 跑稿件（**一定要帶原始草稿**）：

   ```bash
   node polish.mjs "C:\path\humanized.txt" ^
     --draft "C:\path\original.txt" ^
     --out "C:\path\final.txt"
   ```

   或把 Humanizer 輸出檔拖到 `run-polish.cmd` 上，按提示輸入原始草稿路徑。

跑完會得到：

- `final.txt`：修補後正文
- `final.report.md`：中文報告（修了什麼、為什麼、什麼沒修、要人工看什麼）
- `final.report.json`：結構化結果（方便日後接自動化）

只想先看問題、不要改稿：

```bash
node polish.mjs "C:\path\humanized.txt" --draft "C:\path\original.txt" --audit-only
```

沒有原始草稿，工具只能檢查內部缺陷（語法、結構、語域），無法核對數字、引用、術語與論斷強度，等於少了一半價值。

## 選哪個 API

所有非 Ollama 的 preset 都走 OpenAI 相容協議；任何相容端點都能用，只要填 `baseUrl` 與 `model`。

| `provider` | 端點 | 預設模型 | 備註 |
|---|---|---|---|
| `deepseek` | `https://api.deepseek.com/v1` | `deepseek-chat` | 預設。中英學術寫作都穩，價格低，香港可直接用 |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-pro` | 長文與語感好，需確認所在地區可用 |
| `openai` | `https://api.openai.com/v1` | `gpt-4.1` | 香港地區通常需其他途徑 |
| `openrouter` | `https://openrouter.ai/api/v1` | `openai/gpt-4.1` | 一個 key 可用多家模型 |
| `moonshot` | `https://api.moonshot.cn/v1` | `moonshot-v1-32k` | 中文稿件表現好 |
| `qwen` | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | 阿里雲國際版 |
| `zhipu` | `https://open.bigmodel.cn/api/paas/v4` | `glm-4.5` | 中文可用 |

切換很簡單：

```bash
node polish.mjs humanized.txt --draft original.txt --provider gemini --api-key <key>
```

或只改 `polish.config.json` 的 `provider`，`baseUrl` 與 `model` 留空就會套用 preset；要指定別的模型再填 `model`。

**模型選擇原則**：這一步要的是「嚴格遵守格式、只改被點名的缺陷」，不是創意。`deepseek-chat`、`gpt-4.1`、`gemini-2.5-pro` 這類一般對話模型比 reasoning 模型更合適。reasoning 模型容易把 `maxOutputTokens` 花在思考上，也可能無視「只回 JSON」的約束；若堅持使用，把 `maxOutputTokens` 調到 6000 以上並先用 `--ping` 驗證。

成本參考：一份 1,500 字稿件約 3–6 次呼叫，合計 15k–30k input tokens、2k–4k output tokens。以 DeepSeek 的價格，每份約 HK$0.05 以內。

## 它會修什麼

| 類型 | 例子 | 處理方式 |
|---|---|---|
| grammar | 缺字、主謂不一致、搭配錯誤、殘句 | 局部替換 |
| meaning | 改寫後意思變了、限定語消失 | 對照原稿還原 |
| register | `a big deal`、`Basically`、`you`、`don't`、反問句 | 換成最樸素的學術等義詞 |
| fact | 數字、年份、人名、單位、引文被改 | 對照原稿還原；找不到就標嚴重 |
| citation | 引用標記消失或掛錯論斷 | 從原稿放回；不確定就不猜 |
| structure | 散文變成 `(1)(2)(3)`、項目符號、標題；截斷；重複句 | 還原成散文，保留全部內容 |
| terminology | 關鍵術語被近義詞替換 | 還原原稿術語 |
| cohesion | 過渡詞指向錯的對象，句子讀不通 | 只修該處 |

## 它刻意不做什麼

- 不重寫沒被標記的句子
- 不合併、拆分、重排句子或段落
- 不加過渡句、主題句、總結句
- 不加新論點、例子、證據
- 不把樸素動詞升級成抽象名詞
- 不為了「更學術」而加 `moreover`、`furthermore`、`crucial`、`multifaceted` 這類 AI 套語
- 不恢復 Humanizer 刪掉的冗餘 hedging；只在原稿本來就有、而改寫後變成過度斷言時，放回該處的限定語

## 報告怎麼讀

報告最前面有「三稿對照」：原文、A、B 的字數／段落／句數／列表標記／數字／引用並排，附三份全文與格式核對清單。先確認格式沒有被破壞，再看修補品質。

先看三行：

- **實際修補 N 處（改動 X% 字詞）**：X 一般應該在 2–10%。超過 15% 代表模型越界，報告會標 `edit-budget` 不通過。改動比例是「Humanizer 輸出 vs 最終輸出」的實際字詞差異，不會因為驗證輪重複計算。
- **驗證輪另發現 N 項**：第二輪補抓到的缺陷數。正常情況是 0–3 項。
- **節奏保留 Y%**：修補後句長變異係數 ÷ Humanizer 輸出的變異係數。低於 80% 代表句子被抹平了，這一輪應該退回或換模型。少於 120 字的短稿不判定（變異係數太不穩定）。
- **硬性檢查**：`numbers`、`citations`、`structure` 任一不通過，就不要直接交付。

報告裡的「人工覆核清單」是逐項 checkbox，照著做即可。

## 參數

| 參數 | 預設 | 說明 |
|---|---|---|
| `--draft` | 無 | 原始草稿（強烈建議） |
| `--out` | `<輸入>.polished.txt` | 輸出正文 |
| `--report` | `<輸出>.report.md` | Markdown 報告 |
| `--json` | `<輸出>.report.json` | JSON 報告 |
| `--audit-only` | 關 | 只審查，不改稿 |
| `--ping` | 關 | 測試 API 設定 |
| `--lang` | `auto` | `en` / `zh` / `auto` |
| `--provider` | `deepseek` | preset 名稱 |
| `--model` | preset | 覆蓋模型 |
| `--api-key` | 空 | API key |
| `--chunk-chars` | 6000 | 每次送模型的字元數 |
| `--max-edit-ratio` | 0.15 | 改動字數上限（短稿另有 40 字下限） |
| `--max-output-tokens` | 3000 | 單次回應上限（防失控成本） |
| `--verify` | `audit` | 驗證輪：`audit`（只審查，預設）、`repair`（自動再修）、`off` |
| `--quiet` | 關 | 關閉進度輸出 |

進階設定在 `polish.config.json`：`verifyRound`（`repair` / `audit` / `false`）、`minCvRetention`（節奏保留下限，預設 0.8）、`maxPatchWords`（單次替換字數上限，預設 180）、`maxIssuesPerChunk`、`repairBatch`、`timeoutMs`；監督輪：`cleanup`（true）、`maxCleanupRounds`（3）、`maxCleanupActions`（12）、`hzRetry`（true）、`hzRetries`（5）、`maxHzIssues`（8）、`hzTimeoutMs`（180000）；skill／judge：`skill`（academic-humanizer）、`judge`（true）、`judgeModel`／`judgeApiKeyEnv`、`judgeMinScore`（18）、`judgeMinDimension`（3）、`judgeFailOpen`（false）；strong：`mode`（strong）、`strongAttempts`（3）、`forceFix`（true）、`forceMinScore`（16）；rewrite：`rewriteProvider`（gemini-native）／`rewriteModel`（gemini-3.6-flash）／`thinkingBudget`（0）／`rewriteProxyUrl`（Clash，預設 7897）／`rewriteFallback`（true）；judge 預設用主模型 DeepSeek。

## 交付前的 A/B 驗證

這一步的目的不是「保證降 AI 率」，而是「在不破壞學術性的前提下，盡量保留 Humanizer 已經拿到的降幅」。每次改動都可能讓分數變動，所以請固定流程：

1. 同一份原稿，保留 Humanizer 原始輸出（A）與修補後輸出（B）。
2. A、B 各跑一次正式 Turnitin 報告，記下 AI 指標。
3. 若 B 明顯高於 A：先看 `edit-budget` 與節奏保留率。改動超過 10% 或節奏保留低於 85%，通常是模型越界；把 `maxPatchWords` 調低到 60、`minPatchSimilarity` 調高到 0.4，再跑一次。
4. 若 B 與 A 接近：看報告的未解決項，人工補完引用與數字即可交付。
5. 報告裡的 `(1)(2)(3)`、引用、數字這三項，永遠人工再看一眼。模型不會故意說謊，但它會自信地猜。

## 本機模型（可選）

工具仍支援 Ollama（`--provider ollama`）與任何 OpenAI 相容的本機服務（`--provider lmstudio`）。但要注意：Humanizer 的引擎會佔用 5–6 GB VRAM，27B 模型同時跑會被迫部分卸載到 CPU，實測只有 1.6 tok/s，一份稿件要幾十分鐘。若要用本機模型，先關掉 Humanizer 再跑修補；趕 30 分鐘單時，直接用 API 更穩。

## 責任邊界

- 這是編輯工具，不是代寫工具：它不生成新內容，只修 Humanizer 造成的破壞。
- 引用與數字以原稿為準；工具不會發明引用，但也無法判斷原稿本身的引用是否正確。
- 任何 AI 偵測結果都不保證。交付前請重新跑正式報告，不要沿用修改前的截圖。
- 客戶條款若禁止 AI 輔助，依客戶條款辦理。

## 檔案結構

```
polish/
  polish.mjs                  CLI
  run-polish.cmd              Windows 拖放
  test-api.cmd                測 API 連線
  polish.config.json          你的設定（含 API key，已 gitignore）
  polish.config.example.json  設定範例
  src/text.mjs                分句、段落、模糊定位、句長指標、切塊
  src/checks.mjs              事實／引用／結構／語域檢查、替換校驗、最終門檻
  src/prompts.mjs             審查與修補 prompt
  src/llm.mjs                 OpenAI 相容 / Ollama 客戶端（JSON 模式）
  src/pipeline.mjs            流程編排、重試、監督改寫、quality judge
  skills/                     academic-humanizer / avoid-ai-writing（MIT，含 PROMPT.md）
  src/report.mjs              中文報告
  test/                       單元測試與模擬模型端到端測試
  samples/                    示範原稿與 Humanizer 風格壞稿
```

跑測試（不需要 API key，全部用本機 mock）：

```bash
cd F:\Humanizer\polish
node --test test/*.test.mjs
```

## 疑難排解

**`缺少 API key`**：在 `polish.config.json` 填 `"apiKey"`，或設 `POLISH_API_KEY`，或加 `--api-key`。

**`HTTP 401`**：key 錯、過期，或 `provider` 與 `baseUrl` 不匹配（例如用了 DeepSeek 的 key 卻指向 OpenAI 端點）。

**`HTTP 404 model not found`**：模型名稱不在你的帳戶方案內。用 `--model` 指定一個你確定可用的模型。

**`HTTP 429`**：撞到速率限制或餘額不足。工具會自動重試一次；持續發生就降低併發（目前是逐段處理）或換 key。

**一直回傳無效 JSON**：先跑 `--ping`。若 ping 正常但正式跑失敗，通常是 `maxOutputTokens` 太小被截斷，調高到 4000–6000。

**某條缺陷一直 `before not found verbatim`**：模型沒有逐字複製。重跑通常會好；若反覆出現，把該段貼進報告的人工清單手動處理。

**修補後分數反而上升**：先減小改動幅度（`--max-edit-ratio 0.08`、`maxPatchWords: 60`、`minPatchSimilarity: 0.4`），再看報告的 `rhythm` 與 `ai-phrases` 兩項。
