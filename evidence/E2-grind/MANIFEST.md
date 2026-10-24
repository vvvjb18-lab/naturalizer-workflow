# E2-grind 證據包（內部技術評估用）

回應四項證據請求。所有檔案為管線原始產出或本次打包時的重新實測，無事後修改內容。

## 1. Turnitin 原件（01_turnitin/）
- `E2-grind_AI.pdf` — 4 頁。P1 封面元數據（Submission ID trn:oid:::26334:304157451、2026-10-24 11:01 GMT+5:30、E2-grind.docx、641 詞）；P2 AI Writing Overview：**0% detected as AI**（含分類明細 0 AI-generated）。
- `E2-grind_similarity.pdf` — 5 頁。P2：**13% Overall Similarity**（9% 網路＋4% 出版物）、**0 Integrity Flags**（"No suspicious text manipulations found"）。

## 2. 三件套（02_docx/）
- `E2_original.docx` — 原稿（自製仿學生議論文：糖稅、APA 引用、統計數據）
- `E2_A_v6-selection.docx` — A 稿：v6 6 候選 × 段落重組 X × 手術 × LT 層
- `E2_B_grind-delivery.docx` — B 稿（送檔本）：A 的最差段落經 grind.mjs 段級重生
- `prose/*.txt` — 對應純文本（供工具直接量測）；`E2_B_grind-delivery.fulltext.txt` 為 B 的提取文本
- 量化結論見 `04_metrics/trio-metrics.json`：A→B EditLens delta **+0.001**（門檻 0.1），CV 保留率 B/A **1.095**（升而非降）、B/原稿 1.66。

## 3. 執行 Log（03_logs/）
- `E2-grind-rounds.log` — grind 逐輪完整記錄（3 輪、每輪最差 3 段、溫度梯 1.0/1.1/0.95）：
  含段級重生次數（成功 7 次、no-gain 9 次、驗證拒絕 4 次（共 20 次重生嘗試））、每段前後分數
  （p2 0.977→0.050、p6 0.956→0.127、p4→0.664、p3→0.740、p5/p1 殘餘 0.96）。
  數字斗篷的還原過程體現為：重寫文本通過驗證（數字/引用全在）才計成功；
  佔位符若被 hz 改壞會以 "failed validation" 拒絕重試（round1 p5、round2 p5、round2 p2、round3 p3 共 4 次）。
- `E2-final2-v6-run.log` — A 稿的 v6 全鏈 log
- `grindmap.json` — B 稿寫回 docx 的段落映射（6 段）
- `ltmap-in/out.json` — LT 語法層的輸入輸出映射
- `queue-full.log` — 全日批次時間線（F1/R3/C4/E2 各輪，含本包各檔案的生成時間戳對應）
- 註：grind 的 stdout 即 queue.log 所錄（27 行），無另一份獨立 terminal scrollback。

## 4. 校準集（04_metrics/calibration.json）
- 15 點／15 課。第 15 點＝E2-grind（Turnitin 0%）。
- **完整性聲明**：13:37 的一次寫入中斷令本檔 JSON 損壞（H4 與 E2-grind 兩點之間缺一逗號），
  本次打包時修復；損壞原件保留於 `pipeline/v6-test/calibration.json.bak-corrupt`。
  修復僅補回分隔符，未改動任何數據。

## 碼帳本
5 碼已用 3：#1 213029C321→H2、#2 7070EADB0A→H4、#3 F20A277274→E2-grind。餘 B398E0B859、05B0C1E1EB。
