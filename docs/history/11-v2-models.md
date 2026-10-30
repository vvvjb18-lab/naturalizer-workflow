# 11. v2 雙引擎的行為邊界（2026-10-31）

兩個 v2 adapter 都訓練完成、轉成 GGUF Q5_K_M、載入 Ollama 實測。這份記錄它們**實際會做什麼、不會做什麼**，
以及幾個會影響部署的硬體事實。

## 一、訓練與產物

| 項目 | routea v2 | routeb v2 |
|---|---|---|
| 底模 | `Qwen/Qwen3.5-9B-Base` | `jialinyyzz/humanizer`（gemma4） |
| 資料 | 3,151 對（PELIC 2,368 + BAWE 821，含中文母語 533） | 917 對（BAWE 794 + NUCLE 27 + v1 清洗 241） |
| 方法 | QLoRA 4-bit nf4，r=32 α=64，1 epoch 394 步 | 同左，1 epoch 115 步 |
| 最終 loss | **1.485** | **1.186** |
| GGUF | 6.64 GB | 8.55 GB |
| Ollama 名稱 | `routea-qwen35-9b-v2` | `routeb-humanizer12b-v2` |

routea 的 loss 只從 1.75 降到 1.485，routeb 從 1.49 降到 1.186——**routeb 收斂得明顯更好**，這個差異在行為上直接體現出來。

## 二、行為差異（實測）

### routea v2：條件式改寫器，且高方差

餵典型 AI 學術句：

> In today's rapidly evolving digital landscape, it is crucial to delve into the multifaceted
> relationship between celebrity endorsement and consumer behaviour...

輸出：

> We are living in a digital world, we have to know more about star endorsement and customer
> behavior. Also, we cannot ignore the expertise perceived by the endorser, because it will
> make the endorser a powerful effect on intention to buy.

- ✅ `delve` / `multifaceted` / `pivotal` / `profound` 全部消失，語域確實降成學生口語
- ❌ `we have to know`（逗號黏連）、`make the endorser a powerful effect`（動詞錯）→ 需要語法手術

同一份 AI 味文稿（`highAI-0983.docx`，原 gen 0.983）跑 4 個候選：

| 候選 | gen | CV | copy | damagePre |
|---|---|---|---|---|
| 1 | 0.567 | 0.390 | 0.05 | 0.220 |
| 2 | **0.201** | 0.533 | 0.03 | 0.189 |
| 3 | 0.935 | 0.331 | 0.06 | 0.189 |
| 4 | 0.974 | 0.393 | 0.08 | 0.054 |

**2 個候選完全沒降（0.935、0.974），1 個降到 0.201。** 這是 routea v2 最重要的特性：
它有能力把 0.983 壓到 0.201，但**只有約 1/4 的採樣會真的做到**。所以要靠多候選 + 選擇，不能單發。

餵**已經像人寫**的文字時，routea v2 **原樣回傳**（條件式改寫，no-op）。這代表：
被 Turnitin 標記但表面讀起來像人寫的段落，routea 幫不上忙。

### routeb v2：改寫幅度大，散文品質較好

同一份客戶文稿（`FINAL WRITTEN ESSAY.docx`）純 routeb v2：

| 指標 | v1（pureB2，Turnitin 42%） | v2 |
|---|---|---|
| copy rate | 0.30 | **0.09–0.24** |
| CV | 0.616 | 0.537 |
| 終評 gen | 0.0195 | **0.016** |
| perplexity | 51.8 | 49.5 |
| 硬語法錯誤 | 3 | **0** |
| 質量軸 | **FAIL** | **PASS** |

## 三、routea v1 是壞的

`routea-qwen35-9b`（v1，80 對訓練 27 步）在同樣的 prompt 下會把**思考過程**寫出來：

> Hmm, the user wants me to rewrite a paragraph to sound like a genuine university student
> writing an academic essay, while keeping the same content...

它沒有學會「直接輸出改寫結果」，而是把推理鏈當成答案。**v1 不應再用於生產**；v2 修正了這一點。

## 四、片段級編輯：兩個模型都不擅長

把 Turnitin 標記的**段落中間片段**（不是完整段落）餵給兩個引擎：

- routeb v2：`It doesn't lie, still invites to draw logically unacceptable inference`（逗號黏連、缺冠詞）
- routeb v1：`Credibility is an important component of endorser credibility`（循環定義）
- routea v2：直接原樣回傳（判定為「已像人寫」）

原因：兩者的訓練資料都是**完整段落**，沒有片段樣本。影響：
「只改被標記的那幾句」這種局部編輯模式，現有模型都做不好，需要人工介入或補一類片段級訓練資料。

## 五、部署層面的硬限制

1. **VRAM 互斥**：兩個模型同時載入（6 GB + 6 GB）會把 16 GB 吃滿，速度從 86 tok/s 掉到 5–11 tok/s。
   管線切換引擎時送 `keep_alive:0` 卸載即可；手動 `ollama run` 測試時要自己卸載。
2. **gemma4 在 Vulkan 後端很慢**：routeb v2 只有 3.5 tok/s（同機 Qwen 9B 是 86 tok/s），
   差 24 倍。這是架構在後端的優化程度差異，不是模型壞了。
3. **轉檔不需要 GPU**：merge → f16 GGUF → 套 LoRA → Q5_K_M 全程 CPU-bound，
   用 CPU runtime 就能做（不燒 GPU 配額）。單一模型約 35–45 分鐘。
4. **磁碟是最大殺手**：f16 中間檔（9B 18 GB / 12B 23 GB）加上 base 快取會把 113 GB 吃滿，
   量化到一半就會 `No space left` 而靜默卡死。必須在量化前刪掉 base f16 與 HF 快取。

## 六、選型建議

| 情境 | 用哪個 |
|---|---|
| 學術論證、需要保持語域 | **routeb v2**（唯一選擇，routea 會把論證降級） |
| AI 味重、要偽裝成英文較弱的學生 | routea v2（多候選 + 選擇，單發成功率約 1/4） |
| 只改被標記的幾句 | 兩個都不行，需人工或補片段級資料 |
| 已經像人寫、但 Turnitin 仍標記 | 兩個都幫不上，要靠段落級重構 |
