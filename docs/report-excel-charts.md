> **Status (2026-10-29): switched off.** The product now sends the Excel workbook as raw data only; the charts live in the PDF report. The code described here is kept and still tested (`buildDashboardWorkbook` in `report-workbook.ts` builds the charted version), so turning it back on is a one-line change in `buildReportWorkbook`.

# How the cost report gets its Excel charts

*Written 2026-10-28. Covers the Dashboard sheet of the cost report (download and email). Code:
`packages/server/src/services/{report-workbook,report-dashboard,report-charts,zip-lite}.ts`.*

This document explains two things, in this order:

1. **What an `.xlsx` file really is** — a zip file made of XML files. Everything else follows from this.
2. **How we put native charts into one** — step by step, with the reasons for each choice.

---

## Part 1 — An Excel file is a zip of XML files

### 1.1 The one-line version

An `.xlsx` file is a **zip archive**. Inside the archive are many small **XML text files**. Excel opens the zip, reads
the XML files, and draws what they describe: the cells, the sheet names, the colours, the charts.

You can check this yourself. Copy any `.xlsx`, rename the copy to `.zip`, and open it with any zip tool (or run
`unzip report.xlsx -d out/`). You will see folders and `.xml` files, not a binary blob.

This format is called **OOXML** (Office Open XML). Microsoft defined it, and it is an open standard
(ECMA-376 / ISO 29500). It is the same idea behind `.docx` and `.pptx`.

### 1.2 What is XML?

XML is plain text that describes things with tags, like HTML does for web pages:

```xml
<sheet name="Dashboard" sheetId="1"/>
<c r="A1" t="s"><v>0</v></c>
```

A tag opens (`<chart>`), holds something, and closes (`</chart>`). Tags can nest. A file is "well-formed" when every
tag that opens is closed in the right order and special characters are escaped (`&` must be written `&amp;`).
Excel is **strict** about this: one badly formed file and it shows *"We found a problem with some content… Do you want
us to try to recover?"* — and usually drops the thing that was wrong (for us, a chart).

### 1.3 Why a zip of many files, not one file?

A workbook has many independent parts (each sheet, the styles, each chart, each picture). Splitting them lets a tool
read or change one part without touching the rest, and zip compresses them. The parts are joined by **relationship
files** (`.rels`) that say "this part points at that part".

### 1.4 What is inside a plain workbook

This is what SheetJS writes for a workbook with sheets and cells and **no** charts (simplified):

```
report.xlsx  (a zip)
├── [Content_Types].xml          ← a list: "files ending .xml of this kind are a worksheet, that kind a theme…"
├── _rels/
│   └── .rels                    ← "the main document of this package is xl/workbook.xml"
└── xl/
    ├── workbook.xml             ← the list of sheets: Dashboard, Workspaces, Workflows, People, Runs
    ├── _rels/
    │   └── workbook.xml.rels    ← "sheet with id rId1 is the file worksheets/sheet1.xml"
    ├── styles.xml               ← number formats, fonts, fills
    ├── sharedStrings.xml        ← the text values, stored once and referenced by number
    ├── theme/theme1.xml         ← the colour theme
    └── worksheets/
        ├── sheet1.xml           ← Dashboard: the rows and cells
        ├── sheet2.xml           ← Workspaces
        ├── sheet3.xml           ← Workflows
        ├── sheet4.xml           ← People
        └── sheet5.xml           ← Runs
```

What the key files do:

| File | Job |
| :--- | :--- |
| `[Content_Types].xml` | The package's table of contents by **type**. Excel refuses a part whose type it was not told about. |
| `_rels/.rels` and `*.rels` | Links between parts. XML files do not point at each other directly; a `.rels` file next to each part holds its links (`Id`, `Type`, `Target`). |
| `xl/workbook.xml` | The sheets, in order, each with a name and a link id. |
| `xl/worksheets/sheetN.xml` | One sheet. Inside `<sheetData>` are `<row>`s of `<c>` cells, each with an address (`r="C62"`) and a value. |
| `xl/styles.xml` | How numbers look (for example `0.00##`, `#,##0`, `0.0%`). |

A single cell looks like this in `sheet1.xml`:

```xml
<row r="8">
  <c r="A8" s="1"><v>10</v></c>     <!-- A8 holds the number 10, formatted with style 1 -->
</row>
```

### 1.5 What a chart adds

A chart is **more parts plus links**. Added to the zip:

```
xl/
├── drawings/
│   ├── drawing1.xml             ← WHERE each chart sits on the sheet, and how big
│   └── _rels/drawing1.xml.rels  ← links the drawing to each chart file
├── charts/
│   ├── chart1.xml               ← the chart itself: type, title, colours, axes, and WHICH CELLS it reads
│   ├── chart2.xml
│   └── … chart6.xml
└── worksheets/
    └── _rels/sheet1.xml.rels    ← links the Dashboard sheet to its drawing
```

plus two edits to files that already exist: one `<drawing r:id="…"/>` line at the end of `sheet1.xml`, and new entries
in `[Content_Types].xml`.

The chain of links is:

```
sheet1.xml  ──(<drawing r:id>)──►  sheet1.xml.rels  ──►  drawing1.xml
drawing1.xml  ──(r:id per chart)──►  drawing1.xml.rels  ──►  chart1.xml … chart6.xml
```

### 1.6 The most important idea: a chart stores addresses, not numbers

`chart1.xml` does not contain the numbers it draws. It contains **cell addresses**:

```xml
<c:cat><c:strRef><c:f>Dashboard!$A$99:$A$101</c:f> … </c:strRef></c:cat>   <!-- the labels -->
<c:val><c:numRef><c:f>Dashboard!$C$99:$C$101</c:f> … </c:numRef></c:val>   <!-- the numbers -->
```

Excel reads those cells whenever it opens the file. So:

- the chart is **live** — if a recipient edits a cost in the table, the bar moves;
- the number beside a bar is always the number the bar is;
- the chart can only draw what is in cells, which is why the Dashboard has a table of numbers under the charts.

Inside each reference there is also a **cache** (`<c:strCache>`, `<c:numCache>`): a copy of the values at the time the
file was made. Excel recalculates from the cells; the cache is for viewers that do not recalculate (preview panes,
some web viewers), so they still draw something.

---

## Part 2 — How we create the charts

### 2.1 Why we write the XML ourselves

The workbook is built with **SheetJS community edition** (`xlsx` 0.20.3). It writes cells and sheets, but **it cannot
write charts** — that is a paid SheetJS Pro feature. Every method of making Excel charts ends up writing the same
chart XML; the question was only *who writes it*:

| Option | Who writes the chart XML | Why we did / did not choose it |
| :--- | :--- | :--- |
| **Our own code** (chosen) | `report-charts.ts` | No new dependency, no licence, no new runtime. Tested. |
| Python XlsxWriter | The library | Best-in-class, but the server image has **no Python** and the server deliberately spawns **no subprocesses** (D-28). Would add a runtime, a dependency and a boundary. |
| SheetJS Pro | The library | Paid. |
| A Node chart library | The library | None found that is maintained and covers the chart types needed (`exceljs`, for one, cannot write charts). |

If many more chart types are wanted later (combo charts, scatter, secondary axes), revisit this — a library starts to
pay for itself there.

### 2.2 The pipeline

```
ReportRun rows (already filtered by the drill)
        │
        ▼
 summarise()                         report.service.ts   — the same numbers the screen shows
        │
        ▼
 buildDashboard()                    report-dashboard.ts — rows of numbers + a "recipe" per chart
        │
        ▼
 SheetJS write()                     report-workbook.ts  — a normal .xlsx, cells only
        │
        ▼
 addCharts()                         report-charts.ts    — open the zip, add chart parts, close it
        │
        ▼
 final .xlsx  →  download  /  email attachment
```

Both the download route (`routes/reports.ts`) and the email (`report-share.service.ts`) call the same
`buildReportWorkbook()`, so they produce the same file.

### 2.3 Step 1 — the layout and the recipes (`report-dashboard.ts`)

`buildDashboard()` lays the Dashboard sheet out from the top:

```
rows 1–5     header: Cost report · Period · Workspaces · Filters · Prepared by
row  7–8     key figures: Total cost (USD) · Runs · Cost / run · Tokens · People
row  9       note: "Cost is model (LLM) spend only…"
rows 11–58   (empty cells — the six charts are drawn over this area)
rows 60+     the numbers behind the charts, one table after another:
               Cost and tokens per day · Cost by kind · Cost by workspace
               · Top workflows by cost · Cost per person
```

While it appends each table it records **where the table landed** (first row, last row). It then creates one
**`ChartSpec`** per chart — a plain description, no XML yet:

```ts
{
  kind: "bar",
  title: "Cost by workspace (USD)",
  cats: { col: 0, first: 98, last: 100 },        // labels:  column A, rows 99–101
  series: [{ vals: { col: 2, first: 98, last: 100 }, values: [6, 4] }],   // numbers: column C
  at: { col: 0, row: 26, widthPx: 600, heightPx: 300 },                   // where on the sheet
}
```

The six charts, two per band, left then right:

| Band | Left | Right |
| :--- | :--- | :--- |
| 1 | Cost per day (columns) | Cost by kind (doughnut) |
| 2 | Cost by workspace (ranked bar) | Top workflows by cost (ranked bar) |
| 3 | Cost per person (ranked bar) | Tokens in and out per day (stacked columns) |

Rules built into the layout:

- **Top 10 + Other.** A ranked chart shows the first `TOP_N` (10) rows and one `Other (N more)` row that sums the rest,
  so the chart stays readable and the total stays true.
- **Empty is still a chart.** A chart cannot be given an empty range, so an empty table gets one row,
  `(no usage in this period)`, with zeros.
- **A quiet day is a row of zeros**, not a gap (that comes from `summarise()`).
- **Filters flow through** because `buildDashboard()` only sees the runs the drill left, and it prints the filter words
  in the header.
- **Number formats** are set on the cells (`0.00##` for cost, `#,##0` for tokens, `0.0%` for shares); the values stay
  numbers, so a recipient can sum them.

### 2.4 Step 2 — a plain workbook (SheetJS)

`report-workbook.ts` turns the rows into a sheet (`utils.aoa_to_sheet`), sets column widths, applies the number
formats, adds the four data sheets (Workspaces, Workflows, People, Runs), and calls `write(wb, { type: "buffer" })`.
The result is a valid workbook **with no charts**.

### 2.5 Step 3 — opening the zip (`zip-lite.ts`)

There is no zip library in the server, and none was added. `zip-lite.ts` is a small reader and writer on Node's
built-in `zlib`:

- **`readZip(buffer)`** finds the zip's *end record*, reads the *central directory* (the authoritative list of
  files), and inflates each file into a `Map<name, Buffer>`. It handles the two methods a workbook uses (stored and
  deflate) and refuses encrypted, zip64 and unknown-method archives by name.
- **`writeZip(map)`** deflates each file, computes its CRC-32, and writes the local headers, the central directory and
  the end record. Timestamps are fixed (1980-01-01) so the same input gives the same bytes.

A `Map` keeps insertion order, which matters: `[Content_Types].xml` stays first.

### 2.6 Step 4 — finding the Dashboard sheet's file (`sheetPartOf`)

It is **not assumed** to be `sheet1.xml`. The code reads `xl/workbook.xml`, finds the `<sheet name="Dashboard" r:id="rIdN">`
tag, then looks `rIdN` up in `xl/_rels/workbook.xml.rels` to get the real file path.

### 2.7 Step 5 — writing the chart XML (`chartXml`)

One `chartN.xml` per `ChartSpec`. The skeleton, shortened:

```xml
<c:chartSpace>
  <c:chart>
    <c:title> … "Cost by workspace (USD)" … </c:title>
    <c:plotArea>
      <c:barChart>
        <c:barDir val="bar"/>                      <!-- bar = horizontal, col = vertical -->
        <c:grouping val="clustered"/>              <!-- or "stacked" -->
        <c:ser>                                    <!-- one data series -->
          <c:tx>  → the series name (a header cell)
          <c:spPr> → its colour
          <c:cat> → Dashboard!$A$99:$A$101  (+ cached labels)
          <c:val> → Dashboard!$C$99:$C$101  (+ cached numbers)
        </c:ser>
        <c:axId val="111111"/><c:axId val="222222"/>
      </c:barChart>
      <c:catAx> … the label axis … </c:catAx>
      <c:valAx> … the number axis … </c:valAx>
    </c:plotArea>
    <c:legend> … (only for stacked and doughnut) … </c:legend>
  </c:chart>
</c:chartSpace>
```

Kinds and what differs:

| Kind | XML difference |
| :--- | :--- |
| `column` | `barDir="col"`, one series |
| `bar` | `barDir="bar"`; the category axis is reversed (`orientation="maxMin"`) so the **largest bar is at the top**, and the value axis is moved back to the bottom (`crosses="max"`) |
| `stacked` | `grouping="stacked"` and `overlap="100"`, two series (tokens in / out), legend shown |
| `doughnut` | `<c:doughnutChart>`, one coloured point per slice, percentage labels, legend on the right, no axes |

Deliberately plain: no 3-D, no combo axes, no extension elements — the shapes Excel desktop and Excel for the web both
draw without argument. Text from the data (a workflow name) goes through `xmlEscape`, which escapes `& < > "` and
**removes characters XML 1.0 cannot carry at all**; a name such as `Chase <b>&"x"` therefore cannot break the file.

### 2.8 Step 6 — placing the charts (`drawingXml`)

`xl/drawings/drawing1.xml` holds one anchor per chart:

```xml
<xdr:oneCellAnchor>
  <xdr:from><xdr:col>0</xdr:col> … <xdr:row>26</xdr:row> …</xdr:from>   <!-- top-left corner: column A, row 27 -->
  <xdr:ext cx="5715000" cy="2857500"/>                                   <!-- size in EMU: 600 × 300 px -->
  <xdr:graphicFrame> … <c:chart r:id="rId3"/> … </xdr:graphicFrame>      <!-- which chart file -->
</xdr:oneCellAnchor>
```

(1 pixel = 9,525 EMU, Excel's drawing unit.) The geometry:

- Column A is 30 characters wide (215 px); B–E are 14 (103 px each). Columns A–E are therefore 627 px wide, so the
  right-hand chart starts at column F, with a 27 px gap after a 600 px chart.
- A chart is 300 px = 15 default rows tall; bands are 16 rows apart, so charts in different bands never touch.
- The first table starts below the last band, so no chart covers a number. A test asserts this.

### 2.9 Step 7 — the links and the two edits

1. `xl/drawings/_rels/drawing1.xml.rels` — one relationship per chart (`rId1` → `../charts/chart1.xml`, …).
2. `xl/worksheets/_rels/sheet1.xml.rels` — links the sheet to `../drawings/drawing1.xml`. If this file already exists
   the code adds a relationship with an unused id; if not, it creates the file.
3. `sheet1.xml` — one `<drawing r:id="…"/>` element is inserted. XML order matters here: `drawing` must come **after**
   `<sheetData>` and the page margins, and **before** `legacyDrawing`, `tableParts` or `extLst` if any exist. The code
   inserts it before the first of those, or before `</worksheet>`.
4. `[Content_Types].xml` — adds one `Override` for the drawing and one per chart, naming their types.

### 2.10 Step 8 — closing the zip

`writeZip()` compresses the whole map back into one `Buffer`. That buffer is the final `.xlsx`: returned to the browser
as a download, or attached to the email.

### 2.11 Why it is safe to change, and how it is checked

The tests (`report-charts.test.ts`) check the properties that matter:

| Check | What it protects against |
| :--- | :--- |
| Zip round-trip is byte-for-byte for every part | Corrupting the workbook while reading and re-writing it |
| Six charts, one drawing, every link target exists | A missing link — Excel's "repair" prompt |
| Every XML part is well-formed | An unclosed tag or a bare `&` |
| `<drawing>` appears exactly once, after `<sheetData>`, and its link resolves | Wrong element order |
| **Each chart's cached numbers equal the cells it points at** | A chart that disagrees with the table beside it. A control moves the reference by one row and requires the comparison to fail. |
| Charts do not overlap each other or the first table | A chart covering numbers |
| The filter reaches charts, numbers and header together | A filtered report that still shows other workspaces |
| 14 workflows → 10 rows + "Other" with an unchanged total | A ranked chart that loses cost |
| Empty report and single-day report | A crash on thin data |
| A workflow named with markup | Broken XML from user-typed text |

Each check was proven able to fail by breaking the code on purpose (drifting the cached values; breaking the sheet
link) and watching a test go red. A separate reader (Python `openpyxl`) was also used, once, to open a generated
40-run sample: it parsed all six charts with the correct types, positions and cell ranges.

### 2.12 What is **not** verified

- The file has **not been opened in real Excel or Excel for the web** by the implementer — there was no Excel or
  LibreOffice available. `openpyxl` accepting it is strong evidence, not proof. **Open one generated report in both
  Excel desktop and Excel web before relying on it**; if Excel shows a repair message, the message and the file are
  what is needed to fix it.
- Chart styling (colours, sizes, fonts) is set in code and has not been judged by eye.
- On the web page `/reports` the charts are not mirrored; only the Excel file has these six.

---

## Part 3 — How to change it

**Add a seventh chart.** In `buildDashboard()`: add (or reuse) a table so the numbers are in cells, then push one more
`ChartSpec` pointing at those cells and give it a slot. If it should sit in a new band, raise `BAND_ROWS`-based layout
(`CHARTS_TOP + BAND_ROWS * 3` → `* 4`) so the tables move down, and update the "no chart covers the first table" test.
`report-charts.ts` itself needs no change for an existing kind.

**Add a new kind of chart** (for example a line chart). Add the kind to `ChartKind`, add its `<c:lineChart>` block in
`chartXml()` following the element order of the OOXML schema, and add a test that its output is well-formed and its
references resolve. Element **order** inside chart XML is fixed by the schema — Excel rejects a correct element in the
wrong place.

**Change a colour.** `CHART_COLORS` in `report-charts.ts`, or `color` on a series.

**Change how many items a ranked chart lists.** `TOP_N` in `report-dashboard.ts` (the test reads the constant, so it
follows).

**Look inside a generated file.**

```bash
mkdir /tmp/out && cd /tmp/out
unzip ~/Downloads/cost-report_….xlsx
ls xl/charts xl/drawings
cat xl/charts/chart3.xml        # one chart, as Excel reads it
```

**Things to keep true.**

- Chart references must point at real cells. A chart over an empty range is an invalid file, which is why an empty
  table gets one placeholder row.
- Text from the data must go through `xmlEscape`. A new place that writes a name into XML without it reintroduces the
  "repair" prompt for any workflow with an `&` in its name.
- No new dependency was added on purpose (`zip-lite.ts` uses only `node:zlib`). Think before adding one.
