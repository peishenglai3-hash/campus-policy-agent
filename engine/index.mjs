/**
 * Campus Policy Agent V1.0 — engine 公共 API（零依赖 / ESM）
 *
 * 契约第 4 节导出：
 *   loadKB / retrieve / plan / answerSync / answer / validateEnvelope / kbStats
 * 另附工作流与前端需要的内部能力（不改契约形状）：
 *   analyzeQuestion / assessEvidence / buildEvidenceCards / renderFiveSections /
 *   detectVersionConflict / getLLM / kbStats 等
 */

import { DEFAULTS, DISCLAIMER, STATUS } from './constants.mjs';
import {
  DEFAULT_KB_ROOT, FIXTURE_KB_ROOT, ENGINE_DIR, PROJECT_ROOT, loadKB as loadKBImpl,
  splitSourceUrls,
} from './kb.mjs';
import { getLLM } from './llm.mjs';
import { AUDIENCE_RESTRICT_RE, AUDIENCE_RULES } from './lexicon.mjs';
import { analyzeQuestion, plan } from './planner.mjs';
import { analyzeQuery, assessEvidence, mergeByRoundRobin, retrieve } from './retrieve.mjs';
import { normalizeQuestion } from './text.mjs';
import {
  buildEvidenceCards, composeClarify, composeFromCards, composeFromLLM, composeInsufficient,
  composeOutOfScope, detectVersionConflict, isExcludedBy, renderFiveSections, safeFallbackEnvelope,
} from './compose.mjs';
import { validateEnvelope } from './validate.mjs';

export { DEFAULT_KB_ROOT, FIXTURE_KB_ROOT, ENGINE_DIR, PROJECT_ROOT, splitSourceUrls };
export { getLLM, llmStatus } from './llm.mjs';
export { analyzeQuestion, plan, classifyIntent } from './planner.mjs';
export { retrieve, analyzeQuery, assessEvidence, buildIndex, getVocabulary, mergeByRoundRobin } from './retrieve.mjs';
export { buildEvidenceCards, detectVersionConflict, renderFiveSections, safeFallbackEnvelope } from './compose.mjs';
export { validateEnvelope } from './validate.mjs';
export { DISCLAIMER, STATUS, DEFAULTS } from './constants.mjs';
export { loadKB } from './kb.mjs';

const kbCache = new Map();

/** 默认知识库（进程内缓存；可用 HUST_KB_ROOT 覆盖） */
export function getDefaultKB(root) {
  const key = String(root || process.env.HUST_KB_ROOT || DEFAULT_KB_ROOT);
  const hit = kbCache.get(key);
  if (hit && Date.now() - hit.at < 1500) return hit.kb;
  const kb = loadKBImpl(key);
  kbCache.set(key, { at: Date.now(), kb });
  return kb;
}

export function resetKbCache() {
  kbCache.clear();
}

/** 契约第 4 节 API：kbStats(kb) -> { docs, chunks, byTier } */
export function kbStats(kb) {
  const docs = (kb && kb.docs) || [];
  const chunks = (kb && kb.chunks) || [];
  const byTier = {};
  const byTierDocs = {};
  for (const c of chunks) byTier[c.tier] = (byTier[c.tier] || 0) + 1;
  for (const d of docs) byTierDocs[d.tier] = (byTierDocs[d.tier] || 0) + 1;
  const bySourceOrg = {};
  for (const d of docs) bySourceOrg[d.source_org] = (bySourceOrg[d.source_org] || 0) + 1;
  return {
    docs: docs.length,
    chunks: chunks.length,
    byTier,
    byTierDocs,
    bySourceOrg,
    root: (kb && kb.root) || '',
    exists: Boolean(kb && kb.exists),
    warnings: (kb && kb.warnings) || [],
  };
}

/** supersedes 字段可能写多个 doc_id（分隔符不定） */
export function splitSupersedesIds(value) {
  return String(value == null ? '' : value)
    .split(/[;；,，、\s|]+/)
    .map((s) => s.trim())
    .filter((s) => s && s !== '无' && s !== '未知' && s !== 'NONE');
}

/**
 * 若证据里出现"已被取代的旧版本文档"，主动把现行版本的相关片段补进证据，
 * 交给 detectVersionConflict 走 version_conflict 分支（只从最新版抽取条文）。
 * 返回补入的片段数。
 */
function augmentSupersededEvidence(kb, per, merged, trace) {
  const docIds = new Set(merged.map((r) => r.chunk.doc_id));
  const kbDocs = kb.docs || [];
  const pairs = [];
  for (const did of docIds) {
    const newer = kbDocs.find((d) => splitSupersedesIds(d.supersedes).includes(did));
    if (newer && !docIds.has(newer.doc_id)) pairs.push({ old: did, newer: newer.doc_id });
  }
  if (pairs.length === 0) return { added: 0, merged, pairs, droppedOld: [] };
  const extra = [];
  const droppedOld = [];
  for (const { old, newer } of pairs) {
    let added = 0;
    for (const p of per) {
      for (const r of p.all || []) {
        if (r.chunk.doc_id !== newer || !(r.score > 0)) continue;
        if (extra.some((x) => x.chunk.chunk_id === r.chunk.chunk_id)) continue;
        extra.push(r);
        added += 1;
        if (added >= 3) break;
      }
      if (added >= 3) break;
    }
    if (added === 0) droppedOld.push(old);
    trace.push({
      node: 'version_check',
      detail: `证据中包含已被取代的旧版本 ${old}：已补入现行版本 ${newer} 的 ${added} 个片段${added === 0 ? '，现行版本无相关条款，旧版本已从证据中剔除' : '，按版本冲突处理'}`,
    });
  }
  let out = [...merged, ...extra];
  if (droppedOld.length) {
    const drop = new Set(droppedOld);
    out = out.filter((r) => !drop.has(r.chunk.doc_id));
  }
  return { added: extra.length, merged: out, pairs, droppedOld };
}

/** 多子查询检索：逐个 sub_query 检索，再轮转合并（多意图时不偏科） */
export function retrieveForSubQueries(kb, subQueries, opts = {}) {
  const topK = Number.isFinite(opts.topK) ? opts.topK : DEFAULTS.internalTopK;
  const queries = (subQueries && subQueries.length ? subQueries : ['']).filter((q) => String(q).trim());
  const list = queries.length ? queries : [''];
  const per = list.map((q) => {
    const aq = analyzeQuery(q, kb, opts);
    const results = aq.results.slice(0, topK);
    const assessment = assessEvidence(kb, q, results, { dynamic: opts.dynamic === true });
    return { query: q, results, all: aq.results, assessment };
  });
  return { per, merged: mergeByRoundRobin(per.map((p) => p.results), { topK: DEFAULTS.mergedTopK }) };
}

/**
 * 槽位 / 事实存在性检查（P0-3）：与检索分数**解耦**地判断"答案是否真的回答了问题"。
 *   1. 费用类问题：答案里必须出现金额（或明确的"免费/不收费"），否则不得 answered
 *   2. 答案正文必须至少包含一个问题的**具体主题词**（泛词不计），否则视为答非所问
 * 不通过 → 降级为 insufficient_evidence 并说明原因。
 */
const GENERIC_SLOT_TERMS = new Set([
  '学生', '同学', '学校', '学院', '老师', '本科生', '研究生', '大学', '华中', '科技',
  '工作', '相关', '有关', '规定', '情况', '怎么', '什么', '办理', '申请',
  // 泛词的 bigram 碎片（"本科生" → 本科/科生）：否则会被误当成主题锚点，
  // 导致"出国成绩排名证明收多少钱"这类问题找不到含"本科"的金额条款而被误拒（N01 回归）
  '本科', '科生', '研究', '究生', '硕士', '博士', '专科',
]);

/**
 * 具体条目名（"国家奖学金"、"成绩排名证明"…），用于判断金额条款是不是在讲**别的**事项。
 * 例：问"国家奖学金的金额"时，"学习优秀奖学金，奖励金额400元/生"属于别的奖项，不得采信。
 */
const ITEM_NAME_RE = /[\u4e00-\u9fff]{2,6}(?:奖学金|助学金|补助|奖金|证明|工本费|押金|收费)/g;
const GENERIC_NAME_WORDS = ['本科生', '研究生', '学生', '学校', '年级', '校级', '专科生', '同学'];

function itemNames(text) {
  const out = [];
  const re = new RegExp(ITEM_NAME_RE.source, 'g');
  let m;
  while ((m = re.exec(String(text))) !== null) out.push(m[0]);
  return Array.from(new Set(out));
}

function specificItemNames(text) {
  return itemNames(text).filter((n) => !GENERIC_NAME_WORDS.some((g) => n.includes(g)));
}
const FEE_AMOUNT_RE = /(\d+(?:\.\d+)?\s*(?:元|块|角)(?![\u4e00-\u9fff])|\d+(?:\.\d+)?\s*分(?!钟)|免费|不收费|收费标准为|费用为|收费标准如下)/;

export function checkAnswerSlots(env, analysis, opts = {}) {
  if (!env || env.status !== STATUS.ANSWERED) return { ok: true, reasons: [] };
  const reasons = [];
  const cards = opts.cards || [];
  const text = [env.conclusion, ...env.steps, ...env.conditions, ...env.materials].join(' ');
  const specific = (analysis.rawTerms || []).filter((t) => t.length >= 2 && !GENERIC_SLOT_TERMS.has(t));
  if (analysis.intent === '费用类') {
    // 金额必须与"问题主体"相关，且不得是**别的条目**的金额
    // 主体锚点 = 问题里最靠前的两个具体词；同时允许用该文档的标题/小节做主体匹配
    // （真实办事指南的"收费标准：每份5元"往往不重复写事项名）
    const anchors = specific.slice(0, 2);
    const qNames = specificItemNames(analysis.norm || analysis.question || '');
    const amountUnits = [];
    for (const c of cards) {
      if (c.excludedForQuestion || c.feeExcludedForQuestion) continue; // 被适用性排除的收费条款不采信
      const hay = `${c.chunk.title} ${c.chunk.section}`;
      for (const u of c.units) {
        if (!FEE_AMOUNT_RE.test(u.text)) continue;
        const uNames = itemNames(u.text);
        const conflictsWithQuestion = qNames.length > 0
          && uNames.length > 0
          && !uNames.some((n) => qNames.some((qn) => n.includes(qn) || qn.includes(n)));
        if (conflictsWithQuestion) continue; // 别的奖项/条目的金额，不采信
        amountUnits.push({ text: u.text, hay });
      }
    }
    const covered = amountUnits.some(({ text: t, hay }) => {
      const subjectMatch = anchors.length === 0
        || anchors.some((a) => t.includes(a))
        || anchors.some((a) => hay.includes(a));
      if (!subjectMatch) return false;
      // 必须真的被写进了答案正文（而不是"文档里恰好有金额但没被选中"）
      return text.includes(t.slice(0, 12));
    });
    const inAnswer = FEE_AMOUNT_RE.test(text);
    if (!covered || !inAnswer) {
      reasons.push('该问题询问费用，但资料中没有可用的金额或收费标准明确规定（费用槽位未覆盖）');
    }
  }
  if (specific.length > 0 && !specific.some((t) => text.includes(t))) {
    reasons.push(`答案正文未覆盖问题的具体主题词（${specific.slice(0, 4).join('/')}），属于答非所问`);
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * 适用性全库扫描（P0-3/P0-4 补强）：排除条款所在的 chunk 未必进入召回集，因此对整库扫一次。
 *  A. 受众限定：「领用人必须是在编在岗教职员工」而问题主体是学生 → 该**文档**不适用于本问题
 *  B. 费用排除：「（教工卡、学生卡、普通卡等除外）的收费标准」而问题主体是学生卡
 *     → 该文档的**费用类条款**不得用于作答（但同文档的补办流程仍然可用）
 */
function markApplicabilityExcluded(kb, question, cards) {
  const qs = normalizeQuestion(question).replace(/的/g, '');
  if (!qs) return { audience: 0, fee: 0 };
  const denyHit = AUDIENCE_RULES.some((r) => r.deny.some((w) => qs.includes(w)));
  const audienceDocs = new Set();
  const feeDocs = new Set();
  for (const chunk of kb.chunks || []) {
    const t = chunk.text || '';
    if (denyHit && AUDIENCE_RESTRICT_RE.test(t)) {
      for (const rule of AUDIENCE_RULES) {
        if (rule.allow.test(t) && rule.deny.some((w) => qs.includes(w))) {
          audienceDocs.add(chunk.doc_id);
          break;
        }
      }
    }
    if (isExcludedBy(t, question)) feeDocs.add(chunk.doc_id);
  }
  let audience = 0;
  let fee = 0;
  for (const c of cards) {
    if (audienceDocs.has(c.chunk.doc_id)) {
      c.excludedForQuestion = true;
      if (!c.excludedEvidence || !c.excludedEvidence.length) {
        c.excludedEvidence = ['受众限定条款：该事项仅面向特定受众，问题主体不在其列'];
      }
      audience += 1;
    }
    if (feeDocs.has(c.chunk.doc_id)) {
      c.feeExcludedForQuestion = true;
      fee += 1;
    }
  }
  return { audience, fee };
}

/** 核心流程：分析 → 边界 → 检索 → 证据门禁 → 版本冲突 → 抽取式合成 → 自检 */
export function coreAnswer(question, options = {}) {
  const kb = options.kb || getDefaultKB(options.kbRoot);
  const topK = Number.isFinite(options.topK) ? options.topK : DEFAULTS.internalTopK;
  const trace = [];
  const analysis = analyzeQuestion(question, kb, { audience: options.audience });

  trace.push({
    node: 'input_normalizer',
    detail: `规整后：「${analysis.norm || '（空）'}」；切片主题词 ${analysis.rawTerms.length} 个${analysis.expansions.length ? `，同义词扩展 ${analysis.expansions.length} 个` : ''}`,
  });
  trace.push({
    node: 'intent_detection',
    detail: `intent=${analysis.intent}${analysis.isMulti ? `（识别为多意图，拆出 ${analysis.subQueries.length} 个子查询）` : ''}`,
  });
  trace.push({
    node: 'source_planning',
    detail: `planned_sources=${analysis.plannedSources.join(',')}；sub_queries=${JSON.stringify(analysis.subQueries)}`,
  });

  const finish = (env, extra = {}) => {
    try {
      Object.defineProperty(env, '__kb', { value: kb, enumerable: false, writable: true, configurable: true });
    } catch {
      /* ignore */
    }
    const v = validateEnvelope(env, { kb });
    const citeViolations = v.violations.filter((x) => /^(INV2|INV4|CITATION_CHECK|NOTE-SAFE)/.test(x));
    let resolved = 0;
    const chunkIds = new Set((kb.chunks || []).map((c) => c.chunk_id));
    for (const c of env.citations) if (chunkIds.has(c.chunk_id)) resolved += 1;
    env.citation_check = {
      valid: citeViolations.length === 0,
      total_citations: env.citations.length,
      resolved_citations: resolved,
      orphan_claims: v.stats ? v.stats.orphan_claims : 0,
      failures: citeViolations,
    };
    const hard = v.violations.filter((x) => /^(STRUCT|ENUM|INV1|INV3|INV5|POLICY)/.test(x));
    env.trace.push({
      node: 'self_check',
      detail: v.ok ? 'validateEnvelope 通过（5 条硬性不变量全部满足）' : `validateEnvelope 发现 ${v.violations.length} 项问题：${v.violations.join(' | ')}`,
    });
    if (hard.length) {
      // 防御：绝不向外抛出违反硬性不变量的信封
      const safe = safeFallbackEnvelope(env.question, `自检失败：${hard.join(' | ')}`, env.plan);
      try {
        Object.defineProperty(safe, '__kb', { value: kb, enumerable: false, writable: true, configurable: true });
      } catch {
        /* ignore */
      }
      safe.trace.push({ node: 'self_check_fallback', detail: '已回落为最小安全信封（insufficient_evidence）' });
      return { env: safe, ctx: { ...extra, analysis, kb, trace } };
    }
    return { env, ctx: { ...extra, analysis, kb, trace } };
  };

  // ---- 边界 1：超范围 / 诱导编造（最高优先级） ----
  if (analysis.outOfScope.hit) {
    trace.push({
      node: 'boundary_check',
      detail: `命中超范围规则：${analysis.outOfScope.kind}（模式 ${analysis.outOfScope.patterns.join(',')}）→ 拒答`,
    });
    const { merged } = retrieveForSubQueries(kb, analysis.subQueries, { topK: 3, tierBoost: options.tierBoost });
    const cards = buildEvidenceCards(merged);
    const env = composeOutOfScope({ question: analysis.question, analysis, kb, cards, trace });
    return finish(env, { analysis, kb, evidence: merged, cards, boundary: 'out_of_scope' });
  }

  // ---- 边界 2：模糊问题（先记录，等检索结果出来再决定"追问"还是"资料不足"） ----
  const ambiguous = Boolean(analysis.ambiguity.hit && analysis.missingInfo.length);
  if (ambiguous) {
    trace.push({
      node: 'missing_info_check',
      detail: `主题「${analysis.ambiguity.topic}」缺少限定信息（缺失：${analysis.missingInfo.join('；')}）；将结合检索结果决定「追问」或「资料不足」`,
    });
  }
  if (!analysis.norm || analysis.rawTerms.length === 0) {
    trace.push({ node: 'missing_info_check', detail: '问题中没有可用的主题词 → need_clarification' });
    const env = composeClarify({ question: analysis.question, analysis, kb, trace });
    return finish(env, { analysis, kb, evidence: [], cards: [], boundary: 'need_clarification' });
  }

  // ---- 边界 3：运行时数据（当日菜单 / 实时排队 / 个人余额 / 我的成绩…）----
  // 这类问题无论检索分多高都不得作答：静态知识库不可能有运行时数据（P0-3 硬拦截）
  if (analysis.dynamic && analysis.dynamic.hard) {
    trace.push({
      node: 'dynamic_gate',
      detail: `命中运行时数据硬拦截（${analysis.dynamic.patterns.join(',')}）→ insufficient_evidence，不进入作答分支`,
    });
    const env = composeInsufficient({ question: analysis.question, analysis, trace });
    return finish(env, { analysis, kb, evidence: [], cards: [], boundary: 'runtime_data' });
  }

  // ---- 检索 ----
  const { per, merged: mergedRaw } = retrieveForSubQueries(kb, analysis.subQueries, {
    topK,
    tierBoost: options.tierBoost,
    dynamic: analysis.dynamic.hit,
  });
  // 若检索到"已被取代的旧版本文档"，主动补入现行版本（红线：绝不把两版条文混在一条结论里）
  const augment = augmentSupersededEvidence(kb, per, mergedRaw, trace);
  const merged = augment.merged;
  // 硬红线：被 KB 中其它文档声明取代的旧版本，条文绝不进入答案（无论是否判为 version_conflict）
  const supersederOf = new Map();
  for (const d of kb.docs || []) {
    for (const id of splitSupersedesIds(d.supersedes)) supersederOf.set(id, d.doc_id);
  }
  const evidenceDocIds = new Set(merged.map((r) => r.chunk.doc_id));
  const demoted = new Set();
  for (const did of evidenceDocIds) {
    const newer = supersederOf.get(did);
    if (newer && newer !== did && evidenceDocIds.has(newer)) demoted.add(did);
  }
  let cards = buildEvidenceCards(merged, { question: analysis.norm || analysis.question });
  const applicability = markApplicabilityExcluded(kb, analysis.norm || analysis.question, cards);
  if (applicability.audience > 0) {
    trace.push({
      node: 'audience_check',
      detail: `受众限定检查：KB 中存在"仅面向特定受众"的条款，已把 ${applicability.audience} 个证据卡标记为不适用于本问题（问题主体不在其列）`,
    });
  }
  if (applicability.fee > 0) {
    trace.push({
      node: 'exclusion_check',
      detail: `适用性排除：KB 中 ${applicability.fee} 个证据卡所属文档的收费条款明确排除本问题主体，其费用条款不得用于作答`,
    });
  }
  const cardsAll = cards; // 版本冲突检测需要看到旧版文档（即使它随后被剔除）
  const demotedNotes = [];
  if (demoted.size) {
    cards = cards.filter((c) => !demoted.has(c.chunk.doc_id));
    const names = Array.from(demoted)
      .map((id) => {
        const d = (kb.docs || []).find((x) => x.doc_id === id);
        return d ? `《${d.title}》（${d.version}）` : id;
      })
      .join('、');
    demotedNotes.push(`可能存在更新，需查最新通知：本次检索到已被取代的旧版本 ${names}，已从答案中剔除，仅采用现行版本条文。`);
    trace.push({ node: 'version_check', detail: `剔除已被取代的旧版本文档：${Array.from(demoted).join(' / ')}` });
  }
  if (cards.length === 0) {
    const env = composeInsufficient({
      question: analysis.question,
      analysis,
      trace,
      extraNotes: [
        `检索到的资料均为已被取代的历史版本（${augment.droppedOld.join(' / ')}），现行版本中未找到相关条款，无法给出确定结论。`,
      ],
    });
    return finish(env, { analysis, kb, evidence: merged, cards, sufficient: false });
  }
  trace.push({
    node: 'retrieval',
    detail: per
      .map((p) => `「${p.query}」命中 ${p.results.length} 条，覆盖率 ${p.assessment.coverage}，top1=${p.results[0] ? p.results[0].chunk.chunk_id : '无'}`)
      .join('；') || '无检索结果',
  });
  trace.push({
    node: 'tier_boost',
    detail: `tier 优先级加权 A0>A1>A2>A3>A4>A5 已生效=${options.tierBoost !== false}；合并后证据 ${merged.length} 条`,
  });

  // ---- 证据门禁（三态：sufficient / partial / insufficient） ----
  const sufficientPer = per.filter((p) => p.assessment.level === 'sufficient');
  const partialPer = per.filter((p) => p.assessment.level === 'partial');
  const anySufficient = sufficientPer.length > 0;
  const anyPartial = partialPer.length > 0;
  trace.push({
    node: 'evidence_gate',
    detail: `充分 ${sufficientPer.length} / 部分充分 ${partialPer.length} / 共 ${per.length} 个子查询；${per.map((p) => `「${p.query}」[${p.assessment.level}] ${p.assessment.reason}`).join('；')}`,
  });
  if (!anySufficient && !anyPartial) {
    const env = composeInsufficient({
      question: analysis.question,
      analysis,
      trace,
      extraNotes: ambiguous
        ? [`另：该问题本身涉及多种情形（${analysis.missingInfo.join('；')}），但知识库中也没有可支撑的官方资料。`]
        : [],
    });
    return finish(env, { analysis, kb, evidence: merged, cards, sufficient: false });
  }

  // ---- 边界 2b：模糊问题 → 追问（只有在确实检索到相关依据时才追问，否则上面已按"资料不足"处理）----
  if (ambiguous) {
    trace.push({
      node: 'missing_info_check',
      detail: `检索到相关依据，但主题「${analysis.ambiguity.topic}」缺少限定信息 → need_clarification（缺失：${analysis.missingInfo.join('；')}）`,
    });
    const env = composeClarify({ question: analysis.question, analysis, kb, trace });
    return finish(env, { analysis, kb, evidence: merged, cards, boundary: 'need_clarification' });
  }

  const answerWithSlotCheck = (env, extraCtx) => {
    const slot = checkAnswerSlots(env, analysis, { cards: extraCtx.cards });
    if (slot.ok) return finish(env, extraCtx);
    trace.push({ node: 'slot_check', detail: `槽位检查不通过 → 降级为 insufficient_evidence：${slot.reasons.join('；')}` });
    const downgraded = composeInsufficient({
      question: analysis.question,
      analysis,
      trace,
      extraNotes: slot.reasons.map((r) => `资料不足说明：${r}。`),
    });
    return finish(downgraded, { ...extraCtx, slotFailed: slot.reasons });
  };

  // ---- 版本冲突（在"完整证据"上检测，再决定抽取范围） ----
  const conflict = detectVersionConflict(cardsAll, kb);
  if (conflict) {
    trace.push({
      node: 'version_check',
      detail: `检测到同主题多版本：${conflict.docIds.join(' / ')}（新旧${conflict.determinable ? '可判定' : '不可判定'}），以 ${conflict.newest} 为准，仅从该版本抽取条文；status=${conflict.determinable ? 'answered + 更新提示' : 'version_conflict'}`,
    });
    const env = composeFromCards({
      question: analysis.question, analysis, kb, cards, conflict, trace, weakEvidence: !anySufficient, extraNotes: demotedNotes,
    });
    if (env.steps.length === 0 && env.conditions.length === 0 && env.materials.length === 0) {
      const newestDoc = conflict.docIndex.get(conflict.newest);
      const fallback = composeInsufficient({
        question: analysis.question,
        analysis,
        trace,
        extraNotes: [
          `检测到同一主题存在多个版本（${conflict.docIds.join(' / ')}），其中最新版本《${(newestDoc && newestDoc.title) || conflict.newest}》未检索到可用条款，无法给出确定结论。`,
        ],
      });
      return finish(fallback, { analysis, kb, evidence: merged, cards, conflict });
    }
    return answerWithSlotCheck(env, { analysis, kb, evidence: merged, cards, conflict });
  }
  trace.push({ node: 'version_check', detail: '未发现同主题多版本冲突（或冲突双方与本次问题无关）' });

  const env = composeFromCards({
    question: analysis.question, analysis, kb, cards, trace, weakEvidence: !anySufficient, extraNotes: demotedNotes,
  });
  trace.push({
    node: 'citation_bind',
    detail: `绑定 ${env.citations.length} 条逐字引用（每条 quote 均为 chunk 正文子串，≤80字）`,
  });
  return answerWithSlotCheck(env, { analysis, kb, evidence: merged, cards });
}

/** 契约第 4 节 API：answerSync(question, { kb }) -> AnswerEnvelope（纯抽取式） */
export function answerSync(question, options = {}) {
  const { env } = coreAnswer(question, options);
  return env;
}

/** 契约第 4 节 API：answer(question, { kb, llm }) -> Promise<AnswerEnvelope> */
export async function answer(question, options = {}) {
  const llm = options.llm || getLLM();
  const { env, ctx } = coreAnswer(question, options);
  if (!llm || !llm.available) {
    env.trace.push({
      node: 'llm',
      detail: `LLM 不可用（${(llm && llm.reason) || '未提供'}），使用确定性抽取式回答（mode=deterministic）`,
    });
    return env;
  }
  const answerable = [STATUS.ANSWERED, STATUS.VERSION_CONFLICT].includes(env.status);
  if (!answerable || !ctx.cards || ctx.cards.length === 0) {
    env.trace.push({ node: 'llm', detail: `状态 ${env.status} 不需要大模型改写，保持确定性结果` });
    return env;
  }
  try {
    const evidenceText = ctx.cards
      .map((c, i) => `【证据${i + 1}】chunk_id=${c.chunk.chunk_id} 文档=《${c.chunk.title}》 小节=${c.chunk.section}\n${c.chunk.text}`)
      .join('\n\n');
    const messages = [
      {
        role: 'system',
        content: [
          '你是演示机构校园办事资料的整理助手。',
          '唯一允许的操作：从下面的证据原文中逐字抄写句子，进行挑选与排序。',
          '严禁改写、概括、意译、补充任何证据之外的知识；严禁编造流程、材料、电话、链接。',
          '输出必须是 JSON：{"conclusion": string, "steps": string[], "conditions": string[], "materials": string[], "notes": string[]}',
          '其中每个字符串都必须与证据原文逐字一致（可去掉行首编号）。无法逐字抄写的字段留空数组或空字符串。',
        ].join('\n'),
      },
      { role: 'user', content: `学生问题：${question}\n\n证据原文：\n${evidenceText}` },
    ];
    const raw = await llm.chat(messages, { temperature: 0 });
    const parsed = JSON.parse(JSON.stringify(safeJson(raw)));
    const llmEnv = composeFromLLM({ question, analysis: ctx.analysis, kb: ctx.kb, cards: ctx.cards, llmOutput: parsed });
    if (!llmEnv) {
      env.trace.push({ node: 'llm', detail: 'LLM 输出无法通过逐字校验，已回落确定性抽取式回答' });
      return env;
    }
    try {
      Object.defineProperty(llmEnv, '__kb', { value: ctx.kb, enumerable: false, writable: true, configurable: true });
    } catch {
      /* ignore */
    }
    const v = validateEnvelope(llmEnv, { kb: ctx.kb });
    if (!v.ok) {
      env.trace.push({ node: 'llm', detail: `LLM 结果自检失败，回落确定性结果：${v.violations.join(' | ')}` });
      return env;
    }
    llmEnv.trace.push(...env.trace.filter((t) => t.node !== 'self_check'));
    llmEnv.trace.push({ node: 'llm', detail: `LLM 结果通过逐字校验与不变量自检（mode=llm）` });
    return llmEnv;
  } catch (err) {
    env.trace.push({
      node: 'llm',
      detail: `LLM 调用失败（${err && err.message}），已回落确定性抽取式回答`,
    });
    return env;
  }
}

function safeJson(raw) {
  const text = String(raw == null ? '' : raw);
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fence ? fence[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return {};
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return {};
  }
}

export default {
  loadKB: loadKBImpl,
  getDefaultKB,
  retrieve,
  plan,
  answerSync,
  answer,
  validateEnvelope,
  kbStats,
  analyzeQuestion,
  assessEvidence,
  buildEvidenceCards,
  renderFiveSections,
  getLLM,
  DISCLAIMER,
  DEFAULTS,
};
