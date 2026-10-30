# 10. 兩次訓練中斷與防護改動（2026-10-30）

## 一、第一次：`dual20` 被 Colab 端回收

- 21:56 啟動雙模型訓練（routea 9B + routeb 12B 串行），22:25 最後一次成功讀 log。
- 09:31 執行 `colab sessions` 時顯示 `Pruned 1 stale local session(s)` / `No active sessions found on server`。
- 事後檢查 `dual20.jsonl`：**只有 `session_terminated reason=pruned`，沒有 `automation: drivemount` 事件**。
  這證明訓練腳本裡的 `os.makedirs("/content/drive/MyDrive/naturalizer_10.0")` 從未掛載過 Drive，
  只是在 VM 本機建立了一個同名空目錄；所有 adapter / GGUF / training_results.json 都寫在 VM 上，隨 VM 一起消失。
- 根因（兩層）：
  1. Drive 根本沒掛載成功（`colab drivemount` 需要 OAuth 傳遞，且 CLI token 只有 `drive.file` scope，掛載回 400）。
  2. 腳本用 `os.makedirs(..., exist_ok=True)`，掛載失敗時不會報錯，錯誤被靜默吞掉。

**教訓**：任何「寫到 Drive」的路徑都必須先驗證掛載點真的存在（例如在 `/content/drive/MyDrive` 放一個 sentinel 檔再讀回），
否則等於沒有備份。持久化不能依賴一個可能靜默失敗的掛載。

## 二、第二次：`colab sessions` 直接終止了兩個活著的 session

- 11:38 執行 `colab sessions`，輸出 `Pruned 1 stale local session(s)`，隨後兩個正在訓練的 session 同時失聯。
- `check1.jsonl` / `b1.jsonl` 各自記錄 `session_terminated reason=pruned`，時間戳與該指令執行時間完全一致。
- 觸發條件：session 建立時簽發的 runtime token 約 1 小時到期；到期後本地 registry 裡的 session 被判定為 stale，
  **prune 動作會在伺服器端終止 VM**，不只是清本地記錄。
- 損失：routea 第 200/394 步（51%）、routeb 第 145/230 步（63%），兩個 adapter 都沒有下載過。

**教訓**：`colab sessions` 不是唯讀指令，長跑期間禁止呼叫。需要確認 session 是否活著時，用一次
`colab exec -s <name> -f <trivial.py>`；它能正常返回就代表活著，而且 exec 會自行刷新 token。

## 三、已落地的防護

| 防護 | 做法 |
|---|---|
| checkpoint 自動打包 | `SaveAdapter` callback：每次 `save_strategy` 觸發後把 adapter 打成 `/content/latest_adapter.tar.gz`，log 印出大小，方便隨時抓取 |
| 縮短存檔間隔 | routea `save_steps=50`、routeb `save_steps=25`（約 7–12 分鐘一次） |
| 可續訓 | 若 `/content/resume_adapter` 存在，改用 `PeftModel.from_pretrained(..., is_trainable=True)` 從該 adapter 接著訓，而不是 `get_peft_model` 從零開始 |
| 不再碰 Drive | 產物全部留在 `/content`，由本地下載（分塊 1.7 GB，實測 6.3 MB/s） |
| 不再呼叫 `colab sessions` | 改用 trivial exec 探活 |
| adapter 優先於 GGUF | 先確保 115 MB 的 adapter 能下載，再做 merge/convert/quantize（可重跑） |

## 四、第三次阻塞：Colab 免費層 GPU 池不可用

- 11:40 起 `colab new --gpu T4` 持續回 `503 Service Unavailable`，
  回應 body 為 `{"endpoint":"","sub":0,"subTier":0,"outcome":2,...}`，
  即帳號為免費層（`subTier:0`）、當下無可分配容量（`outcome:2`）。
- 同一時間 CPU runtime 可以正常建立，所以不是帳號被封，是 GPU 池沒有空位。
- 對策：背景每 3 分鐘重試一次；恢復後兩條路線並行重跑（routea 1 epoch ≈ 110 分鐘、routeb 1 epoch ≈ 60 分鐘），
  訓練一結束就先把 adapter 抓回本地，再排 merge/GGUF。

## 五、對時程的影響

原計畫「一夜跑完、早上看結果」被兩次中斷 + GPU 池不可用打斷。
目前的狀態是：資料集與腳本都已定稿且驗證過（merge 數學單元測試誤差 0、資料未截斷），
只等 GPU 恢復即可重跑，不需要再改任何設計。
