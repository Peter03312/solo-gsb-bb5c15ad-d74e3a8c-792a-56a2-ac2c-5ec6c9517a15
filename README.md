# 字幕校时工作台（Subtitle Timing Workbench）

把**逐词转写**（带起止毫秒）与**镜头切点**排版成符合规则的字幕，在浏览器里校对、锁定、确认后导出 **WebVTT**。本地运行：Node.js + Express + SQLite（better-sqlite3）+ 原生前端，无外部服务依赖。

## 功能

- **导入**：逐词转写 `words: [{text, start_ms, end_ms}]` + 镜头切点 `cuts: [ms]`。
  时间无效（开始 ≥ 结束、负值、非整数）或**倒序/重叠**的词段一律**拒绝导入**并逐条说明。
- **排版规则**：单条最大字数、最短显示时长（ms）、每秒最多字数，可随时修改。
- **排版保证**：按原词序覆盖全部词（每词恰好一次）、字幕互不重叠、不跨镜头切点、不缩短任何词本身的时段（只在空闲间隙内向后/向前扩展）。
- **冲突报告**：规则无法同时满足时，列出**受影响词段 + 冲突条件**（如"切点落在词内部"、"可用空间 450ms 小于最短时长 1000ms"），**不输出貌似完整的结果**，也不改动现有字幕。
- **锁定**：已校对的字幕可锁定 🔒，重新排版只改未锁定部分，锁定条原样保留。
- **批量修订提议**：校对者可对**同一项目的一组未锁定字幕**提交待采纳修订（逐项给出字幕 ID、读取时行版本、替代文本、可选起止毫秒、附说明）；**提交只保存原值与当时规则版本，不动正式字幕**。预览并列原值/当前值/建议值，按当前规则核对整组候选（词区间、词时段、切点、相邻字幕、字数/时长/字速），逐处指出冲突；采纳时在**同一事务**内再次核对目标仍存在且未锁定、行版本与规则版本，通过后整版校验并原子写入全部修订、推进字幕集版本——**任一过期或违规则整组不生效**并返回当前值与原因；已采纳提议重复提交不再改字幕，提议历史可查。
- **逐词校时（词时间修正）**：校对者发现逐词转写的时间偏差时，可按**词序号**提交一组起止毫秒修正并携带读取时字幕集版本，**先预览受影响字幕与冲突再确认**。词序与词文本不变；序号不重复、时间非负整数且开始早于结束、修正后全部词仍按序不重叠。**锁定字幕文本与时间原样保留**（修正后词时段须仍被锁定区间容纳，否则定位到词/字幕报错）；未受影响字幕保留 ID、行版本与人工文本，只对受影响的未锁定区间重排，满足词完整覆盖、切点隔离与现行字数/时长/字速规则。确认在**同一事务**内重新读取权威状态再次评估并原子更新词时间、字幕与字幕集版本；**受影响行以新 ID 重建**（引用旧行 ID 的待采纳修订再采纳时会命中"已消失"而不会误采纳）；既有导出快照保持不变。
- **乐观锁**：规则与每条字幕都带版本号，过期提交返回 `409` 与当前内容；字幕集整体有 `sub_version`，重排/导出携带以防并发覆盖。
- **导出**：确认后生成按时间升序的 WebVTT，存为**不可变版本快照**，可随时再次下载；后续修改不影响旧文件。导出前会完整校验（含锁定字幕），违规则拒绝并列出问题。

## 启动

### Docker（推荐，一条命令）

```bash
docker compose up --build
```

Dockerfile 负责安装依赖，启动时自动建表（`src/db.js`），数据库为空且 `SEED_DEMO=true` 时播种一个演示项目（含自动排版结果）。

### 本地开发

```bash
npm ci
npm start          # 或 PORT=8080 DB_PATH=./my.db node server.js
```

### 访问

打开 **http://localhost:3000**（本地 `npm start` 同理；`PORT` 环境变量可改端口）。

### 测试

```bash
npm test           # node:test，覆盖排版引擎与全部 API
```

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | HTTP 端口 |
| `DB_PATH` | `./data/subtitles.db`（容器内 `/data/subtitles.db`） | SQLite 文件路径，启动时自动初始化表结构 |
| `SEED_DEMO` | `true` | 数据库为空时播种"演示项目：江边茶馆"；设 `false` 关闭 |

Compose 默认把 SQLite 挂到命名卷 `subtitle-data` 持久化（含所有导出版本快照）。

## 使用流程

1. **导入**：粘贴 JSON（或点"载入示例"），填项目名则新建项目，留空则导入当前项目（已有字幕时需勾选确认覆盖）。`examples/sample.json` 是同款示例。
2. **设规则**：最大字数 / 最短时长 / 每秒字数 → 保存（版本号 +1）。
3. **排版**：点"重新排版（仅未锁定字幕）"。有冲突时红色面板逐条列出词段与原因，修正数据或放宽规则后重试。
4. **校对**：直接在列表里改文本/时间（保存时校验：不得缩短词时段、不得重叠、不得跨切点），校对好的点"锁定"。
5. **批量修订提议（校对者流程）**：在左侧 ⑤ 面板按 JSON 提交一组修订（或"填入所有行"后删改；只针对未锁定字幕），提交后自动打开预览，逐项并列**原值 / 当前值 / 建议值**并标注每处冲突；全部通过时点"整组采纳"（原子写入，失败整组不生效）。也可用 `examples/revisions-api.sh` 走纯 HTTP 流程。
6. **逐词校时（词时间修正）**：在左侧 ⑥ 面板按词序号提交一组起止毫秒修正（或"填入所有词"后只保留要改的词，自动带当前 `sub_version`），点"预览受影响字幕与冲突"：并列每个词的原/新时间、受影响字幕（🔒锁定原样 / 未锁定将重排）、确认后候选字幕（保留原行 / 重排新行），逐处列出定位到词与字幕的冲突；全部通过后点"确认修正（原子更新）"。纯 HTTP 流程见 `examples/word-corrections-api.sh`。
7. **导出**：点"确认当前字幕并导出 WebVTT"，生成 v1、v2…… 任意版本可随时重新下载。采纳修订或逐词校时均不影响已生成的旧快照。

## API 摘要

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/projects` | 项目列表 |
| `POST` | `/api/projects` | 新建项目（可同时带 `words`/`cuts`/`rules`） |
| `GET` | `/api/projects/:id` | 项目完整数据（词、切点、规则、字幕、导出列表） |
| `POST` | `/api/projects/:id/import` | 替换转写与切点；已有字幕时需 `{"force": true}`（会清空字幕） |
| `PUT` | `/api/projects/:id/rules` | 改规则，需带当前 `version`，过期返回 `409` + 当前规则 |
| `POST` | `/api/projects/:id/layout` | 重排未锁定字幕，需带 `sub_version`；冲突返回 `422` + `conflicts` |
| `PATCH` | `/api/projects/:id/subtitles/:sid` | 编辑/锁定单条，需带行 `version`，过期返回 `409` + 当前行 |
| `POST` | `/api/projects/:id/exports` | 校验并确认导出（可带 `sub_version` 防呆），生成新版本快照 |
| `GET` | `/api/projects/:id/exports` | 导出版本列表 |
| `GET` | `/api/projects/:id/exports/:version` | 下载某版本 `.vtt`（内容创建后不变） |
| `POST` | `/api/projects/:id/revisions` | 提交一组待采纳修订：`{note?, items:[{subtitle_id, cue_version, text, start_ms?, end_ms?}]}`，保存原值/规则版本快照，**不改正式字幕** |
| `GET` | `/api/projects/:id/revisions` | 提议历史（pending/accepted、项数、快照版本） |
| `GET` | `/api/projects/:id/revisions/:rid` | 单个提议：逐项 `orig`（提交时原值）与 `proposed`（建议值，时间为 `null` 表示沿用原值） |
| `POST` | `/api/projects/:id/revisions/:rid/preview` | 只读预览核对：并列原值/当前值/建议值，按整版候选逐处列冲突（`evaluation.items[].conflicts`） |
| `POST` | `/api/projects/:id/revisions/:rid/accept` | 事务内再次核对并原子采纳；过期类（行版本/规则版本/已锁定/已消失/重复采纳）→ `409`，规则/结构违规 → `422`，均带 `current` 与每项 `reasons` |
| `POST` | `/api/projects/:id/word-corrections/preview` | 逐词校时只读预览：`{sub_version, corrections:[{idx,start_ms,end_ms}]}`，返回修正词、受影响字幕（`relayout`/`retain_locked`）、候选整版与冲突；版本过期 `409`，请求非法 `400` |
| `POST` | `/api/projects/:id/word-corrections/confirm` | 事务内再次评估并原子确认：更新词时间、删除受影响未锁定行并以**新 ID** 重排、推进 `sub_version`；冲突 → `422`（词与字幕均不变），版本过期 → `409` |

修订请求与核对说明：

- **提交拒绝（`400`）**：`items` 空组/缺字段、`subtitle_id` 重复、`text` 空、`start_ms/end_ms` 非非负整数或 `start ≥ end`（双侧给出时）。
- **提交状态校验（`422`）**：目标字幕不存在或已锁定；只给单侧时间时与原值合并后仍要求 `start < end`。
- **预览/采纳核对维度**：建议时间合法、不得缩短词区间对应词时段（开始 ≤ 首词开始、结束 ≥ 末词结束）、不与整组应用后的相邻字幕重叠、不跨镜头切点；以及当前规则的字数、最短时长、字速。还会核对行版本（`cue_version`）与规则版本（提交时快照 vs 当前）。
- **采纳原子性**：全部项通过才写入（每行 `version +1`、字幕集 `sub_version +1`、提议标记 `accepted`）；任一项失败整组回滚，响应里只含出问题的项及其 `current` 当前行与中文 `reasons`。
- **重复采纳**：已 `accepted` 的提议再次调用返回 `409 {already_accepted:true}`，不会再改字幕；历史与旧导出快照均可随时回看。
- 完整 curl 调用示例：`examples/revisions-api.sh`（新建项目→提交→预览→非法示例→冲突示例→采纳→重复采纳→历史）。

错误格式统一：`400` 请求非法（修订提交的空组/重复 ID/空文本/非法时间，词修正的缺版本/空组/重复或越界 idx/非法时间等，带 `errors`）；`404` 不存在；`409` 版本过期或重复采纳（带 `current` 与每项 `reasons`）；`422` 校验/冲突失败（带 `errors` 或 `conflicts`，每项含 `word_start`/`word_end` 与中文说明）。

## 排版约束与冲突处理

对每条字幕强制满足：文本 ≤ `max_chars` 字、时长 ≥ `min_duration_ms`、字数/秒 ≤ `max_cps`；
对整版强制满足：词全覆盖且顺序不变、字幕不重叠、不跨切点、词时段不被缩短。
词是不可拆分的最小单元，因此会出现规则确实无法同时满足的情况，例如：

- 切点落在某个词的时段内部（跨切点 ↔ 缩短词时段，二者必违其一）→ 报 `cut_inside_word`；
- 单个词超过最大字数 → 报 `max_chars`；
- 词段太密，最短时长/每秒字数在相邻字幕与切点夹出的空间内放不下 → 报 `duration`（含所需毫秒数与可用空间）。

此时接口返回 `422` 与完整冲突列表，**不写入任何字幕**；调整切点、规则或转写后重新排版即可。

## 批量修订提议（校对 → 预览 → 采纳）

面向校对者的**组级、乐观锁、原子采纳**流程，与既有单条编辑接口并存、互不影响：

1. **提交** `POST /api/projects/:id/revisions`
   `{note?, items:[{subtitle_id, cue_version, text, start_ms?, end_ms?}, ...]}`
   - 仅针对**未锁定**字幕；`start_ms`/`end_ms` 可省略（表示沿用该行当前起止，单侧给出时另一侧也按原值）。
   - 空组、重复 `subtitle_id`、空 `text`、非法时间（非整数、负值、`start ≥ end`）→ `400`，逐项中文说明；目标不存在/已锁定 → `422`。
   - 服务端保存每项的**原值快照**（文本/起止）、行版本 `cue_version` 与当时**规则版本**、字幕集版本；此步**绝不修改正式字幕**。
2. **预览** `POST /api/projects/:id/revisions/:rid/preview`（只读）
   把整组建议应用到当前字幕形成"候选整版"，逐项并列 `orig`（提交时原值）/`cue`（当前行）/`proposed`（建议值），并核对：
   建议时间合法、**词区间**不被缩短（开始 ≤ 首词开始、结束 ≥ 末词结束）、不与候选整版的**相邻字幕**重叠、不跨**镜头切点**、文本字数 ≤ `max_chars`、时长 ≥ `min_duration_ms`、字速 ≤ `max_cps`；
   同时标注行版本过期（`stale`）、规则版本过期、目标已锁定（`locked`）、目标已消失（`missing`）。每处冲突都带中文说明。
3. **采纳** `POST /api/projects/:id/revisions/:rid/accept`
   在**同一个 SQLite 事务**里重新读取权威当前状态并再次执行第 2 步的全部核对，外加写入后的整版结构/规则自检：
   - 全部通过 → 写入全部修订、每行 `version +1`、字幕集 `sub_version +1`、提议置为 `accepted`；
   - 任一过期/失效（行版本、规则版本、已锁定、已消失、重复采纳）→ `409`，带 `current` 当前整版与每项当前值、原因；
   - 任一规则/结构违规 → `422`，同样逐项给出原因；两种失败都**整组不生效（事务回滚）**。
4. **历史** `GET …/revisions`、`GET …/revisions/:rid`：提议与原值快照长期可查；已采纳提议重复 accept 返回 `409 {already_accepted:true}`，不会再改字幕；此前的导出快照内容不变。

前端在左侧 ⑤ 面板可直接提交（"填入所有行"会把未锁定行连同当前行版本生成模板），右侧查看历史、预览差异并一键整组采纳；纯 HTTP 流程见 `examples/revisions-api.sh`。

## 逐词校时（词时间修正：预览 → 确认）

校对者发现**逐词转写本身**的时间偏差（不是字幕排版问题）时，按词序号提交一组起止毫秒修正。与修订提议的区别：修订提议改的是**字幕文本/时间**，本功能改的是**词的时间**，再让受影响字幕区间自动重排。

请求体：

```json
{
  "sub_version": 3,
  "corrections": [
    { "idx": 12, "start_ms": 4800, "end_ms": 5200 },
    { "idx": 13, "start_ms": 5200, "end_ms": 5600 }
  ]
}
```

1. **预览** `POST /api/projects/:id/word-corrections/preview`（只读，`200`）
   `evaluation` 包含：
   - `corrections[]`：逐项并列 `orig`（读取时原起止）与新起止、词文本、是否真的改变；
   - `affected_word_indices`、`affected_cues[]`：受影响字幕及动作——`relayout`（未锁定，将整段删除并以**新 ID** 重排）或 `retain_locked`（锁定，文本与时间原样保留）；
   - `candidate_cues[]`：确认后的候选整版，每条标 `retain`（未受影响行，保留 ID/版本/人工文本）/`retain_locked` /`new`（重排新行）；
   - `conflicts[]`：定位到词（`word_start/word_end`、`corrected_indices`）与字幕（`cue_ids`、`cue_locked`）的中文冲突。
2. **确认** `POST /api/projects/:id/word-corrections/confirm`
   在**同一个 SQLite 事务**里重新读取权威当前状态，再次执行全部核对与排版：
   - 全部通过 → 原子更新词时间；受影响未锁定字幕删除后以新 ID 重排（`version` 从 1 起），未受影响行只更新 `idx`、ID/版本/人工文本不变，锁定行连 `idx` 外的内容都不变；写入后再跑整版结构 + 规则自检（含锁定行），最后 `sub_version +1`。
   - 版本过期 → `409` 带 `current`（当前 `sub_version`/词/字幕）；约束无法兼顾 → `422` 带 `conflicts`，**词与字幕均不变（事务回滚）**。
3. **冲突类型**：
   - `word_order`：修正后相邻词倒序/重叠（定位到两个词与各自所在字幕）；
   - `locked_word_span`：修正后词区间溢出锁定字幕的固定时段（锁定不能改）；
   - 以及排版引擎的 `cut_inside_word` / `duration` / `max_chars` 等，均补充了涉及的修正词与字幕 ID。
4. **请求形状错误 → `400`**：缺/非法 `sub_version`、空组、`idx` 重复或越界、时间非非负整数、`start ≥ end`，逐项中文说明。
5. **与既有数据的关系**：
   - 受影响未锁定行以**新 ID** 重建，因此引用旧行 ID 的待采纳修订提议再采纳时会命中 `subtitle_missing`（`409` 整组不生效），不会误采纳；提议历史仍可查；
   - 此前的**导出快照内容保持不变**（确认接口不写 exports 表）。

前端在左侧 ⑥ 面板提交，"填入所有词"会把全部词当前时间与 `sub_version` 生成模板（删到只剩要改的词即可）；纯 HTTP 流程见 `examples/word-corrections-api.sh`（非法请求、过期、重叠、锁定兼容/溢出、原子确认、重复确认的完整示例）。

## 目录结构

```
server.js            入口：初始化 SQLite、播种演示数据、启动 HTTP
src/db.js            连接与建表（projects/words/shots/rules/subtitles/exports/revisions/revision_items）
src/layout.js        排版引擎（纯函数）：切点分析 → 分段 → 定时 → 结构自检
src/validate.js      导入与编辑校验
src/revision.js      批量修订提议：请求解析 + 整组候选核对（词区间/时间/切点/相邻/规则/版本）
src/word-correction.js 逐词校时：词修正请求解析 + 候选评估（词序/锁定兼容/受影响区间重排）
src/vtt.js           WebVTT 序列化
src/routes.js        Express API
public/              前端（原生 HTML/CSS/JS 单页，含批量修订提议与逐词校时面板）
examples/sample.json 示例转写与切点
examples/revisions-api.sh 批量修订提议的完整 curl 调用示例
examples/word-corrections-api.sh 逐词校时（预览→确认）的完整 curl 调用示例
test/                node:test 单元 + API 集成测试（test/revision.test.js、test/word-correction.test.js）
Dockerfile / docker-compose.yml
```
