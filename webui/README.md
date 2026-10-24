# 網頁 UI（本機）

> 完整 workflow 說明（含 docx、CLI、報告、成本、交付）：[`../WORKFLOW.md`](../WORKFLOW.md)

把「原稿 → Humanizer → 學術修補」做成一個本機網頁：貼稿、按開始、三欄對照 A/B 與原文、下載報告。

## 啟動

雙擊 `start.cmd`，或：

```bash
cd F:\Humanizer\webui
node server.mjs
```

開啟 http://127.0.0.1:8790

服務只綁定 `127.0.0.1`，不會對外開放；稿件只存在本機 `webui/runs`，兩天或超過 30 次執行後自動清理。

## 用法

1. 貼上原始草稿（或拖入 `.txt` / `.md` / `.docx`）。
2. 如果已經有 Humanizer 輸出，勾「我已有 Humanizer 輸出」並貼上 A；否則直接跑，它會呼叫 `hz`。
3. 選驗證輪（預設 `audit`，只審查）與語言。
4. 按「開始」。第一步是本機 12B（約 10 秒–3 分鐘），第二步是 API（約 10–30 秒）。
5. 完成後看：
   - 四張摘要卡：修補數、未解決、硬性檢查、Humanizer 統計
   - 若修補後仍有缺陷，監督輪會先用 hz 重生，數次不過才由 skill 合約的完整 AI 改寫（strong 最多 3 次），再過 quality judge；核心維度通過可強制修正。摘要卡會顯示改寫句數、品質退回與強制修正數
   - 三欄對照：原文 / Humanizer（A）/ 修補後（B），差異以紅綠標示
   - 「未自動處理／待覆核」清單
   - 完整 Markdown 報告
6. 用「下載 A / 下載 B / 下載報告」交付或存檔。

## 差異標示

- 原文的紅色：Humanizer 刪掉或改掉的字。
- A 的綠色：Humanizer 新增的字。
- B 的綠色：修補層新增的字。
- 段落重排是正常的；重點看數字、引用、`(1)(2)(3)` 與句長節奏。
- 文字太長（超過約 6,000 個 token）時會自動關閉差異標示，只顯示純文字，避免瀏覽器卡住。

## 前置

與 CLI 管線相同：

- `hz` 已安裝（`uv tool install "git+https://github.com/sgaofen/humanizer-local-model"`）
- Humanizer App 開著（`hz` 會自動找；關著會嘗試啟動）
- `../polish/.env` 或 `../polish/polish.config.json` 有 API key

## DOCX

- 拖入 `.docx` 後，伺服器用 hz 的 docx 模式改寫：只動散文段落，標題、表格、References、含圖片／超連結的段落保持原樣。
- 修補只作用在 hz **實際改寫** 的段落；三欄對照顯示的是這幾段，不是整份文件。
- 完成後可下載 **A.docx / B.docx**（保留標題、表格、樣式）與 **A/B.txt**（全文）。
- 段落內局部的粗體／斜體，在改寫後會變成整段套用第一個 run 的格式；這是 hz 本身的限制。
- docx 模式目前不能同時貼文字 A；要重跑既有的 A.docx，請用 CLI 的 `--humanized`。

## 注意

- 這是本機工具，不要綁到 `0.0.0.0` 或放到公網。
- 網頁不會顯示 API key；報告只記錄模型名稱與端點。
- `audit` 模式只審查、不改稿；要第二輪自動修再選 `repair`（模型偶爾會把一句換成鄰句的 paraphrase，建議仍人工覆核）。
- 若 port 8790 被佔用：`set PORT=8791 && node server.mjs`。

## 檔案

```
webui/
  server.mjs          本機 HTTP 服務 + NDJSON 進度串流
  public/index.html   頁面
  public/app.js       串流、三稿對照、word diff、下載
  public/styles.css   樣式（含深色模式）
  start.cmd           啟動並開瀏覽器
  runs/               每次執行的原稿與產物（自動清理）
```
