/**
 * Campus Policy Agent V1.0 — 规划器（零依赖 / 确定性）
 *
 * plan(question, kb) -> AnswerEnvelope.plan = {
 *   intent, missing_info, planned_sources, sub_queries
 * }
 *
 * 同时导出 analyzeQuestion()：把"边界判定"的中间结果（越界 / 模糊 / 实时性 /
 * 多意图 / 诱导编造）交给 compose 与 workflow 复用。
 */

import { INTENT, INTENT_VALUES, TIER_ORDER } from './constants.mjs';
import {
  AMBIGUOUS_TOPICS, DYNAMIC_HARD_RES, DYNAMIC_SOFT_RES, INTENT_HINTS, OUT_OF_SCOPE_RULES,
  STRONG_CONNECTORS, TOPIC_TERMS, TOPIC_TO_TIER, WEAK_CONNECTORS,
} from './lexicon.mjs';
import { normalizeQuestion, uniq } from './text.mjs';
import { analyzeTerms } from './retrieve.mjs';

/** 主意图识别（8 类枚举，多意图单独判定） */
export function classifyIntent(question) {
  const q = String(question == null ? '' : question);
  for (const h of INTENT_HINTS) {
    if (h.patterns.some((re) => re.test(q))) return h.intent;
  }
  return INTENT.EXPLAIN;
}

export function detectOutOfScope(question) {
  const q = String(question == null ? '' : question);
  for (const rule of OUT_OF_SCOPE_RULES) {
    const hits = rule.patterns.filter((re) => re.test(q)).map((re) => re.source);
    if (hits.length) {
      return {
        hit: true,
        kind: rule.kind,
        patterns: hits,
        channel: rule.channel,
        conclusion: rule.conclusion,
      };
    }
  }
  return { hit: false, kind: '', patterns: [], channel: '', conclusion: '' };
}

function hasTopic(seg) {
  return TOPIC_TERMS.filter((t) => seg.includes(t));
}

function splitOn(text, connector) {
  if (!text.includes(connector)) return [text];
  return text.split(connector);
}

function splitAny(text, re) {
  return text.split(re);
}

function tidySegment(seg) {
  return String(seg)
    .replace(/^[，,。；;、\s]+/, '')
    .replace(/(请问|我想问一下|我想问|想问一下|想问|帮我看看|帮我看下|麻烦问一下|麻烦问下|咨询一下|了解一下)/g, '')
    .replace(/[，,。；;、\s]+$/, '')
    .trim();
}

const ASPECT_RE = /(怎么办|怎么办理|如何办理|怎么申请|如何申请|流程|步骤|手续|材料|条件|资格|时间|时限|费用|收费|多少钱|是什么|哪些|哪里|多久|规定|要求|能不能|是否|可以吗|怎么弄|办理)/;

function ensureAspect(seg) {
  return ASPECT_RE.test(seg) ? seg : `${seg} 怎么办`;
}

/**
 * 多意图切分：只有"两侧都能各自定位到一个领域主题"才切。
 * 目的：不要把一个"退学 + 需要什么材料"的单意图问题误判成多意图。
 */
export function splitMultiIntent(question) {
  const q = normalizeQuestion(question);
  if (!q) return [];
  let parts = [q];
  const applySplit = (fn) => {
    const next = [];
    for (const p of parts) next.push(...fn(p));
    parts = next.map(tidySegment).filter((s) => s.length >= 2);
  };
  // 1) 强连接词
  applySplit((p) => {
    let segs = [p];
    for (const c of STRONG_CONNECTORS) segs = segs.flatMap((s) => splitOn(s, c));
    return segs;
  });
  const distinctTopics = (segs) => {
    const topics = new Set();
    for (const s of segs) {
      const t = hasTopic(s);
      if (!t.length) return null;
      topics.add(t[0]);
    }
    return topics.size >= 2 ? segs : null;
  };
  let multi = distinctTopics(parts);
  if (multi) return multi.map(ensureAspect);

  // 2) 句号/分号/换行
  let segs = splitAny(q, /[。！？!?；;\n]+/).map(tidySegment).filter((s) => s.length >= 2);
  multi = distinctTopics(segs);
  if (multi) return multi.map(ensureAspect);

  // 3) 逗号（两侧都必须有领域主题）
  segs = splitAny(q, /[，,]+/).map(tidySegment).filter((s) => s.length >= 2);
  multi = distinctTopics(segs);
  if (multi) return multi.map(ensureAspect);

  // 4) 弱连接词 和 / 跟 / 与
  for (const c of WEAK_CONNECTORS) {
    const cand = splitOn(q, c).map(tidySegment).filter((s) => s.length >= 2);
    multi = distinctTopics(cand);
    if (multi) return multi.map(ensureAspect);
  }
  return [];
}

/** 命中需要追问的模糊主题（结合知识库判断：仅 1 篇覆盖 → 可以直接回答） */
export function detectAmbiguity(question, kb) {
  const q = String(question == null ? '' : question);
  const docs = (kb && kb.docs) || [];
  for (const topic of AMBIGUOUS_TOPICS) {
    const term = topic.terms.find((t) => q.includes(t));
    if (!term) continue;
    const qualified =
      topic.qualifiers.some((x) => q.includes(x)) ||
      (topic.qualifierRes || []).some((re) => re.test(q));
    if (qualified) continue;
    let covering = 0;
    for (const d of docs) {
      const hay = `${d.title || ''} ${(d.sections || []).join(' ')}`;
      if (topic.terms.some((t) => hay.includes(t))) covering += 1;
    }
    const strict = topic.strict !== false;
    if (strict || covering !== 1) {
      return {
        hit: true,
        topic: topic.id,
        term,
        coveringDocs: covering,
        missing: topic.question,
      };
    }
  }
  return { hit: false, topic: '', term: '', coveringDocs: 0, missing: '' };
}

/**
 * 动态/实时诉求检测（P0-3）：
 *  - hard=true：运行时数据（当日菜单、天气、个人余额、排队、我的成绩…）→ 必须拒答
 *  - soft=true：只是抬高门禁阈值并关闭强命中兜底
 */
export function detectDynamic(question) {
  const q = String(question == null ? '' : question);
  const hardHits = DYNAMIC_HARD_RES.filter((re) => re.test(q)).map((re) => re.source);
  const softHits = DYNAMIC_SOFT_RES.filter((re) => re.test(q)).map((re) => re.source);
  return {
    hit: hardHits.length > 0 || softHits.length > 0,
    hard: hardHits.length > 0,
    soft: softHits.length > 0,
    patterns: [...hardHits, ...softHits],
  };
}

export function planSources(question, kb, subQueries) {
  const hay = [question, ...(subQueries || [])].join(' ');
  const wanted = [];
  for (const m of TOPIC_TO_TIER) {
    if (m.re.test(hay)) for (const t of m.tiers) if (!wanted.includes(t)) wanted.push(t);
  }
  const present = uniq(((kb && kb.docs) || []).map((d) => d.tier)).filter((t) => TIER_ORDER.includes(t));
  let planned = wanted.filter((t) => present.length === 0 || present.includes(t));
  if (planned.length === 0) planned = present.length ? present.slice(0, 3) : ['A1', 'A2'];
  return planned.slice(0, 4);
}

const GENERIC_MISSING =
  '具体想问的校园事项（例如：退学办理、成绩单打印、宿舍调宿、图书馆借阅、校园卡补办等）';

/**
 * 完整的确定性分析（内部分析结果，不进入 AnswerEnvelope）。
 */
export function analyzeQuestion(question, kb, opts = {}) {
  const norm = normalizeQuestion(question);
  const outOfScope = detectOutOfScope(norm);
  const multiSegs = outOfScope.hit ? [] : splitMultiIntent(norm);
  const isMulti = multiSegs.length >= 2;
  const ambiguity = isMulti ? { hit: false, topic: '', term: '', missing: '', coveringDocs: 0 } : detectAmbiguity(norm, kb);
  const dynamic = detectDynamic(norm);

  let terms = { rawTerms: [], terms: [], expansions: [] };
  try {
    terms = analyzeTerms(norm, kb);
  } catch {
    terms = { rawTerms: [], terms: [], expansions: [] };
  }

  const subQueries = isMulti ? multiSegs : norm ? [norm] : [];
  const missing = [];
  if (ambiguity.hit) missing.push(ambiguity.missing);
  if (!isMulti && terms.rawTerms.length === 0 && !ambiguity.hit) missing.push(GENERIC_MISSING);

  const intent = outOfScope.hit
    ? classifyIntent(norm)
    : isMulti
      ? INTENT.MULTI
      : classifyIntent(norm);
  if (!INTENT_VALUES.includes(intent)) throw new Error(`intent 不在枚举内: ${intent}`);

  return {
    question: String(question == null ? '' : question),
    norm,
    intent,
    isMulti,
    multiSegments: multiSegs,
    subQueries,
    missingInfo: missing,
    plannedSources: planSources(norm, kb, subQueries),
    outOfScope,
    ambiguity,
    dynamic,
    rawTerms: terms.rawTerms,
    expansions: terms.expansions,
    keywordCount: terms.rawTerms.length,
    audience: opts.audience || '在校本科生',
  };
}

/** 契约第 4 节 API：plan(question, kb) -> AnswerEnvelope.plan（字段名固定） */
export function plan(question, kb) {
  const a = analyzeQuestion(question, kb);
  return {
    intent: a.intent,
    missing_info: a.missingInfo.slice(),
    planned_sources: a.plannedSources.slice(),
    sub_queries: a.subQueries.slice(),
  };
}
