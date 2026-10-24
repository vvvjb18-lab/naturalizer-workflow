# 學術性修補報告

- 生成時間：2026-10-23 07:08:19
- Humanizer 輸出：humanized.prose.txt
- 原始草稿：original.prose.txt
- 輸出檔：polished.prose.txt
- 模型：deepseek / deepseek-chat
- 語言：en
- 耗時：7 秒

## 結論

**通過：所有硬性檢查正常**

共發現 5 項缺陷（驗證輪另發現 1 項），實際修補 **4** 處，改動 **50.9%** 的字詞（28 字；本次預算 40 字），仍有 **0** 項未自動處理。Humanizer 原有的句長節奏保留率為 55%。

## 硬性檢查

| 檢查 | 結果 | 說明 |
|---|---|---|
| 語言一致 | ✅ | en → en |
| 句長節奏未被抹平 | ✅ | too short to judge (4 sentences, 55 words); CV 0.314 → 0.172 |
| AI 套語未增加 | ✅ | 0 → 0 |
| 沒有新增列表／編號／標題 | ✅ | no new lists/headings |
| 數字完整 | ✅ | all draft numbers present |
| 引用完整 | ✅ | all draft citations present |
| 修改幅度在預算內 | ✅ | 28 words replaced (limit 40; 50.9% of text) |
| 沒有新增重複句 | ✅ | 0 → 0 |
| 結尾完整 | ✅ | ends complete |
| 語域未退步 | ✅ | you/your 0→0, contractions 0→0 |

## 三稿對照（格式核對）

| 指標 | 原文 | Humanizer（A） | 修補後（B） |
|---|---:|---:|---:|
| 字數 | 52 | 55 | 53 |
| 段落 | 3 | 3 | 3 |
| 句數 | 4 | 4 | 4 |
| 平均句長 | 13 | 13.75 | 13.25 |
| 句長變異係數 | 0.18 | 0.314 | 0.172 |
| 列表／編號標記 | 0 | 0 | 0 |
| 數字 | 3 | 3 | 3 |
| 引用標記 | 1 | 1 | 1 |
| 口語詞 | 0 | 0 | 0 |
| 縮寫 | 0 | 0 | 0 |
| 第二人稱 | 0 | 0 | 0 |

> 段落數、句數不同是正常的：Humanizer 會重組句子，修補層不重排段落。要看的是數字、引用、列表／編號標記，以及節奏指標有沒有異常。

**格式核對**
- [ ] 沒有新增 `(1)(2)(3)`、項目符號、Markdown 標題
- [ ] 數字、日期、人名、單位與原文一致
- [ ] 引用標記數量與位置合理
- [ ] 段落沒有被意外合併或拆成清單
- [ ] 句長節奏沒有明顯被抹平（看上面的變異係數）
- [ ] A → B 的每一處改動都能在「修補明細」找到

### 原始草稿
~~~text
Recent studies suggest that remote work may improve employee productivity (Smith & Lee, 2021). However, the effect appears to depend on task type and supervisory support.

In a survey of 412 knowledge workers, 68% reported higher focus at home, yet 41% reported difficulty disconnecting after hours.

These findings indicate that productivity gains are conditional rather than universal.
~~~

### Humanizer 輸出（A）
~~~text
According to recent research, working from home could boost employee productivity (Smith & Lee, 2021). But the results seem to vary based on the type of work and the level of supervision.

412 knowledge workers surveyed: 68% more focused working from home but 41% of people struggle to switch off after work hours.

It shows that productivity improvements are contingent.
~~~

### 修補後（B）
~~~text
According to recent research, working from home could boost employee productivity (Smith & Lee, 2021). However, the effect appears to depend on task type and supervisory support.

In a survey of 412 knowledge workers, 68% reported higher focus at home, yet 41% reported difficulty disconnecting after hours.

These findings indicate that productivity gains are conditional rather than universal.
~~~

## 指標對照（A → B）

| 指標 | Humanizer 輸出 | 修補後 | 變化 |
|---|---:|---:|---|
| 字數 | 55 | 53 | ↓ |
| 句數 | 4 | 4 |  |
| 平均句長 | 13.75 | 13.25 | ↓ |
| 句長標準差 | 4.323 | 2.278 | ↓ |
| 句長變異係數（節奏） | 0.314 | 0.172 | ↓ |
| 短句比例 | 0.25 | 0 | ↓ |
| 長句比例 | 0 | 0 |  |
| 段落數 | 3 | 3 |  |
| AI 套語 | 0 | 0 |  |
| 口語詞 | 0 | 0 |  |
| 縮寫（don't 等） | 0 | 0 |  |
| 第二人稱 | 0 | 0 |  |
| 問句 | 0 | 0 |  |
| 模糊限制詞 | 2 | 3 | ↑ |
| 結構標記 | 0 | 0 |  |
| 數字 | 3 | 3 |  |
| 引用標記 | 1 | 1 |  |

## 修補明細（4 處）

### 1. [register] major · 第一輪 · 第 1 段 · issue C1
> Replaced conversational opening and vague wording with DRAFT A's formal connective and precise terminology (also addresses M4).

**修改前**
~~~text
But the results seem to vary based on the type of work and the level of supervision.
~~~
**修改後**
~~~text
However, the effect appears to depend on task type and supervisory support.
~~~

### 2. [grammar] critical · 第一輪 · 第 1 段 · issue M1
> Converted fragment into a grammatical sentence with main verbs.

**修改前**
~~~text
412 knowledge workers surveyed: 68% more focused working from home but 41% of people struggle to switch off after work hours.
~~~
**修改後**
~~~text
In a survey of 412 knowledge workers, 68% reported higher focus at home, but 41% reported difficulty switching off after work hours.
~~~

### 3. [meaning] major · 第一輪 · 第 1 段 · issue M2
> Restored the conditional-versus-universal contrast and clear antecedent (also addresses M3).

**修改前**
~~~text
It shows that productivity improvements are contingent.
~~~
**修改後**
~~~text
These findings indicate that productivity gains are conditional rather than universal.
~~~

### 4. [terminology] minor · 監督輪 · 第 1 段 · issue M1
> Restores the author's precise term "disconnecting" and original phrasing "after hours" as a minimal local replacement, keeping the surrounding sentence intact.

**修改前**
~~~text
but 41% reported difficulty switching off after work hours
~~~
**修改後**
~~~text
yet 41% reported difficulty disconnecting after hours
~~~

## 未自動處理（0 項）

（無）

## 人工覆核清單

- [ ] 無需額外處理

## 執行紀錄與錯誤

（無）

---

### 使用提醒

1. 這一步只做「外科修補」，不會重寫未被標記的句子；句長節奏指標若明顯下降，代表模型越界了，請把該次結果退回。
2. 引用與數字以原始草稿為準。工具不會發明引用；未找回的引用列在人工清單。
3. 任何修改都可能改變 Turnitin 分數。交付前請務必重新跑一次正式報告，不要沿用修改前的截圖。
4. 模型編輯具有隨機性；同一份稿件連跑兩次可能得到不同的小修補，屬正常現象。
