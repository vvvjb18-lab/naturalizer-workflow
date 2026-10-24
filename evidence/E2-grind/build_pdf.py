# -*- coding: utf-8 -*-
"""Build the unified E2-grind evidence PDF.

Output: E2-grind-evidence-report.pdf
Structure: cover (template 01) + body (overview/evidence 1-4/appendix A)
           + appendix dividers + original artifacts (Turnitin PDFs, trio PDFs).
"""
import json
import os
import subprocess
import sys

PDF_SKILL_DIR = r"C:/Users/YIVH/.zcode/cli/plugins/cache/zcode-plugins-official/pdf/0.2.2/skills/pdf"
sys.path.insert(0, os.path.join(PDF_SKILL_DIR, "scripts"))

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (BaseDocTemplate, Frame, PageTemplate, Paragraph,
                                Spacer, Table, TableStyle, Preformatted, Image,
                                KeepTogether)
from reportlab.lib.styles import ParagraphStyle
from pypdf import PdfReader, PdfWriter

EV = r"F:/Humanizer/pipeline/v6-test/evidence-E2"
OUT = os.path.join(EV, "E2-grind-evidence-report.pdf")

pdfmetrics.registerFont(TTFont("MSYaHei", "C:/Windows/Fonts/msyh.ttc", subfontIndex=0))
pdfmetrics.registerFont(TTFont("SimHei", "C:/Windows/Fonts/simhei.ttf"))

INK = colors.HexColor("#1a2332")
MUT = colors.HexColor("#5b6570")
PRI = colors.HexColor("#25476a")
BG = colors.HexColor("#f2f1ef")
LINE = colors.HexColor("#d8d6d2")

W, H = A4
M = 18 * mm
AVAIL = W - 2 * M

S = {
    "h1": ParagraphStyle("h1", fontName="SimHei", fontSize=17, leading=24, textColor=PRI,
                          spaceBefore=6, spaceAfter=8),
    "h2": ParagraphStyle("h2", fontName="SimHei", fontSize=12.5, leading=18, textColor=INK,
                          spaceBefore=10, spaceAfter=5),
    "body": ParagraphStyle("body", fontName="MSYaHei", fontSize=9.5, leading=15.5, textColor=INK,
                            wordWrap="CJK", spaceAfter=5),
    "small": ParagraphStyle("small", fontName="MSYaHei", fontSize=8, leading=12, textColor=MUT,
                             wordWrap="CJK"),
    "cell": ParagraphStyle("cell", fontName="MSYaHei", fontSize=8.5, leading=12.5, textColor=INK,
                            wordWrap="CJK"),
    "cellc": ParagraphStyle("cellc", fontName="MSYaHei", fontSize=8.5, leading=12.5, textColor=INK,
                             wordWrap="CJK", alignment=1),
    "log": ParagraphStyle("log", fontName="Courier", fontSize=7.8, leading=10.5, textColor=INK),
}


def P(t, st="body"):
    return Paragraph(t, S[st])


def tbl(data, widths, header=True, align_center_cols=()):
    rows = []
    for ri, row in enumerate(data):
        cells = []
        for ci, cell in enumerate(row):
            if ri == 0 and header:
                cells.append(Paragraph(str(cell), S["cellc"]))
            else:
                st = "cellc" if ci in align_center_cols else "cell"
                cells.append(Paragraph(str(cell), S[st]))
        rows.append(cells)
    t = Table(rows, colWidths=widths, hAlign="CENTER", repeatRows=1 if header else 0)
    style = [
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 3.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3.5),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("GRID", (0, 0), (-1, -1), 0.4, LINE),
    ]
    if header:
        style += [("BACKGROUND", (0, 0), (-1, 0), PRI),
                  ("TEXTCOLOR", (0, 0), (-1, 0), colors.white)]
        for i in range(1, len(rows)):
            if i % 2 == 0:
                style.append(("BACKGROUND", (0, i), (-1, i), BG))
    t.setStyle(TableStyle(style))
    return t


story = []

# ── 0 概覽 ────────────────────────────────────────────────────────────────
story.append(P("案例概覽", "h1"))
story.append(P(
    "本報告將 <b>E2-grind</b> 案例的四項技術證據統一封存為單一 PDF：Turnitin 原件、"
    "原稿／A稿／B稿三件套、grind 執行日誌、校準集數據。E2 為 Workflow 7.5 的紅區打通案例——"
    "正式語域議論文（糖稅主題、APA 引用、統計數據），經「6 候選生成 × 段落重組 X × LT 語法層 × "
    "段級研磨 grind」後送檢，<b>Turnitin AI 0%／查重 13%／0 integrity flags</b>。"
))
story.append(Spacer(1, 4))
story.append(tbl([
    ["項目", "內容"],
    ["文稿", "E2_argument_essay（自製仿學生議論文：641 詞、4 組 APA 引用、統計數據）"],
    ["配方", "v6 ideal 6 候選（數字斗篷）→ 重組 X（cand{5,4,5,5,1,1}）→ LT → grind 3 輪 → docx"],
    ["檢測碼", "F20A277274（5 碼中的第 3 個；站方每碼限用 1 次）"],
    ["Submission ID", "trn:oid:::26334:304157451"],
    ["送檢時間", "2026-10-24 13:31（本地）；報告元數據 11:01 AM GMT+5:30"],
    ["結果", "AI 0%（明確數字）· 查重 13%（9% 網路＋4% 出版物）· 0 Integrity Flags"],
    ["離線體檢", "p_ai_gen 0.175（A）→ 0.030（B）· EditLens delta +0.001 · CV 0.374→0.567→0.621"],
], [0.22 * AVAIL, 0.78 * AVAIL]))
story.append(Spacer(1, 8))

story.append(P("檢測碼帳本", "h2"))
story.append(tbl([
    ["#", "碼", "用途", "結果"],
    ["1", "213029C321", "H2（拖延文 · evolve 種子14）", "<20% AI／查重 1%／0 flags"],
    ["2", "7070EADB0A", "H4（拖延文 · 生產 A＋LT）", "<20% AI／查重 3%／0 flags"],
    ["3", "F20A277274", "<b>E2-grind（本報告案例）</b>", "<b>0% AI／13%／0 flags</b>"],
    ["4", "B398E0B859", "保留", ""],
    ["5", "05B0C1E1EB", "保留", ""],
], [0.06 * AVAIL, 0.24 * AVAIL, 0.42 * AVAIL, 0.28 * AVAIL], align_center_cols=(0,)))
story.append(Spacer(1, 8))

story.append(P("證據索引", "h2"))
story.append(tbl([
    ["證據", "正文位置", "原件位置"],
    ["① Turnitin PDF 原件", "第 2 節（摘要＋截圖）", "附錄 B（AI 報告 4 頁）／附錄 C（查重 5 頁）"],
    ["② 三件套 docx", "第 3 節（指標與對照）", "附錄 D／E／F（Word 轉 PDF）；原 docx 見證據包 02_docx/"],
    ["③ 執行 Terminal Log", "第 4 節（grind 全量逐行）", "附錄 A SHA256 可核驗；原檔 03_logs/"],
    ["④ 校準集 calibration.json", "第 5 節（15 點摘要表）", "完整 JSON 在證據包 04_metrics/"],
], [0.26 * AVAIL, 0.32 * AVAIL, 0.42 * AVAIL]))
story.append(Spacer(1, 6))
story.append(P(
    "完整性聲明：所有數字均由管線原始產出檔案或打包時的重新實測得來，無事後修改。"
    "兩項如實披露事項——(1) calibration.json 曾於 13:37 因寫入中斷損壞（H4 與 E2-grind 兩點間缺一逗號），"
    "打包時僅補回分隔符修復，損壞原件保留為 calibration.json.bak-corrupt；(2) grind 的 stdout 即 "
    "queue.log 所錄（無另一份 terminal scrollback）。", "small"))

# ── 1 Turnitin ────────────────────────────────────────────────────────────
story.append(P("證據①：Turnitin 原件摘要", "h1"))
story.append(tbl([
    ["報告", "關鍵數字", "明細"],
    ["AI Writing（附錄 B）", "<b>0% detected as AI</b>", "0 AI-generated 0%；低於 20% 門檻時本可不顯示，本例為明確 0%"],
    ["Similarity（附錄 C）", "<b>13% Overall</b>", "Not Cited or Quoted 9%／Missing Quotations 4%；來源 9% 網路＋4% 出版物＋0% 論文庫"],
    ["Integrity Flags", "<b>0</b>", "「No suspicious text manipulations found」——數字斗篷與研磨未留操縱指紋"],
], [0.24 * AVAIL, 0.24 * AVAIL, 0.52 * AVAIL]))
story.append(Spacer(1, 6))
story.append(P("turnitai.club 提交記錄頁截圖（顯示 E2-grind.docx 已完成、送檢 13:32:59）", "h2"))
img = Image(os.path.join(EV, "01_turnitin", "turnitai-submission-page.png"), width=0.62 * AVAIL,
            height=0.62 * AVAIL * 565 / 900, kind="proportional")
img.hAlign = "CENTER"
story.append(img)
story.append(Spacer(1, 4))
story.append(P("截圖由瀏覽器於打包時重新開啟該提交記錄頁取得；PNG 原件 SHA256 見附錄 A。", "small"))

# ── 2 三件套 ──────────────────────────────────────────────────────────────
story.append(P("證據②：三件套（原稿／A稿／B稿）", "h1"))
story.append(P(
    "三件套的 Word 原檔（.docx）隨證據包交付（02_docx/，SHA256 見附錄 A），供評估端在 Word 中"
    "直接比對。本節給出同 daemon 重測的量化指標；三份文檔的 PDF 渲染附於附錄 D／E／F。"
))
story.append(tbl([
    ["指標", "原稿", "A 稿（v6 選擇）", "B 稿（grind 送檔）"],
    ["p_ai_gen（tmr/RAID）", "0.240", "0.175", "<b>0.030</b>"],
    ["p_ai_edit（EditLens）", "0.148", "0.145", "0.146"],
    ["perplexity（GPT-2）", "21.7", "25.6", "30.5"],
    ["CV（句長變異係數）", "0.374", "0.567", "0.621"],
    ["句子數／詞數", "17／419", "24／487", "27／542"],
], [0.30 * AVAIL, 0.22 * AVAIL, 0.24 * AVAIL, 0.24 * AVAIL], align_center_cols=(1, 2, 3)))
story.append(Spacer(1, 6))
story.append(P("評估端關注的兩個衍生指標（daemon 實測）", "h2"))
story.append(tbl([
    ["指標", "數值", "門檻／參考", "解讀"],
    ["EditLens Delta（A→B）", "<b>+0.001</b>", "advisory 0.1（歷史失敗值 +0.09）", "研磨全走本機 hz，無 API 修訂訊號"],
    ["CV 保留率（B/A）", "<b>1.095</b>", "≥1.05（低於即 6.0 的 56% 特徵）", "節奏未被磨平，反略升"],
    ["CV 保留率（B/原稿）", "1.66", "≥1.1（永不比原稿平滑）", "遠高於安全線"],
], [0.26 * AVAIL, 0.14 * AVAIL, 0.28 * AVAIL, 0.32 * AVAIL], align_center_cols=(1,)))
story.append(Spacer(1, 6))
story.append(P("grind 段落級戰績（B 稿的構成過程，詳細日誌見證據③）", "h2"))
story.append(tbl([
    ["段落", "研磨前", "研磨後", "輪次"],
    ["p2（論證主體段）", "0.977", "<b>0.050</b>", "round 2"],
    ["p6（結論段）", "0.956", "<b>0.127</b>", "round 3"],
    ["p4", "0.977", "0.664", "round 2"],
    ["p3", "0.911", "0.740", "round 1+3 兩次改善"],
    ["p5", "0.981", "0.958（殘餘）", "round 2"],
    ["p1／p5 殘餘", "0.96", "0.96（未突破）", "標題段與引言段"],
], [0.30 * AVAIL, 0.20 * AVAIL, 0.26 * AVAIL, 0.24 * AVAIL], align_center_cols=(1, 2)))
story.append(Spacer(1, 4))
story.append(P(
    "註：段落分數為逐段單獨過 tmr 的尺度（短文本會嚴重膨脹，全段落在 0.82–0.98），僅供相對比較；"
    "驗收一律以整份尺度（B 稿 0.030）為準。", "small"))

# ── 3 Log ─────────────────────────────────────────────────────────────────
story.append(P("證據③：grind 執行 Terminal Log（全量）", "h1"))
story.append(P(
    "以下為 queue.log 中 12:55:19–13:05:26 的完整逐行記錄（27 行，未刪節）。數字斗篷的還原過程"
    "體現為：重寫文本必須通過驗證（數字／引用全在位）才計成功；佔位符被 hz 改壞時以 "
    "「failed validation」拒絕重試（共 4 次：round1 p5、round2 p5、round2 p2、round3 p3）。"
    "✓ 標記替換為 [OK] 以適配等寬字體。"
))
log_path = os.path.join(EV, "03_logs", "E2-grind-rounds.log")
log_text = open(log_path, encoding="utf-8").read().replace("✓", "[OK]")
story.append(Preformatted(log_text, S["log"]))
story.append(Spacer(1, 4))
story.append(P(
    "指令：node grind.mjs &lt;workDir&gt; &lt;candX.prose.txt&gt; &lt;out&gt; en 3（gain 0.02、"
    "NLI 矛盾&gt;0.5 拒收、溫度梯 1.0/1.1/0.95）。統計：20 次重生嘗試＝成功 7＋no-gain 9＋驗證拒絕 4。", "small"))

# ── 4 校準集 ──────────────────────────────────────────────────────────────
story.append(P("證據④：calibration.json 校準集（15 點摘要）", "h1"))
story.append(P(
    "完整 JSON（15 點／15 課）隨證據包交付（04_metrics/）。下表為數據點摘要，用於評估離線評分器"
    "（tmr/EditLens/perplexity/CoLA/CV）與 Turnitin 實測的檔位規律。"
))
cal = json.load(open(os.path.join(EV, "04_metrics", "calibration.json"), encoding="utf-8"))
rows = [["數據點", "Turnitin", "CV", "p_ai_gen", "ppl"]]
for p_ in cal["points"]:
    rows.append([
        p_.get("name", ""),
        str(p_.get("turnitin", "")),
        f"{p_.get('cv', 0):.3f}" if isinstance(p_.get("cv"), (int, float)) else "",
        f"{p_.get('p_ai_gen', 0):.3f}" if isinstance(p_.get("p_ai_gen"), (int, float)) else "",
        f"{p_.get('ppl', 0):.1f}" if isinstance(p_.get('ppl'), (int, float)) else "",
    ])
story.append(tbl(rows, [0.34 * AVAIL, 0.22 * AVAIL, 0.14 * AVAIL, 0.16 * AVAIL, 0.14 * AVAIL],
                 align_center_cols=(2, 3, 4)))
story.append(Spacer(1, 4))
story.append(P(
    "檔位規律：gen≤0.05 → &lt;20%（H2 0.031／H4 0.048／E2-grind 0.030）；gen 0.24＋API 潤飾 → 29%（final6.1）；"
    "gen 0.26+ 的 form/report 候選一律不予送檢。離線門檻 ≤0.10 為送檢紀律。", "small"))

# ── 5 附錄 A：SHA256 ──────────────────────────────────────────────────────
story.append(P("附錄A：證據檔案 SHA256", "h1"))
story.append(P("所有原件的 SHA-256（打包時計算）。附錄 B–F 為各原件的逐頁 PDF 嵌入。", "body"))
story.append(tbl([
    ["檔案", "SHA-256"],
    ["01_turnitin/E2-grind_AI.pdf", "0a0d2226c507f0784e94294bfee548a857c9a5b6aa86147aa62898c378dc2cf2"],
    ["01_turnitin/E2-grind_similarity.pdf", "661b240ed9a667e4bcf1d0dd38c356d1d3262cfefa5953ba2641f178e9c755f5"],
    ["01_turnitin/turnitai-submission-page.png", "85eb4542c3bbc214146a126c5467c172895c60035c9e2eac308635f1f0f9c22d"],
    ["02_docx/E2_original.docx", "2e611f169874ed3f321dbe0efb3aa4cd88b920751f81980f7fcd11472beb2896"],
    ["02_docx/E2_A_v6-selection.docx", "a1b3f0ce5a516d20121e5b71aabbc4079959dd9a15e88e3ad5324cc1885c7baa"],
    ["02_docx/E2_B_grind-delivery.docx", "174f4fff263280416286c7c9191dda35560bbbc02ec0ceaa325ddfd9f61971f4"],
    ["03_logs/E2-grind-rounds.log", "f33d3bd59fef66ca34808b398c79cf02d16820cb936f1750687e2a499acff455"],
    ["04_metrics/calibration.json", "64335aaaab5992892c3629286df23b6bf04b4bb00d63cca5fade65462de7a7eb"],
], [0.42 * AVAIL, 0.58 * AVAIL]))

# ── build body ────────────────────────────────────────────────────────────
def on_page(canv, doc):
    canv.saveState()
    canv.setFont("MSYaHei", 7.5)
    canv.setFillColor(MUT)
    canv.drawString(M, 10 * mm, "E2-grind 技術證據報告 · 內部評估用 · 2026-10-24")
    canv.drawRightString(W - M, 10 * mm, f"{doc.page}")
    canv.setStrokeColor(LINE)
    canv.setLineWidth(0.4)
    canv.line(M, 13 * mm, W - M, 13 * mm)
    canv.restoreState()


body_path = os.path.join(EV, "_body.pdf")
doc = BaseDocTemplate(body_path, pagesize=A4, leftMargin=M, rightMargin=M,
                      topMargin=16 * mm, bottomMargin=17 * mm,
                      title="E2-grind 技術證據報告", author="Z.ai")
frame = Frame(M, 17 * mm, AVAIL, H - 16 * mm - 17 * mm, id="f")
doc.addPageTemplates([PageTemplate(id="p", frames=[frame], onPage=on_page)])
doc.build(story)

# ── appendix dividers ─────────────────────────────────────────────────────
def divider(title, subtitle, out):
    d = BaseDocTemplate(out, pagesize=A4, leftMargin=M, rightMargin=M,
                        topMargin=60 * mm, bottomMargin=20 * mm,
                        title="E2-grind 技術證據報告", author="Z.ai")
    f = Frame(M, 20 * mm, AVAIL, H - 80 * mm, id="f")
    d.addPageTemplates([PageTemplate(id="p", frames=[f])])
    d.build([
        Paragraph(title, ParagraphStyle("t", fontName="SimHei", fontSize=22, leading=30, textColor=PRI)),
        Spacer(1, 10),
        Paragraph(subtitle, ParagraphStyle("s2", fontName="MSYaHei", fontSize=10, leading=16,
                                            textColor=MUT, wordWrap="CJK")),
    ])


div_specs = [
    ("_divB.pdf", "附錄 B：Turnitin AI 報告原件", "E2-grind_AI.pdf · 4 頁 · SHA256 0a0d2226…c2cf2 · Submission ID trn:oid:::26334:304157451"),
    ("_divC.pdf", "附錄 C：Turnitin 查重報告原件", "E2-grind_similarity.pdf · 5 頁 · SHA256 661b240e…c755f5 · 13% Overall Similarity"),
    ("_divD.pdf", "附錄 D：原稿（E2_original.docx → PDF）", "SHA256 2e611f16…b2896 · Word 原檔隨證據包 02_docx/ 交付"),
    ("_divE.pdf", "附錄 E：A 稿（v6 選擇 → PDF）", "E2_A_v6-selection.docx → PDF · SHA256 a1b3f0ce…c7baa · 重組X＋LT"),
    ("_divF.pdf", "附錄 F：B 稿（grind 送檔本 → PDF）", "E2-grind.docx → PDF · SHA256 174f4fff…971f4 · 即 Turnitin 送檔內容"),
]
for fn, t, sub in div_specs:
    divider(t, sub, os.path.join(EV, fn))

# ── cover ─────────────────────────────────────────────────────────────────
content = {
    "kicker": "INTERNAL TECHNICAL ASSESSMENT",
    "hero": "E2-grind 技術證據報告",
    "summary": "Workflow 7.5 紅區案例（正式議論文）四項證據統一封存：Turnitin 原件、三件套對照、"
               "grind 執行日誌、校準集數據。Turnitin AI 0%／查重 13%／0 integrity flags。",
    "meta": "2026-10-24 · Humanizer Workflow 7.5\nSubmission trn:oid:::26334:304157451 · 碼 F20A277274",
}
cpath = os.path.join(EV, "_cover_content.json")
json.dump(content, open(cpath, "w", encoding="utf-8"), ensure_ascii=False)
cover_path = os.path.join(EV, "_cover.pdf")
r = subprocess.run([sys.executable, os.path.join(PDF_SKILL_DIR, "scripts", "cover_render.py"),
                    "01", "--out", cover_path, "--content", cpath],
                   capture_output=True, text=True, encoding="utf-8")
if r.returncode != 0:
    print("cover_render failed:", r.stdout[-400:], r.stderr[-400:])
    sys.exit(1)

# ── merge ─────────────────────────────────────────────────────────────────
w = PdfWriter()
parts = [("_cover.pdf", 0), ("_body.pdf", None)] + [(f, None) for f, _, _ in div_specs]
append_map = [
    ("_divB.pdf", "01_turnitin/E2-grind_AI.pdf"),
    ("_divC.pdf", "01_turnitin/E2-grind_similarity.pdf"),
    ("_divD.pdf", "02_docx/E2_original.pdf"),
    ("_divE.pdf", "02_docx/E2_A_v6-selection.pdf"),
    ("_divF.pdf", "02_docx/E2_B_grind-delivery.pdf"),
]
w.append(cover_path)
w.append(body_path)
page_total = len(PdfReader(cover_path).pages) + len(PdfReader(body_path).pages)
for div_f, artifact in append_map:
    w.append(os.path.join(EV, div_f))
    w.append(os.path.join(EV, artifact))
    page_total += 1 + len(PdfReader(os.path.join(EV, artifact)).pages)

w.add_metadata({
    "/Title": "E2-grind 技術證據報告（Turnitin 0% AI 案例封存）",
    "/Author": "Z.ai",
    "/Creator": "Humanizer Workflow 7.5 evidence packager",
    "/Subject": "E2-grind case: Turnitin AI 0% / similarity 13% / 0 flags — unified evidence",
})
with open(OUT, "wb") as fh:
    w.write(fh)
print("built:", OUT)
print("pages:", len(PdfReader(OUT).pages))
