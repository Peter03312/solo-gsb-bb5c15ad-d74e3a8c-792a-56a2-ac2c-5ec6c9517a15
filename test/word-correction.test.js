'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initDb } = require('../src/db');
const { createApp } = require('../src/routes');

let server;
let base;

before(async () => {
  const db = initDb(':memory:');
  const app = createApp(db);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function api(path, method = 'GET', body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

const GOOD_WORDS = [
  { text: '你好', start_ms: 0, end_ms: 500 },
  { text: '世界', start_ms: 550, end_ms: 1000 },
  { text: '欢迎', start_ms: 1500, end_ms: 2000 },
  { text: '光临', start_ms: 2050, end_ms: 2500 },
];

async function setup(rules) {
  const { status, body } = await api('/api/projects', 'POST', {
    name: '词修正测试', words: GOOD_WORDS, cuts: [1200], rules,
  });
  assert.equal(status, 201, JSON.stringify(body));
  const layout = await api(`/api/projects/${body.id}/layout`, 'POST', { sub_version: 0 });
  assert.equal(layout.status, 200, JSON.stringify(layout.body));
  return { project: body, cues: layout.body.subtitles, sub_version: layout.body.sub_version };
}

// ---------- 请求形状 ----------

test('形状：缺 sub_version / 空组 / 重复 idx / 非法时间 → 400', async () => {
  const { project: p } = await setup();
  const url = `/api/projects/${p.id}/word-corrections/preview`;

  const noVer = await api(url, 'POST', { corrections: [{ idx: 0, start_ms: 0, end_ms: 400 }] });
  assert.equal(noVer.status, 400);
  assert.ok(noVer.body.errors.some((e) => e.includes('sub_version')));

  const empty = await api(url, 'POST', { sub_version: 0, corrections: [] });
  assert.equal(empty.status, 400);
  assert.match(empty.body.errors.join(), /空/);

  const dup = await api(url, 'POST', { sub_version: 0, corrections: [
    { idx: 1, start_ms: 0, end_ms: 100 },
    { idx: 1, start_ms: 0, end_ms: 100 },
  ] });
  assert.equal(dup.status, 400);
  assert.ok(dup.body.errors.some((e) => e.includes('重复')));

  const badTime = await api(url, 'POST', { sub_version: 0, corrections: [
    { idx: 0, start_ms: 500, end_ms: 400 },
  ] });
  assert.equal(badTime.status, 400);
  assert.ok(badTime.body.errors.some((e) => e.includes('开始必须早于结束')));

  const negative = await api(url, 'POST', { sub_version: 0, corrections: [
    { idx: 0, start_ms: -1, end_ms: 400 },
  ] });
  assert.equal(negative.status, 400);

  const nonInt = await api(url, 'POST', { sub_version: 0, corrections: [
    { idx: 1.5, start_ms: 0, end_ms: 400 },
  ] });
  assert.equal(nonInt.status, 400);

  const outOfRange = await api(url, 'POST', { sub_version: 0, corrections: [
    { idx: 99, start_ms: 0, end_ms: 400 },
  ] });
  assert.equal(outOfRange.status, 400);
  assert.ok(outOfRange.body.errors.some((e) => e.includes('超出转写范围')));
});

// ---------- 预览（只读） ----------

test('预览：并列修正词/受影响字幕/候选整版，不改动任何数据', async () => {
  const { project: p, cues, sub_version } = await setup();
  const r = await api(`/api/projects/${p.id}/word-corrections/preview`, 'POST', {
    sub_version,
    corrections: [
      { idx: 2, start_ms: 1550, end_ms: 2000 },
      { idx: 3, start_ms: 2050, end_ms: 2450 },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ev = r.body.evaluation;
  assert.equal(ev.ok, true);
  assert.deepEqual(ev.affected_word_indices, [2, 3]);
  // 只有第二条字幕（词 2..3）受影响
  assert.deepEqual(ev.affected_cues.map((c) => c.id), [cues[1].id]);
  assert.equal(ev.affected_cues[0].action, 'relayout');
  // 候选：第一条保留原 ID，第二条标记为重排新行
  assert.equal(ev.candidate_cues[0].id, cues[0].id);
  assert.equal(ev.candidate_cues[0].action, 'retain');
  assert.equal(ev.candidate_cues[1].id, null);
  assert.equal(ev.candidate_cues[1].action, 'new');
  // 只读：正式词与字幕未变
  const fresh = (await api(`/api/projects/${p.id}`)).body;
  assert.equal(fresh.words[2].start_ms, 1500);
  assert.equal(fresh.sub_version, sub_version);
});

test('预览：修正后词倒序/重叠 → word_order 冲突定位到词与字幕', async () => {
  const { project: p, cues, sub_version } = await setup();
  const r = await api(`/api/projects/${p.id}/word-corrections/preview`, 'POST', {
    sub_version,
    corrections: [
      { idx: 1, start_ms: 550, end_ms: 900 },
      { idx: 2, start_ms: 800, end_ms: 2000 },
    ],
  });
  assert.equal(r.status, 200);
  const ev = r.body.evaluation;
  assert.equal(ev.ok, false);
  const c = ev.conflicts.find((x) => x.type === 'word_order');
  assert.ok(c, JSON.stringify(ev.conflicts));
  assert.deepEqual(c.corrected_indices.sort(), [1, 2]);
  assert.ok(c.cue_ids.includes(cues[0].id) && c.cue_ids.includes(cues[1].id));
});

test('预览：sub_version 过期 → 409 带当前值', async () => {
  const { project: p, sub_version } = await setup();
  const r = await api(`/api/projects/${p.id}/word-corrections/preview`, 'POST', {
    sub_version: sub_version + 1,
    corrections: [{ idx: 0, start_ms: 0, end_ms: 400 }],
  });
  assert.equal(r.status, 409);
  assert.equal(r.body.current.sub_version, sub_version);
  assert.ok(r.body.current.words && r.body.current.subtitles);
});

// ---------- 确认（原子写入） ----------

test('确认：原子更新词时间；未受影响行保留 ID/版本/人工文本，受影响行换新 ID，版本推进', async () => {
  const { project: p, cues, sub_version } = await setup();
  // 先把第一条字幕的人工文本改掉（验证未受影响行人工文本保留）
  const edit = await api(`/api/projects/${p.id}/subtitles/${cues[0].id}`, 'PATCH', {
    version: cues[0].version, text: '人工改过的你好世界',
  });
  assert.equal(edit.status, 200);
  const sv = edit.body.sub_version;

  const r = await api(`/api/projects/${p.id}/word-corrections/confirm`, 'POST', {
    sub_version: sv,
    corrections: [
      { idx: 2, start_ms: 1550, end_ms: 2000 },
      { idx: 3, start_ms: 2050, end_ms: 2450 },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.sub_version, sv + 1);
  // 旧的受影响行 ID 被删除（新行新 ID）
  assert.deepEqual(r.body.deleted_cue_ids, [cues[1].id]);
  const kept = r.body.subtitles.find((s) => s.id === cues[0].id);
  assert.ok(kept, '未受影响行必须保留原 ID');
  assert.equal(kept.version, 2, '未受影响行版本不变（人工编辑后为 v2）');
  assert.equal(kept.text, '人工改过的你好世界', '未受影响行人工文本保留');
  assert.equal(kept.start_ms, 0);
  assert.equal(kept.end_ms, 1000);
  const replacement = r.body.subtitles.find((s) => s.word_start === 2);
  assert.notEqual(replacement.id, cues[1].id, '受影响行必须以新 ID 重建');
  assert.equal(replacement.version, 1);
  assert.equal(replacement.start_ms, 1550);
  assert.equal(replacement.end_ms, 2450);
  // 词表更新
  assert.deepEqual(
    r.body.words.map((w) => [w.start_ms, w.end_ms]),
    [[0, 500], [550, 1000], [1550, 2000], [2050, 2450]]
  );
  // 结构不变量：覆盖、不重叠、首尾相接允许
  let prevEnd = -1;
  for (const c of r.body.subtitles) {
    assert.ok(c.start_ms >= prevEnd);
    prevEnd = c.end_ms;
  }
});

test('确认：冲突时整体回滚，词与字幕均不变（422）', async () => {
  const { project: p, sub_version } = await setup();
  const before = await api(`/api/projects/${p.id}`);
  const r = await api(`/api/projects/${p.id}/word-corrections/confirm`, 'POST', {
    sub_version,
    corrections: [
      { idx: 1, start_ms: 550, end_ms: 900 },
      { idx: 2, start_ms: 800, end_ms: 2000 },
    ],
  });
  assert.equal(r.status, 422);
  assert.ok(r.body.conflicts.some((c) => c.type === 'word_order'));
  assert.ok(r.body.current);
  const after = await api(`/api/projects/${p.id}`);
  assert.equal(after.body.sub_version, before.body.sub_version);
  assert.deepEqual(
    after.body.words.map((w) => [w.start_ms, w.end_ms]),
    before.body.words.map((w) => [w.start_ms, w.end_ms])
  );
});

test('确认：sub_version 过期 → 409 且不写入', async () => {
  const { project: p, sub_version } = await setup();
  const r = await api(`/api/projects/${p.id}/word-corrections/confirm`, 'POST', {
    sub_version: sub_version + 5,
    corrections: [{ idx: 0, start_ms: 0, end_ms: 400 }],
  });
  assert.equal(r.status, 409);
  assert.equal(r.body.current.sub_version, sub_version);
  const fresh = await api(`/api/projects/${p.id}`);
  assert.equal(fresh.body.words[0].end_ms, 500);
});

// ---------- 锁定字幕 ----------

test('锁定：修正词仍被锁定区间容纳时，锁定行文本/时间/ID/版本原样', async () => {
  const { project: p, cues, sub_version } = await setup();
  const lock = await api(`/api/projects/${p.id}/subtitles/${cues[1].id}`, 'PATCH', {
    version: cues[1].version, locked: true, text: '锁定的欢迎光临',
  });
  assert.equal(lock.status, 200);
  // 词2 提前开始、词3 提前结束（二者首尾相接），仍在 [1500,2500] 内
  const r = await api(`/api/projects/${p.id}/word-corrections/confirm`, 'POST', {
    sub_version: lock.body.sub_version,
    corrections: [
      { idx: 2, start_ms: 1600, end_ms: 2050 },
      { idx: 3, start_ms: 2050, end_ms: 2400 },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.deleted_cue_ids, [], '锁定行不删除重排');
  const locked = r.body.subtitles.find((s) => s.id === cues[1].id);
  assert.equal(locked.locked, 1);
  assert.equal(locked.text, '锁定的欢迎光临');
  assert.equal(locked.start_ms, 1500);
  assert.equal(locked.end_ms, 2500);
  assert.equal(locked.version, cues[1].version + 1, '锁定行版本不被校时推进');
});

test('锁定：修正后词区间溢出锁定时段 → locked_word_span 定位到词/字幕', async () => {
  const { project: p, cues, sub_version } = await setup();
  await api(`/api/projects/${p.id}/subtitles/${cues[1].id}`, 'PATCH', {
    version: cues[1].version, locked: true,
  });
  const r = await api(`/api/projects/${p.id}/word-corrections/confirm`, 'POST', {
    sub_version: sub_version + 1,
    corrections: [{ idx: 3, start_ms: 2050, end_ms: 2700 }],
  });
  assert.equal(r.status, 422);
  const c = r.body.conflicts.find((x) => x.type === 'locked_word_span');
  assert.ok(c, JSON.stringify(r.body.conflicts));
  assert.deepEqual(c.corrected_indices, [3]);
  assert.deepEqual(c.cue_ids, [cues[1].id]);
  assert.equal(c.cue_locked, true);
});

// ---------- 重排分段与规则 ----------

test('重排：修正词改变密度后按现行规则重新分段（max_chars 拆行）', async () => {
  // 6 个词、无切点；先用宽松规则排成一行，再收紧 max_chars 后校词触发重排
  const words = [
    { text: '甲乙丙', start_ms: 0, end_ms: 500 },
    { text: '丁', start_ms: 550, end_ms: 900 },
    { text: '戊', start_ms: 950, end_ms: 1300 },
    { text: '己', start_ms: 1350, end_ms: 1700 },
    { text: '庚', start_ms: 1750, end_ms: 2100 },
    { text: '辛', start_ms: 2150, end_ms: 2500 },
  ];
  const create = await api('/api/projects', 'POST', {
    name: '分段', words, cuts: [],
    rules: { max_chars: 30, min_duration_ms: 0, max_cps: 200 },
  });
  const pid = create.body.id;
  const layout = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: 0 });
  assert.equal(layout.body.subtitles.length, 1);
  const ruleUp = await api(`/api/projects/${pid}/rules`, 'PUT', {
    version: 1, max_chars: 3, min_duration_ms: 0, max_cps: 200,
  });
  assert.equal(ruleUp.status, 200);
  // 不动现存字幕，仅修正一个词（落在唯一字幕内）→ 该未锁定区间按 max_chars=3 重排
  const r = await api(`/api/projects/${pid}/word-corrections/confirm`, 'POST', {
    sub_version: layout.body.sub_version,
    corrections: [{ idx: 1, start_ms: 560, end_ms: 900 }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.subtitles.length >= 2, '应按 max_chars 拆成多行');
  for (const cue of r.body.subtitles) assert.ok(cue.text.length <= 3);
  // 词全覆盖
  const covered = new Array(6).fill(0);
  for (const c of r.body.subtitles) for (let k = c.word_start; k <= c.word_end; k++) covered[k]++;
  assert.deepEqual(covered, [1, 1, 1, 1, 1, 1]);
});

test('规则冲突：修正后夹出的空间放不下最短时长 → 422 duration，且不写入', async () => {
  // 初始宽松规则 + 切点 1200：两条字幕。随后收紧规则 max_chars=2/min_duration=800（不重排），
  // 再把 4 个词整体压到 700ms 以内（切点 1200 落到全部词之后不再强制断行）：
  // 重排按 max_chars=2 切成 [0..1]/[2..3]，第一段需要 800ms，但第二段首词 600ms 开始，
  // 可用空间仅 600ms → duration 冲突，整组不写入。
  const { project: p, sub_version } = await setup();
  const ruleUp = await api(`/api/projects/${p.id}/rules`, 'PUT', {
    version: p.rules.version, max_chars: 4, min_duration_ms: 800, max_cps: 200,
  });
  assert.equal(ruleUp.status, 200);
  const r = await api(`/api/projects/${p.id}/word-corrections/confirm`, 'POST', {
    sub_version,
    corrections: [
      { idx: 0, start_ms: 0, end_ms: 50 },
      { idx: 1, start_ms: 50, end_ms: 100 },
      { idx: 2, start_ms: 600, end_ms: 650 },
      { idx: 3, start_ms: 650, end_ms: 700 },
    ],
  });
  assert.equal(r.status, 422, JSON.stringify(r.body));
  const c = r.body.conflicts.find((x) => x.type === 'duration');
  assert.ok(c, JSON.stringify(r.body.conflicts.map((x) => x.type)));
  assert.deepEqual(c.corrected_indices, [0, 1]);
  assert.match(c.message, /800ms/);
  // 整组回滚：词时间不变
  const fresh = await api(`/api/projects/${p.id}`);
  assert.equal(fresh.body.words[0].end_ms, 500);
  assert.equal(fresh.body.sub_version, sub_version);
});

test('切点隔离：修正后切点落在词内部 → cut_inside_word 定位到词/字幕', async () => {
  const { project: p, sub_version } = await setup();
  const r = await api(`/api/projects/${p.id}/word-corrections/preview`, 'POST', {
    sub_version,
    corrections: [{ idx: 1, start_ms: 1100, end_ms: 1300 }], // 含切点 1200
  });
  assert.equal(r.body.evaluation.ok, false);
  assert.ok(r.body.evaluation.conflicts.some((c) =>
    c.type === 'cut_inside_word' && c.corrected_indices.includes(1)));
});

// ---------- 与修订提议 / 导出快照的关系 ----------

test('校词换 ID 后，引用旧行 ID 的待采纳修订不会被误采纳（409）', async () => {
  const { project: p, cues, sub_version } = await setup();
  const rev = await api(`/api/projects/${p.id}/revisions`, 'POST', {
    items: [{ subtitle_id: cues[1].id, cue_version: cues[1].version, text: '欢迎光临改' }],
  });
  assert.equal(rev.status, 201);
  const cc = await api(`/api/projects/${p.id}/word-corrections/confirm`, 'POST', {
    sub_version,
    corrections: [{ idx: 2, start_ms: 1550, end_ms: 2000 }, { idx: 3, start_ms: 2050, end_ms: 2450 }],
  });
  assert.equal(cc.status, 200);
  assert.ok(cc.body.deleted_cue_ids.includes(cues[1].id));

  const acc = await api(`/api/projects/${p.id}/revisions/${rev.body.id}/accept`, 'POST', {});
  assert.equal(acc.status, 409);
  assert.ok((acc.body.items || []).some((i) => i.state === 'missing'));
  // 提议历史仍可查
  const hist = await api(`/api/projects/${p.id}/revisions`);
  assert.equal(hist.body[0].status, 'pending');
});

test('既有导出快照在校词后保持不变', async () => {
  const { project: p, sub_version } = await setup();
  const e1 = await api(`/api/projects/${p.id}/exports`, 'POST', { sub_version });
  assert.equal(e1.status, 201);
  const before = (await api(`/api/projects/${p.id}/exports/1`)).body;

  await api(`/api/projects/${p.id}/word-corrections/confirm`, 'POST', {
    sub_version,
    corrections: [{ idx: 0, start_ms: 0, end_ms: 450 }],
  });
  const after = (await api(`/api/projects/${p.id}/exports/1`)).body;
  assert.equal(after, before, '旧导出快照不可变');
});

test('未受影响区间不重排：仅修正某条字幕内的词时，其他行连文本都完全一致', async () => {
  const { project: p, cues, sub_version } = await setup();
  const r = await api(`/api/projects/${p.id}/word-corrections/confirm`, 'POST', {
    sub_version,
    corrections: [{ idx: 0, start_ms: 10, end_ms: 500 }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // 第一条受影响换新 ID；第二条原 ID、原版本、原文、原时间
  const second = r.body.subtitles.find((s) => s.word_start === 2);
  assert.equal(second.id, cues[1].id);
  assert.equal(second.version, cues[1].version);
  assert.equal(second.text, cues[1].text);
  assert.equal(second.start_ms, cues[1].start_ms);
  assert.equal(second.end_ms, cues[1].end_ms);
  // 词0 被更新且未缩短其所在字幕的词时段（新行 start<=10, end>=500）
  const first = r.body.subtitles.find((s) => s.word_start === 0);
  assert.ok(first.start_ms <= 10 && first.end_ms >= 500);
});
