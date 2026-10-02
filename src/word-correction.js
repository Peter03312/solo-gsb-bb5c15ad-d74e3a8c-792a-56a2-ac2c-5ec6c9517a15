'use strict';

const { computeLayout } = require('./layout');

/**
 * 逐词校时（词时间修正）：请求解析与候选评估（纯函数，不依赖数据库）。
 *
 * 校对者发现逐词转写的时间偏差时，按词序号提交一组起止毫秒修正：
 *   { sub_version, corrections: [{ idx, start_ms, end_ms }, ...] }
 *
 * 硬性前提：
 *   - 词序、词文本不变；idx 在同一组内不得重复；
 *   - 每项时间为非负整数且 start_ms < end_ms；
 *   - 修正后全部词（含未修正词）仍按序不重叠（允许首尾相接）。
 *
 * 排版处理：
 *   - 锁定字幕文本与时间原样保留；修正后词时段须仍被其锁定区间完整容纳，否则定位到词/字幕报错；
 *   - 未受影响字幕保留 ID、行版本与人工文本；
 *   - 仅对“受影响的未锁定区间”（覆盖词中含修正词的未锁定字幕所占词段）重新排版，
 *     并满足词完整覆盖、切点隔离与现行字数/时长/字速规则；
 *   - 任一约束无法兼顾则返回冲突（定位到词/字幕），词与字幕均不变。
 */

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

const MAX_CORRECTIONS = 200000;

/**
 * 解析并校验请求的“形状”（与项目当前状态无关的部分）：
 * sub_version 整数、corrections 非空数组、idx 非负整数且不重复、
 * 时间为非负整数且 start < end。
 * 返回 { ok, sub_version, corrections, errors }，errors 为中文说明（可直接回 400）。
 */
function parseWordCorrections(body) {
  const errors = [];
  const b = body && typeof body === 'object' ? body : {};
  if (!isInt(b.sub_version) || b.sub_version < 0) {
    errors.push('sub_version（读取时字幕集版本）必须是非负整数');
  }
  const raw = b.corrections;
  if (!Array.isArray(raw)) {
    return { ok: false, sub_version: isInt(b.sub_version) ? b.sub_version : null,
      corrections: [], errors: [...errors, '请求体必须包含 corrections 数组'] };
  }
  if (raw.length === 0) {
    errors.push('修正组为空：corrections 至少包含一项');
  }
  if (raw.length > MAX_CORRECTIONS) {
    errors.push(`修正项 ${raw.length} 超过上限 ${MAX_CORRECTIONS}`);
  }

  const seen = new Set();
  const corrections = [];
  const pushErr = (msg) => { if (errors.length < 20) errors.push(msg); };

  raw.forEach((it, i) => {
    const c = it || {};
    let rowBad = false;
    if (!isInt(c.idx) || c.idx < 0) {
      pushErr(`第 ${i + 1} 项：idx（词序号）必须是非负整数`);
      rowBad = true;
    } else if (seen.has(c.idx)) {
      pushErr(`第 ${i + 1} 项：词序号 ${c.idx} 在同一组内重复`);
      rowBad = true;
    } else {
      seen.add(c.idx);
    }
    if (!isInt(c.start_ms) || c.start_ms < 0) {
      pushErr(`第 ${i + 1} 项（词 ${c.idx}）：start_ms 必须是非负整数毫秒`);
      rowBad = true;
    }
    if (!isInt(c.end_ms) || c.end_ms < 0) {
      pushErr(`第 ${i + 1} 项（词 ${c.idx}）：end_ms 必须是非负整数毫秒`);
      rowBad = true;
    }
    if (isInt(c.start_ms) && isInt(c.end_ms) && c.start_ms >= c.end_ms) {
      pushErr(`第 ${i + 1} 项（词 ${c.idx}）：非法时间 [${c.start_ms}, ${c.end_ms}]，开始必须早于结束`);
      rowBad = true;
    }
    if (!rowBad) corrections.push({ idx: c.idx, start_ms: c.start_ms, end_ms: c.end_ms });
  });

  if (errors.length >= 20 && raw.length > errors.length) {
    errors.push('……错误过多，仅显示前 20 条');
  }
  corrections.sort((a, b) => a.idx - b.idx);
  return {
    ok: errors.length === 0,
    sub_version: isInt(b.sub_version) && b.sub_version >= 0 ? b.sub_version : null,
    corrections,
    errors,
  };
}

/** 找出词区间与 [a, b] 相交的现存字幕 */
function overlappingCues(subtitles, a, b) {
  return subtitles.filter((c) => !(c.word_end < a || c.word_start > b));
}

/** 给排版引擎的冲突补充定位信息：涉及字幕、是否锁定、涉及的修正词 */
function annotate(conflict, subtitles, byIdx) {
  const correctedIndices = [];
  for (let k = conflict.word_start; k <= conflict.word_end; k++) {
    if (byIdx.has(k)) correctedIndices.push(k);
  }
  const cues = overlappingCues(subtitles, conflict.word_start, conflict.word_end);
  return {
    ...conflict,
    corrected_indices: correctedIndices,
    cue_ids: cues.map((c) => c.id),
    cue_locked: cues.some((c) => c.locked === 1),
  };
}

/**
 * 评估一组词时间修正（不写任何数据）。
 * project：loadProject() 完整载荷；corrections：parseWordCorrections 通过的数组。
 * 调用前须保证所有 idx 在 project.words 范围内。
 *
 * 返回：
 *   ok                  是否可确认
 *   corrections[]       逐项并列 orig（原时间）/ 新时间 / text / changed
 *   affected_word_indices
 *   affected_cues[]     受影响字幕：action = 'relayout'（未锁定，将删除重排）
 *                       或 'retain_locked'（锁定，原样保留）
 *   candidate_cues      ok 时的候选整版：retain / retain_locked 行带原 id/version，
 *                       重排产生的新行 id=null/action='new'
 *   conflicts[]         定位到词/字幕的冲突（含 type、中文 message、corrected_indices）
 */
function evaluateWordCorrections({ project, corrections }) {
  const { words, cuts, rules, subtitles } = project;
  const byIdx = new Map(corrections.map((c) => [c.idx, c]));
  const conflicts = [];

  // 1. 把修正应用到词表（只改时间，idx/文本不变）
  const words2 = words.map((w, k) =>
    byIdx.has(k) ? { ...w, start_ms: byIdx.get(k).start_ms, end_ms: byIdx.get(k).end_ms } : w
  );
  const correctionView = corrections.map((c) => ({
    idx: c.idx,
    text: words[c.idx].text,
    orig: { start_ms: words[c.idx].start_ms, end_ms: words[c.idx].end_ms },
    start_ms: c.start_ms,
    end_ms: c.end_ms,
    changed: words[c.idx].start_ms !== c.start_ms || words[c.idx].end_ms !== c.end_ms,
  }));

  const build = (extra = {}) => ({
    ok: conflicts.length === 0,
    corrections: correctionView,
    affected_word_indices: [...byIdx.keys()].sort((a, b) => a - b),
    affected_cues: extra.affectedCues || null,
    candidate_cues: extra.candidate || null,
    conflicts,
  });

  // 2. 修正后全部词按序不重叠：只需检查涉及修正词的相邻对（其余相邻对导入时已保证）
  for (let k = 0; k + 1 < words2.length; k++) {
    if (!byIdx.has(k) && !byIdx.has(k + 1)) continue;
    const a = words2[k];
    const b = words2[k + 1];
    if (a.end_ms > b.start_ms) {
      conflicts.push({
        type: 'word_order',
        word_start: k,
        word_end: k + 1,
        corrected_indices: [k, k + 1].filter((x) => byIdx.has(x)),
        cue_ids: overlappingCues(subtitles, k, k + 1).map((c) => c.id),
        message:
          `修正后词 #${k} "${a.text}" 结束 ${a.end_ms}ms 晚于相邻词 #${k + 1} "${b.text}" ` +
          `开始 ${b.start_ms}ms：修正后全部词仍须按序不重叠（允许首尾相接），词与字幕均未改动`,
      });
    }
  }
  if (conflicts.length > 0) return build(); // 词表本身已倒序，排版无意义，直接退回

  // 3. 受影响字幕：覆盖词中含任一修正词
  const affectedCues = subtitles.filter((cue) => {
    for (let k = cue.word_start; k <= cue.word_end; k++) if (byIdx.has(k)) return true;
    return false;
  }).map((cue) => ({
    id: cue.id,
    idx: cue.idx,
    word_start: cue.word_start,
    word_end: cue.word_end,
    text: cue.text,
    start_ms: cue.start_ms,
    end_ms: cue.end_ms,
    locked: cue.locked,
    version: cue.version,
    action: cue.locked === 1 ? 'retain_locked' : 'relayout',
  }));
  const relayoutIds = new Set(
    affectedCues.filter((c) => c.action === 'relayout').map((c) => c.id)
  );

  // 4. 锁定字幕兼容：锁定时段必须原样且仍能完整容纳修正后的词区间
  for (const cue of affectedCues.filter((c) => c.action === 'retain_locked')) {
    let needS = Infinity;
    let needE = -Infinity;
    const correctedHere = [];
    for (let k = cue.word_start; k <= cue.word_end; k++) {
      needS = Math.min(needS, words2[k].start_ms);
      needE = Math.max(needE, words2[k].end_ms);
      if (byIdx.has(k)) correctedHere.push(k);
    }
    if (cue.start_ms > needS || cue.end_ms < needE) {
      conflicts.push({
        type: 'locked_word_span',
        word_start: cue.word_start,
        word_end: cue.word_end,
        corrected_indices: correctedHere,
        cue_ids: [cue.id],
        cue_locked: true,
        message:
          `锁定字幕 #${cue.idx + 1}（ID ${cue.id}）"${cue.text}" 的文本与时间 ` +
          `[${cue.start_ms}, ${cue.end_ms}] 必须原样保留，但修正后其词区间要求被 ` +
          `[${needS}, ${needE}] 完整包含，二者无法兼顾；请调整词修正或先解锁该字幕`,
      });
    }
  }

  // 5. 只重排受影响的未锁定区间：其余现存字幕（含未受影响行与全部锁定行）作为固定边界
  const fixed = subtitles
    .filter((c) => !relayoutIds.has(c.id))
    .map((c) => ({
      word_start: c.word_start, word_end: c.word_end, text: c.text,
      start_ms: c.start_ms, end_ms: c.end_ms,
    }));
  const result = computeLayout({ words: words2, cuts, rules, locked: fixed });

  if (!result.ok) {
    // 锁定容纳不下已由 locked_word_span 明确报告，去重排版引擎同区间的兜底条目
    const lockedSpans = new Set(
      conflicts
        .filter((c) => c.type === 'locked_word_span')
        .map((c) => `${c.word_start}:${c.word_end}`)
    );
    for (const cf of result.conflicts) {
      if (cf.type === 'word_span_shortened' &&
          lockedSpans.has(`${cf.word_start}:${cf.word_end}`)) continue;
      conflicts.push(annotate(cf, subtitles, byIdx));
    }
    return build({ affectedCues });
  }

  // 6. 组装候选整版：保留行带原 ID/版本（人工文本与时间不变），重排新行 id=null
  const retainedByRange = new Map(
    subtitles.filter((c) => !relayoutIds.has(c.id))
      .map((c) => [`${c.word_start}:${c.word_end}`, c])
  );
  const candidate = result.cues.map((cue, i) => {
    const hit = retainedByRange.get(`${cue.word_start}:${cue.word_end}`);
    if (hit) {
      return {
        id: hit.id, version: hit.version, idx: i,
        word_start: cue.word_start, word_end: cue.word_end,
        text: cue.text, start_ms: cue.start_ms, end_ms: cue.end_ms,
        locked: hit.locked,
        action: hit.locked === 1 ? 'retain_locked' : 'retain',
      };
    }
    return {
      id: null, version: null, idx: i,
      word_start: cue.word_start, word_end: cue.word_end,
      text: cue.text, start_ms: cue.start_ms, end_ms: cue.end_ms,
      locked: 0, action: 'new',
    };
  });

  return build({ affectedCues, candidate });
}

module.exports = { parseWordCorrections, evaluateWordCorrections, MAX_CORRECTIONS, isInt };
