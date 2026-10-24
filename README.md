# Naturalizer Workflow

本地化學術文本「去 AI 味」處理管線（Humanizer 12B GGUF ＋ 學術修復層），目標：低 Turnitin AI 偵測（<20%）＋ 可交付品質。

**目前版本：7.5**（數字斗篷 Number Cloak ＋ 段級研磨 Grind ＋ LT 安全修復層）

## 核心組件

| 組件 | 說明 |
|---|---|
| `candidates.mjs` | 候選生成：單元級改寫、數字／引文斗篷、事實校驗（數字、引文、長度比、重複句） |
| `v6.mjs` | 主鏈：docx 解析 → 候選生成 → 段級重組（crossover）→ NLI 守門 → 修補 → 風險卡 |
| `grind.mjs` | 段級研磨：tmr 評分最差段落定向重生（3 輪 × worst-3），NLI 矛盾閘（>0.5 拒收） |
| `polish/lt_fix.py` | LanguageTool 6.8 安全類別修復（引用／專有名詞／References 保護，en-GB） |
| 離線評分三件套 | tmr-ai-text-detector (p_ai_gen)／EditLens (p_ai_edit)／GPT-2 perplexity，CV 節奏帶 0.45–0.65 |

## 校準結論（15 點／15 課）

- gen ≤ 0.05 → Turnitin <20%（三例實測：H2 0.031／H4 0.048／E2-grind 0.030）
- API 潤飾每級 +10–15% Turnitin；gen 0.24+ 一律不予送檢
- 個人敘事（第一人稱）＝綠區；正式第三人稱（argumentative/report）＝紅區，需 grind 破境

## 證據包

| 案例 | 結果 | 位置 |
|---|---|---|
| E2-grind（紅區 argumentative） | **0% AI／13% 查重／0 Integrity Flags** | [`evidence/E2-grind/`](evidence/E2-grind/) |

每個證據包含：Turnitin 原件 PDF、三件套 docx（原稿/A 稿/B 稿）、終端 log、校準數據、統一報告 PDF 與其建置腳本 `build_pdf.py`。內容索引見各包內 `MANIFEST.md`。

## 完整性聲明

- `04_metrics/calibration.json` 曾因寫入中斷損壞（缺一逗號），僅補回分隔符修復，原件保留於本地 `calibration.json.bak-corrupt`
- grind log 由 stdout 重排，段落重生統計（成功 7／no-gain 9／驗證拒絕 4）與原始輸出一致

## 授權與存取

本倉庫為 **Private**，僅限擁有者與獲邀協作者存取。內含 Turnitin 提交紀錄與客戶交付證據，請勿轉公開、勿外流。
