# Workflow 5.0 規則修改指南

這份文件教你改哪一層、怎麼改、改完怎麼驗證。**規則分五層，先找對層再動手。**

```text
1. 設定層     polish/polish.config.json        次數、模型、門檻
2. Skill 層   polish/skills/<name>/PROMPT.md   API rewrite 的編輯合約
3. Prompt 層  polish/src/prompts.mjs           審查／修補／改寫／judge 的指令
4. 檢查層     polish/src/checks.mjs            AI 套語、結構、數字引用、patch 校驗
5. 流程層     polish/src/pipeline.mjs          hz→API→judge、patch-first、強制、回滾
```

---

## 1. 設定層：`polish/polish.config.json`

這一層最安全，改完下一次執行就生效，不用重啟 UI。

| 欄位 | 目前 | 作用 | 建議範圍 |
|---|---|---|---|
| `hzRetries` | 5 | hz 對每個缺陷重生幾次 | 2–8；5 次約多 1–4 分鐘 |
| `maxHzIssues` | 8 | 每輪最多幾個問題走 hz | 1–8 |
| `maxCleanupRounds` | 3 | 監督輪最多幾輪 | 1–3 |
| `maxCleanupActions` | 12 | 每輪最多修幾個問題 | 8–16 |
| `mode` | `strong` | `safe` 只做保守修補；`strong` 開 3 次 API + 強制 | `strong` / `safe` |
| `strongAttempts` | 3 | API rewrite 總嘗試次數（含 feedback） | 2–5 |
| `forceFix` | true | judge 核心維度過但自然度低時，仍強制套用 | true / false |
| `forceMinScore` | 16 | 強制套用的最低 judge 總分 | 14–20 |
| `judgeMinScore` | 18 | 正常接受 rewrite 的最低分 | 16–22 |
| `judgeMinDimension` | 3 | 任一維度不得低於 | 3–4 |
| `judge` | true | 是否跑 quality judge | true / false |
| `judgeFailOpen` | false | judge 失敗時是否放行 | 建議 false |
| `skill` | academic-humanizer | 注入的 skill 合約 | 見第 2 節 |
| `rewriteProvider` | gemini-native | rewrite 用哪家 | `gemini-native` / `openai` / 空=主模型 |
| `rewriteModel` | gemini-3.6-flash | rewrite 模型 | 任何支援的模型 |
| `thinkingBudget` | 0 | Gemini thinking 額度；0=關閉 | 0（rewrite 用） |
| `rewriteProxyUrl` | http://127.0.0.1:7897 | rewrite 專用代理（Clash） | 7897 或 7890 |
| `rewriteFallback` | true | Gemini 失敗自動退回主模型 | 建議 true |
| `judgeProvider` | 空 | judge 用哪家；空=主模型 | 建議與 rewrite 不同 |
| `judgeModel` | 空 | judge 模型 | 例如 `deepseek-chat` |
| `verifyRound` | audit | `audit` 只審查；`repair` 第二輪自動修；`off` | 建議 audit |
| `maxEditRatio` | 0.25 | 全文改動硬預算；超過即停止監督輪 | 0.15–0.3 |
| `minCvRetention` | 0.8 | 節奏保留門檻 | 0.75–0.9 |
| `maxPatchWords` | 180 | 單次替換字數上限 | 120–200 |

### 常見改法

**更保守（品質優先）**

```json
"mode": "safe",
"forceFix": false,
"judgeMinScore": 20,
"judgeMinDimension": 4,
"strongAttempts": 2,
"hzRetries": 3
```

**更積極（想清掉更多缺陷）**

```json
"mode": "strong",
"forceFix": true,
"forceMinScore": 16,
"judgeMinScore": 18,
"strongAttempts": 3,
"hzRetries": 5
```

但要看報告的「強制修正」與「未解決」；強制越多，越可能換來自然度下降。

**切 Gemini Flash 當 rewrite、DeepSeek 當 judge**

```json
"rewriteProvider": "gemini-native",
"rewriteModel": "gemini-3.6-flash",
"thinkingBudget": 0,
"rewriteApiKeyEnv": "GEMINI_API_KEY",
"rewriteProxyUrl": "http://127.0.0.1:7897",
"rewriteFallback": true,
"judgeProvider": "",
"judgeModel": ""
```

- Clash 要把 Google/Gemini 規則切到 US/JP/SG；目前 7890 出去是 HK，會被地區擋。
- `rewriteFallback: true` 會在地區錯誤/代理斷線時自動用 DeepSeek，不會卡死。
- 如果 Clash for Windows 用 7890，把 `rewriteProxyUrl` 改成 7890。

**只審查、不改稿**

```json
"cleanup": false,
"verifyRound": "audit"
```

或 CLI：`--audit-only`。

---

## 2. Skill 層：`polish/skills/<name>/PROMPT.md`

API rewrite 會把 `PROMPT.md` 注入 prompt；這是**改學術規則最直接的地方**。

- `skills/academic-humanizer/PROMPT.md`：最小改動、不新增／不丟內容、保留引用數字、學術語域、claims match evidence。
- `skills/avoid-ai-writing/PROMPT.md`：更偏「只去 AI 味、保留聲音」的編輯合約。
- 完整 `SKILL.md`、references、`check_revision.py` 保留在同資料夾，供 agent／手動使用。

### 加一條規則的寫法

在 `PROMPT.md` 的 Style rules 加一行，例如：

```text
- Preserve the author's British spelling (organisation, analyse); do not switch to American spelling.
```

或中文：

```text
- 保留作者的繁體中文用字（「資料」不改成「数据」）；不要改成簡體。
```

### 切換 skill

```json
"skill": "avoid-ai-writing"
```

或 `"skill": "none"`。改完下一次執行生效，不用重啟 UI。

### 不建議

- 不要直接把「smallest change」「nothing added / nothing lost」刪掉；這三條是防止 3.0 質量問題的核心。
- 不要把完整 SKILL.md 的整段貼進 PROMPT.md；prompt 會太長，模型反而忽略規則。PROMPT.md 控制在 100–150 行內。
- 想保留上游出處，就不要直接改 `SKILL.md`；改 `PROMPT.md`，或複製整個 skill 資料夾成 `skills/my-academic/` 再改。

---

## 3. Prompt 層：`polish/src/prompts.mjs`

這裡有四個函式：

| 函式 | 用途 | 輸出格式 |
|---|---|---|
| `auditPrompt` | 找缺陷 | `{"issues":[{"type","severity","quote","problem","fix"}]}` |
| `repairPrompt` | 第一輪修補 | `{"patches":[{"issue","before","after"}],"unresolved":[]}` |
| `cleanupPrompt` | 監督層 patch/rewrite | `{"action","before","after","reason"}` |
| `qualityJudgePrompt` | 品質評分 | `{"scores":{...},"total","verdict","problems","fix"}` |

### 改 prompt 的硬性注意

1. **不要改 JSON 的 key 名稱**；程式用 `issues`、`patches`、`action`、`before`、`after`、`scores`、`verdict` 解析。
2. 新增 issue type 時，要同步改 `pipeline.mjs` 的 `VALID_TYPES`，否則會被歸成 `grammar`。
3. 新增 cleanup action 時，要同步改：
   - `requestCleanupAction` 的允許清單
   - `applyCleanupAction` 的處理分支
   - 報告的輪次／type 顯示
4. 新增 judge 維度時，要同步改：
   - `qualityJudgePrompt` 的 rubric
   - `judgeCandidate` 的 `keys` 陣列
   - 總分與門檻（目前 5 維、25 分）
5. 保留這幾句，不要刪：
   - smallest replacement / smallest sufficient change
   - preserve numbers, dates, names, units, quotations and citations
   - do not add content, evidence, examples or opinions
   - no lists/numbering/headings

### 例：讓 repair 更不喜歡改正式連接詞

在 `repairPrompt` 的 Never introduce 那條加：

```text
or any of: Therefore, Additionally, Furthermore, Moreover, In conclusion as a new sentence opener
```

注意：這會讓某些 register 修補更保守；要配合 `auditPrompt` 不要一直要求把 `But` 改成 `However`。

---

## 4. 檢查層：`polish/src/checks.mjs`

這一層是不靠模型的硬性規則，改動影響最大。

| 位置 | 內容 |
|---|---|
| `AI_PHRASES_EN` / `AI_PHRASES_ZH` | AI 套語 regex |
| `COLLOQUIAL_EN` / `COLLOQUIAL_ZH` | 口語詞 |
| `CONNECTIVE_WORDS` | 句首轉折詞（重複檢查） |
| `STRUCTURE_RES` | `(1)(2)(3)`、列表、標題 regex |
| `numbersIn` / `factNumbers` / `citationsIn` | 數字與引用抽取 |
| `validatePatch` | patch 的數字、引用、長度、句數、AI 套語校驗 |
| `validateRewrite` | rewrite 的同類校驗 |
| `finalGates` | 最終硬性門檻 |

### 加一個禁用詞

在 `AI_PHRASES_EN` 加 regex：

```js
/in the rapidly evolving/gi,
```

在 `COLLOQUIAL_EN` 加口語：

```js
/\bstuff like that\b/gi,
```

中文在 `AI_PHRASES_ZH` / `COLLOQUIAL_ZH` 加，例如：

```js
/在當今[^。！？]{0,20}(?:時代|社會)/g,
```

- 用 `g` 旗標；不要用 lookbehind 之外的複雜語法（Node 支援，但可讀性差）。
- 加完跑 `node --test test/*.test.mjs`；有些測試的 fixture 可能被新規則影響。

### 加一個結構標記

在 `STRUCTURE_RES` 加：

```js
dashList: /^\s*[—–]\s+/gm,
```

然後 audit 的 structure 檢查會自動比較 draft/output 的差值；不用改其他地方。

### 改 patch 嚴格度

- `validatePatch` 的 `ratio` 範圍（目前 0.45–2.2）
- `beforeSents` 上限（目前 3，且非結構不可增刪句）
- `minPatchSimilarity`（config；grammar/cohesion 用）
- `validateRewrite` 的 `maxSents`（非結構目前只准 1 句）、長度比、AI 套語、引用數字

**不要放寬數字／引用檢查**；3.0 的教訓就是放寬後會把事實改壞。要修引用重複，應該加專門的 duplicate-citation 規則，不是取消校驗。

### 加一個 final gate

在 `finalGates` 加 `push('xxx', ok, detail)`；`ok=false` 會讓 CLI exit 2、報告標紅。不要加會大量誤報的 gate。

---

## 5. 流程層：`polish/src/pipeline.mjs`

這一層管「什麼時候 hz、什麼時候 API、什麼時候 judge、什麼時候 rollback」。

| 位置 | 管什麼 |
|---|---|
| `runCleanup` | hz → API → judge → 重審；strong attempts；rollback；judge-approved keep |
| `tryHzRewrite` | hz 對原稿句重生、validate、rhythm、duplicate、judge |
| `applyCleanupAction` | patch/rewrite、minor 只准 patch、單句、強制修正 |
| `runPipeline` | audit → repair → verify → cleanup → gates → report |
| `judgeCandidate` | judge rubric 分數與通過條件 |

### 常見改動

**改 hz 次數**：改 config `hzRetries`，不要改流程。
**改強制修正條件**：`applyCleanupAction` 的 `forceOk`；目前是 meaning/facts≥4、academic≥3、total≥forceMinScore。
**改 patch-first**：`applyCleanupAction` 的 `if (!isStructure && issue.severity === 'minor')`。
**改單句限制**：`findRewriteTarget` 的 `count <= 1`，以及 `beforeSents !== 1`。
**改 rollback**：`runCleanup` 的 `left.length >= remaining.length` 分支；judge-approved rewrites 會保留。
**改 judge 模型**：config `judgeProvider`/`judgeModel`，不要改 `judgeConfig`。

改流程一定要加測試；`test/pipeline.test.mjs` 有 mock 模型，可以測 accept/reject/force/rollback，不需要真的 API。

---

## 6. 修改後的驗證流程

```bash
cd F:\Humanizer\polish

# 1. 語法
node --check polish.mjs
node --check src/pipeline.mjs
node --check src/prompts.mjs
node --check src/checks.mjs

# 2. 單元＋mock 端到端（28 項）
node --test test/*.test.mjs

# 3. 主模型連線（DeepSeek）
node polish.mjs --ping

# 4. 小樣本，先只看問題
node polish.mjs draft.txt --draft original.txt --audit-only --report audit.md

# 5. 小樣本完整跑
node polish.mjs draft.txt --draft original.txt --out final.txt
```

看報告的四個地方：

1. `品質 gate`：通過／退回／強制各幾項。
2. `監督輪`：hz 幾次、API 幾次、judge 分數。
3. `未自動處理`：是「保留 A」還是「原稿本身」。
4. `edit-budget`／`rhythm` 有沒有爆。

改完規則，最好用同一份小樣本做前後對照；再用真實稿件跑 A/B Turnitin，不要只靠 prompt 感覺。

---

## 7. 不要碰的地方

- `Humanizer.exe`／`engine/`：編譯好的 app，不要改。
- `check_revision.py` 的核心 invariant 檢查：可以加，不要刪。
- `validatePatch` 的數字／引用保護：不要放寬。
- `qualityJudgePrompt` 的「meaning/facts」核心：不要為了讓 rewrite 過而降低。
- 全篇改寫：不要加回來；85% 的實測已經證明會把 AI 率拉高。
- 不要把帶 token 的 Clash 訂閱連結寫進專案；只寫本機代理埠（例如 `http://127.0.0.1:7897`）。

---

## 8. 快速定位

```bash
cd F:\Humanizer\polish

# 找某條規則
grep -n "hzRetries" polish.config.json
grep -n "AI_PHRASES" src/checks.mjs
grep -n "smallest" src/prompts.mjs skills/academic-humanizer/PROMPT.md
grep -n "forceOk" src/pipeline.mjs
grep -n "judgeMinScore" src/pipeline.mjs

# 看目前設定
cat polish.config.json
```

改完如果想確認 UI 是否同步：`curl http://127.0.0.1:8790/api/version`。config／prompt／skill 是每次執行重新讀，不用重啟 UI；改 `server.mjs` 或靜態檔才需要重新整理／重啟。
