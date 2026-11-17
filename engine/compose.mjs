/**
 * Campus Policy Agent V1.0 — 抽取式合成（零依赖 / ESM）
 *
 * **结构性"不编造"保证**：
 *   conclusion / steps / conditions / materials 中的每一个字符串，
 *   都是某个 chunk.text 的逐字子串（允许的规整只有两种：去掉行首编号前缀、空白折叠）。
 *   compose 只做「挑句子 / 分桶 / 排序 / 截断」，从不改写、概括或续写。
 *   notes 里允许出现模板文本（拒答、追问、版本提示），模板文本单独可识别。
 */

import {
  DISCLAIMER, EVIDENCE_LABEL, EVIDENCE_STATUSES, STATUS, TEMPLATE_CONCLUSIONS,
  TEMPLATE_NOTE_RES, UPDATE_HINT,
} from './constants.mjs';
import { ACTION_VERBS, AUDIENCE_RESTRICT_RE, AUDIENCE_RULES, NOISE_UNIT_RES, SECTION_HINTS, TOPIC_TERMS, UNIT_CUES } from './lexicon.mjs';
import { splitSourceUrls } from './kb.mjs';
import { isVerbatim, normSpace, splitUnits, stripNumbering, truncate, uniq } from './text.mjs';

const BUCKETS = ['procedure', 'condition', 'material', 'deadline', 'fee', 'notice', 'meta', 'other'];

/** 事项元数据字段（属于"事项信息"，不属于办理步骤） */
export const META_FIELD_RE = /^(受理部门|决定部门|主管部门|责任部门|联办部门|承办部门|事项编号|事项名称|事项类型|用印情况|联系方式|咨询电话|联系电话|办理地点|受理地点|办公地点|办公时间|服务对象|前置部门|后续部门|收费标准|收费依据|办理时间|受理时间|表格下载|办理方式|办理形式|网上办理|到办事现场次数|是否收费|办理深度|办理渠道|结果名称|结果样本|办理结果|通办范围|数量限制|审批结果|服务依据|办理依据)[:：]/;

/** 依据类行（服务依据：…）既不是材料也不是流程 */
export const BASIS_LINE_RE = /^(服务依据|办理依据|法定依据|设定依据|法律依据|收费依据|政策依据|文件依据)[:：]/;

/**
 * 适用性排除检查（P0-3）：
 *  A. 「…除外 / 不适用 / 不含 / 不包括」且**问题主体落在排除列表内** → 该条款不得用于作答。
 *     例：「（教工卡、学生卡、普通卡等除外）的补卡收费标准」对「学生的校园卡补办工本费」不适用。
 *  B. 「领用人必须是在编在岗教职员工」这类**受众限定**，而问题主体是被排除的受众（学生）→ 同样不得用于作答。
 */
export function isExcludedBy(text, question) {
  const t = normSpace(text);
  const qs = normSpace(question).replace(/的/g, '');
  // A. 显式排除列表
  const m = /([^，。；：()（）]{1,60}?)(?:等)?\s*(?:除外|不适用|不包含|不包括|不含)/.exec(t);
  if (m) {
    const items = m[1]
      .split(/[、,，/]|以及|和/)
      .map((s) => s.replace(/[（(][^)）]*[)）]/g, '').trim())
      .filter((s) => s.length >= 2 && s.length <= 12);
    const hitA = items.some((it) => {
      if (qs.includes(it)) return true;
      const core = it.replace(/[卡证表册]$/, '');
      const tail = it.slice(-1);
      return core.length >= 2 && qs.includes(core) && qs.includes(tail);
    });
    if (hitA) return true;
  }
  // B. 受众限定（限定语气 + 允许受众 + 问题主体属于被排除受众）
  if (AUDIENCE_RESTRICT_RE.test(t)) {
    for (const rule of AUDIENCE_RULES) {
      if (!rule.allow.test(t)) continue;
      if (rule.deny.some((w) => qs.includes(w))) return true;
    }
  }
  return false;
}

export function isMetaLine(text) {
  return META_FIELD_RE.test(normSpace(text));
}

export function isBasisLine(text) {
  return BASIS_LINE_RE.test(normSpace(text));
}

/** 小节名 → 桶 */
export function classifySection(section) {
  const s = normSpace(section);
  if (!s) return 'unknown';
  for (const key of ['procedure', 'material', 'condition', 'deadline', 'fee', 'notice', 'contact', 'summary']) {
    if ((SECTION_HINTS[key] || []).some((h) => s.includes(h))) return key;
  }
  return 'unknown';
}

function cueHit(text, cues) {
  return (cues || []).some((re) => re.test(text));
}

export function isNoiseUnit(text) {
  const t = normSpace(text);
  if (!t) return true;
  if (NOISE_UNIT_RES.some((re) => re.test(t))) return true;
  if (t.length < 4) return true;
  return false;
}

/** "标签行"（如 `受理部门：教务处`）——短且带冒号，不适合当结论 */
function isLabelLine(t) {
  const s = normSpace(t);
  return /^[^，。；]{2,12}[:：]/.test(s) && s.length < 30;
}

/** 去掉行首标签前缀（如 "承诺时限：xxx" → "xxx"），结果仍是原文的逐字子串 */
export function stripLabelPrefix(t) {
  const s = normSpace(t);
  const m = /^[^，。；：]{2,12}[:：]\s*([\s\S]{10,})$/.exec(s);
  return m ? m[1].trim() : s;
}

/** 金额/收费类行（含金额或"免费/不收费"），费用类问题必须能把它捞出来 */
const FEE_LIKE_RE = /(\d+(?:\.\d+)?\s*(?:元|块|角)(?![\u4e00-\u9fff])|\d+(?:\.\d+)?\s*分(?!钟)|免费|不收费|不收取|收费标准|收费依据|工本费)/;

/** 单元 → 桶（小节类型优先，其次靠线索词） */
function classifyUnit(text, sectionKind) {
  if (isBasisLine(text)) return 'other';
  // 金额行优先归 fee：KB 体例是「## 事项名 + 收费多少元」，不能被当成 meta 元数据丢掉
  if (FEE_LIKE_RE.test(text)) return 'fee';
  if (isMetaLine(text)) return 'meta';
  switch (sectionKind) {
    case 'procedure': return 'procedure';
    case 'material': return 'material';
    case 'condition': return 'condition';
    case 'deadline': return 'deadline';
    case 'fee': return 'fee';
    case 'notice': return 'notice';
    case 'summary': return 'other';
    case 'contact': return 'other';
    default: break;
  }
  if (isLabelLine(text)) return 'condition';
  if (cueHit(text, UNIT_CUES.procedure)) return 'procedure';
  if (cueHit(text, UNIT_CUES.material)) return 'material';
  if (cueHit(text, UNIT_CUES.condition)) return 'condition';
  if (cueHit(text, UNIT_CUES.deadline)) return 'deadline';
  if (cueHit(text, UNIT_CUES.fee)) return 'fee';
  if (cueHit(text, UNIT_CUES.notice)) return 'notice';
  return 'other';
}

/**
 * chunk → 结构化证据卡（workflow 的 source_parser 节点直接复用本函数）。
 * opts.question 传入时会做「适用性排除」标记：整段明确排除问题主体的资料不参与抽取。
 */
export function buildEvidenceCards(evidence, opts = {}) {
  const question = opts.question || '';
  return (evidence || []).map(({ chunk, score, matched }) => {
    const sectionKind = classifySection(chunk.section);
    const units = [];
    for (const raw of splitUnits(chunk.text || '')) {
      const text = stripNumbering(raw);
      if (isNoiseUnit(text)) continue;
      units.push({ text, raw });
    }
    const buckets = {};
    for (const b of BUCKETS) buckets[b] = [];
    for (const u of units) buckets[classifyUnit(u.text, sectionKind)].push(u.text);
    const excludedBy = question ? units.filter((u) => isExcludedBy(u.text, question)).map((u) => u.text) : [];
    return {
      chunk,
      score,
      matched: matched || [],
      sectionKind,
      units,
      buckets,
      excludedForQuestion: excludedBy.length > 0,
      excludedEvidence: excludedBy,
    };
  });
}

function normKey(s) {
  return normSpace(s).replace(/[\s。，、；：:,.!?！？；;（）()【】\[\]《》\-—]/g, '');
}

function selectClaims(cards, bucket, { limit = 8, perCard = 8, minLen = 5 } = {}) {
  const out = [];
  const seen = new Set();
  for (const card of cards) {
    if (card.excludedForQuestion) continue; // 明确排除问题主体的资料不得用于作答
    if (bucket === 'fee' && card.feeExcludedForQuestion) continue; // 收费条款明确排除本问题主体
    let n = 0;
    for (const t of card.buckets[bucket] || []) {
      const key = normKey(t);
      if (seen.has(key) || t.length < minLen) continue;
      seen.add(key);
      out.push({ text: t, card });
      n += 1;
      if (out.length >= limit) return out;
      if (n >= perCard) break;
    }
  }
  return out;
}

/**
 * 结论选句（严格遵守抽取式：结论必须是某个 chunk 正文的逐字子串）：
 *   ① 含动作动词（办理/申请/提交/审批/审核/受理/流程…）且句长 ≥ 15 的流程类句子
 *   ② 概述/事项信息类小节里的说明句
 *   ③ 回落到流程首步
 *   ④ 最后才回落到材料类句子
 * 选中的句子若带 `标签：` 前缀，会去掉前缀（结果仍是原文的连续子串）。
 */
function pickConclusion(cards, steps, materials, queryTerms, intent) {
  const cands = [];
  const seen = new Set();
  // "学生/学校/学院"这类高频泛词不能当作结论相关性的锚点，否则会把跑题句子拉进来
  const GENERIC = new Set(['学生', '同学', '学校', '学院', '老师', '本科生', '研究生', '大学', '华中', '科技', '工作', '相关', '有关', '规定', '情况']);
  const all = (queryTerms || []).filter((t) => t && t.length >= 2);
  const specific = all.filter((t) => !GENERIC.has(t));
  const termList = specific.length ? specific : all;
  const relevant = (t) => termList.length === 0 || termList.some((x) => t.includes(x));
  // P0-5：问题里的"动作槽位"（登录/预约/补办…）——结论必须落在同类动作上
  const qText = all.join('') || '';
  const wantVerbs = ACTION_VERBS.filter((v) => qText.includes(v));
  // 领域主题词锚定（问题里出现过的主题名词）
  const qRaw = (queryTerms || []).join(' ') + ' ' + (queryTerms || []).join('');
  const topicAnchors = TOPIC_TERMS.filter((t) => t.length >= 2 && qRaw.includes(t));
  const isMaterialUnit = (card, raw) => (card.buckets && card.buckets.material ? card.buckets.material.includes(raw) : false);
  // 含"除外/不适用"的条款不适合当结论（可能把问题主体排除在外）
  const EXCLUSION_RE = /(?:除外|不适用|不包含|不包括|不在此列)/;
  const isFeeLike = (t) => /(\d+\s*(元|块|角|分)|免费|工本费|收费标准|费用|收费|缴费)/.test(t);
  for (const card of cards.slice(0, 10)) {
    if (card.excludedForQuestion) continue;
    for (const u of card.units) {
      const raw = u.text;
      if (isMetaLine(raw) || isBasisLine(raw)) continue;
      if (isNoiseUnit(raw)) continue; // 来源索引行等噪声不得当结论
      const feeUnit = isFeeLike(raw);
      // 费用类问题的"收费标准：每份5元"这类短行是**正确答案本身**，保留标签前缀、放宽长度下限
      const text = intent === '费用类' && feeUnit ? raw : stripLabelPrefix(raw);
      if (intent === '费用类' && feeUnit) {
        if (text.length < 6 || text.length > 150) continue;
      } else if (text.length < 15 || text.length > 150) continue;
      if (!relevant(text)) continue; // 结论必须与问题主题相关
      if (EXCLUSION_RE.test(text)) continue;
      const key = normKey(text);
      if (seen.has(key)) continue;
      const verbHits = (text.match(/办理|申请|提交|审批|审核|受理|流程|手续|需要|应当|须|由|填写|领取/g) || []).length;
      if (verbHits === 0) continue;
      // 概述/事项信息类小节的说明句最适合当结论；流程小节的整段流程留给 steps；材料条目不当结论
      let secBonus = card.sectionKind === 'summary' || card.sectionKind === 'other' ? 3 : card.sectionKind === 'procedure' ? 0 : 1.5;
      if (isMaterialUnit(card, raw)) secBonus = -2.5; // 材料条目不当结论
      if (intent === '费用类' && isFeeLike(text)) secBonus += 2; // 费用类问题优先给含金额/收费信息的句子
      // 动作槽位匹配：问题问"怎么登录/怎么预约"，结论就得是同类动作（流程图整段也算流程类命中）
      const flowLike = intent === '流程类' && /→/.test(text);
      const verbHit = wantVerbs.length === 0 || wantVerbs.some((v) => text.includes(v)) || flowLike;
      if (wantVerbs.length > 0) secBonus += verbHit ? 2.5 : -2.5;
      // 领域主题词锚定：问题里有主题词时，结论应落在同一主题上（作为扣分项，避免池子被清空）
      if (topicAnchors.length > 0 && !topicAnchors.some((t) => text.includes(t))) secBonus -= 3;
      const labelPenalty = /^[^，。；：]{2,12}[:：]/.test(raw) ? 0.5 : 0;
      const score = secBonus + Math.min(verbHits, 3) * 0.6 + Math.min(text.length, 120) / 100 - labelPenalty;
      seen.add(key);
      cands.push({ text, card, score });
    }
  }
  // 费用类问题：结论优先落在"含金额/收费信息"的句子上（若确有这类句子）
  let pool = cands;
  if (intent === '费用类') {
    const feeCands = cands.filter((c) => isFeeLike(c.text));
    if (feeCands.length) pool = feeCands;
  }
  pool.sort((a, b) => (b.score - a.score) || (b.text.length - a.text.length));
  if (pool.length) return pool[0];
  // 兜底：宁可给流程首步，也不要给材料条目
  if (steps && steps.length) return steps[0];
  if (materials && materials.length) return materials[0];
  return null;
}

/** 从证据卡里找"官方渠道"行（咨询电话 / 办理地点 / 联系方式） */
export function pickContactClaim(cards) {
  for (const card of cards) {
    for (const u of card.units) {
      if (/(咨询电话|联系电话|联系方式|办理地点|受理地点|办公地点|办公电话|咨询方式)/.test(u.text)) {
        return { text: u.text, card };
      }
    }
  }
  return null;
}

const ISO_DATE_RE = /(\d{4})[-/.年](\d{1,2})(?:[-/.月](\d{1,2}))?/;

function dateKey(...vals) {
  for (const v of vals) {
    const m = ISO_DATE_RE.exec(String(v == null ? '' : v));
    if (m) {
      const y = Number(m[1]);
      const mo = Number(m[2]) || 1;
      const d = Number(m[3]) || 1;
      return y * 10000 + mo * 100 + d;
    }
  }
  return 0;
}

/**
 * 版本冲突检测（真实数据驱动，不靠问句关键词）：
 *  - 强信号：证据里某文档 `supersedes` 指向证据里的另一文档
 *  - 强信号：两文档标题高度相似（bigram Jaccard ≥ 0.7）且 version/生效日期不同
 *
 * 两道防假阳性闸门（P0 修复）：
 *  1. **相关性门槛**：冲突双方至少有一方是本次检索的 top-`centralityTop` 核心文档，
 *     否则只是"几乎每篇都提到的细则"顺带共现，不构成冲突。
 *  2. **新旧可判定性**：一方 supersedes 另一方，或 effective_date/版本日期明确更早
 *     → determinable=true，调用方应「以现行版本作答 + notes 提示存在旧版本」，
 *     而不是把整题判成 version_conflict。只有新旧不可判定时才返回 version_conflict。
 */
export function detectVersionConflict(cards, kb, { titleSim = 0.7, centralityTop = 2 } = {}) {
  const docsInEvidence = [];
  const seen = new Set();
  for (const card of cards) {
    const d = card.chunk;
    if (seen.has(d.doc_id)) continue;
    seen.add(d.doc_id);
    docsInEvidence.push({ doc_id: d.doc_id, title: d.title, version: d.version, tier: d.tier, section: d.section, card });
  }
  if (docsInEvidence.length < 2) return null;
  const docIndex = new Map(((kb && kb.docs) || []).map((d) => [d.doc_id, d]));
  const centralDocs = new Set((cards || []).slice(0, centralityTop).map((c) => c.chunk.doc_id));
  const pairs = [];
  for (let i = 0; i < docsInEvidence.length; i += 1) {
    for (let j = i + 1; j < docsInEvidence.length; j += 1) {
      const a = docsInEvidence[i];
      const b = docsInEvidence[j];
      // 闸门 1：至少一方是核心证据，否则视为无关共现
      if (!centralDocs.has(a.doc_id) && !centralDocs.has(b.doc_id)) continue;
      const aFull = docIndex.get(a.doc_id);
      const bFull = docIndex.get(b.doc_id);
      const supersedesA = String((aFull && aFull.supersedes) || '');
      const supersedesB = String((bFull && bFull.supersedes) || '');
      const explicit = supersedesA === b.doc_id || supersedesB === a.doc_id;
      const sim = titleSimilarity(a.title, b.title);
      const versionKey = (d) => `${normSpace(d && d.version)}|${normSpace(d && d.effective_date)}`;
      const versionDiff = versionKey(aFull || a) !== versionKey(bFull || b);
      const sameTier = a.tier === b.tier;
      if (explicit || (sim >= titleSim && versionDiff && sameTier)) {
        const ka = dateKey((aFull || {}).effective_date, (aFull || {}).version, (aFull || {}).retrieved_at);
        const kb2 = dateKey((bFull || {}).effective_date, (bFull || {}).version, (bFull || {}).retrieved_at);
        const dateDiffers = ka !== kb2 && (ka > 0 || kb2 > 0);
        pairs.push({ a, b, explicit, sim, versionDiff, dateDiffers, determinable: explicit || dateDiffers });
      }
    }
  }
  if (pairs.length === 0) return null;
  const docIds = uniq(pairs.flatMap((p) => [p.a.doc_id, p.b.doc_id]));
  // 版本新旧：supersedes 关系优先，其次比较日期串
  const keyOf = (docId) => {
    const full = docIndex.get(docId) || {};
    return dateKey(full.effective_date, full.version, full.retrieved_at);
  };
  const supersededBy = new Map();
  for (const p of pairs) {
    const aFull = docIndex.get(p.a.doc_id);
    const bFull = docIndex.get(p.b.doc_id);
    if (String((aFull && aFull.supersedes) || '') === p.b.doc_id) supersededBy.set(p.b.doc_id, p.a.doc_id);
    if (String((bFull && bFull.supersedes) || '') === p.a.doc_id) supersededBy.set(p.a.doc_id, p.b.doc_id);
  }
  // 版本新旧：supersedes 关系优先（被取代者出局），其次比较日期串
  let newest = docIds[0];
  const candidates = docIds.filter((id) => !supersededBy.has(id));
  const pool = candidates.length ? candidates : docIds;
  newest = pool[0];
  for (const id of pool) {
    if (keyOf(id) > keyOf(newest)) newest = id;
  }
  return { pairs, docIds, newest, docIndex, supersededBy, determinable: pairs.some((p) => p.determinable) };
}

function titleSimilarity(a, b) {
  const grams = (s) => {
    const t = normSpace(s).replace(/[【】\[\]（）()《》\s]/g, '');
    const set = new Set();
    for (let i = 0; i < t.length - 1; i += 1) set.add(t.slice(i, i + 2));
    return set;
  };
  const A = grams(a);
  const B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/** 组装最终 AnswerEnvelope（所有状态共用） */
function finalize(spec) {
  const {
    status, question, planObj, evidenceLabel, conclusionClaim, steps, conditions, materials,
    notes, cards, mode = 'deterministic', trace = [], disclaimer = DISCLAIMER,
    conclusionText = '',
  } = spec;

  const claimSeq = [];
  const pushClaim = (c) => {
    if (c && c.text) claimSeq.push(c);
  };
  if (EVIDENCE_STATUSES.includes(status)) pushClaim(conclusionClaim);
  for (const c of steps || []) pushClaim(c);
  for (const c of conditions || []) pushClaim(c);
  for (const c of materials || []) pushClaim(c);
  for (const n of notes || []) if (n && n.card) pushClaim(n);

  const citations = [];
  const seenCite = new Set();
  for (const c of claimSeq) {
    const key = `${c.card.chunk.chunk_id}|${normSpace(c.text)}`;
    if (seenCite.has(key)) continue;
    seenCite.add(key);
    citations.push({
      marker: `[${citations.length + 1}]`,
      chunk_id: c.card.chunk.chunk_id,
      quote: truncate(normSpace(c.text), 80),
    });
  }

  const basisMap = new Map();
  // official_basis 只列"真正贡献了断言的文档"（有 claim 时），否则退化为传入的证据卡
  const contributed = [];
  const contributedSeen = new Set();
  for (const c of claimSeq) {
    const id = c.card.chunk.doc_id;
    if (contributedSeen.has(id)) continue;
    contributedSeen.add(id);
    contributed.push(c.card);
  }
  const basisSource = contributed.length ? contributed : [...(cards || [])].slice(0, 3);
  for (const c of basisSource) {
    const ch = c.chunk;
    if (basisMap.has(ch.doc_id)) continue;
    basisMap.set(ch.doc_id, {
      doc_id: ch.doc_id,
      title: ch.title,
      section: ch.section,
      tier: ch.tier,
      source_org: ch.source_org,
      // 契约 v3：source_url 保持原字符串（可能是 `;` 分隔的多来源），另给拆分后的数组
      source_url: ch.source_url,
      source_urls: splitSourceUrls(ch.source_url),
      version: ch.version,
      retrieved_at: ch.retrieved_at,
    });
  }

  const env = {
    status,
    question: String(question == null ? '' : question),
    evidence_label: evidenceLabel,
    conclusion: (EVIDENCE_STATUSES.includes(status) && conclusionClaim)
      ? conclusionClaim.text
      : (conclusionText || TEMPLATE_CONCLUSIONS[status] || ''),
    steps: (steps || []).map((c) => c.text),
    conditions: (conditions || []).map((c) => c.text),
    materials: (materials || []).map((c) => c.text),
    official_basis: Array.from(basisMap.values()),
    // 追问/拒答状态下 official_basis 只是"可参考的官方文件"，不是本次引用
    official_basis_is_reference: !EVIDENCE_STATUSES.includes(status) && basisMap.size > 0,
    notes: (notes || []).map((n) => (typeof n === 'string' ? n : n.text)),
    citations,
    citation_check: {
      valid: true,
      total_citations: citations.length,
      resolved_citations: citations.length,
      orphan_claims: 0,
      failures: [],
    },
    plan: planObj,
    trace: trace.slice(),
    mode,
    disclaimer,
  };
  return env;
}

/** 把 claim 列表转成 envelope 的 note 字符串 + 保留出处 */
function noteStrings(list) {
  return list.map((n) => (typeof n === 'string' ? { text: n, card: null } : n));
}

/** 官方渠道提示（用 tier → 机构名，避免编造具体电话） */
export function orgHint(plannedSources) {
  const map = {
    A0: '学生手册 / 学生工作部',
    A1: '本科生院（教务处）',
    A2: '智慧华中大网上办事大厅',
    A3: '总务后勤处',
    A4: '图书馆',
    A5: '社会学院',
  };
  const orgs = uniq((plannedSources || []).map((t) => map[t] || t));
  return orgs.length ? orgs.join('、') : '学校官方渠道';
}

/** answered / version_conflict 共用：从证据卡抽取五段式 */
export function composeFromCards({ question, analysis, kb, cards, conflict = null, trace = [], mode = 'deterministic', weakEvidence = false, extraNotes = [] }) {
  const intent = analysis.intent;
  let ordered = [...cards];
  if (conflict) {
    // 版本冲突红线：**只从最新版本抽取条文**，旧版本只在 notes 里提示，
    // 绝不把两版条文混进同一条结论/步骤里。
    const conflicting = new Set(conflict.docIds);
    ordered = ordered.filter((c) => !conflicting.has(c.chunk.doc_id) || c.chunk.doc_id === conflict.newest);
    // 最新版本里"顺带检索到"的弱相关片段（< 35% 最高分）不参与抽取，避免跑题
    const maxScore = ordered.reduce((a, c) => Math.max(a, c.score || 0), 0);
    ordered = ordered.filter((c) => c.chunk.doc_id !== conflict.newest || (c.score || 0) >= maxScore * 0.35);
    if (!ordered.some((c) => c.chunk.doc_id === conflict.newest)) {
      // 最新版本没有足够相关的片段 → 只用其余（非冲突）文档作答
      ordered = [...cards].filter((c) => !conflicting.has(c.chunk.doc_id));
    }
    ordered.sort((a, b) => (b.score || 0) - (a.score || 0));
  } else {
    // 抽取阶段只使用"与问题相关度足够"的证据卡（并按相关度排序），避免跑题段落混进流程/材料
    const maxScore = ordered.reduce((a, c) => Math.max(a, c.score || 0), 0);
    if (maxScore > 0) ordered = ordered.filter((c) => (c.score || 0) >= maxScore * 0.5);
    ordered.sort((a, b) => (b.score || 0) - (a.score || 0));
  }
  const steps = selectClaims(ordered, 'procedure', { limit: 10, perCard: 8 });
  const conditionClaims = selectClaims(ordered, 'condition', { limit: 8, perCard: 6 });
  const materialClaims = selectClaims(ordered, 'material', { limit: 8, perCard: 8 });
  const noticeClaims = selectClaims(ordered, 'notice', { limit: 4, perCard: 3 });
  const deadlineClaims = selectClaims(ordered, 'deadline', { limit: 4, perCard: 2 });
  const feeClaims = selectClaims(ordered, 'fee', { limit: 4, perCard: 2 });
  const metaClaims = selectClaims(ordered, 'meta', { limit: 5, perCard: 4 });

  const conclusionClaim = pickConclusion(ordered, steps, materialClaims, analysis.rawTerms, intent);

  // 结论不再重复出现在其它段里；但若会导致 steps 为空，则保留（answered 时流程不应为空）
  const cKey = conclusionClaim ? normKey(conclusionClaim.text) : '';
  const dropConclusion = (list) => list.filter((c) => normKey(c.text) !== cKey);
  let stepsOut = dropConclusion(steps);
  if (stepsOut.length === 0 && steps.length > 0) stepsOut = steps;
  let conditions = dropConclusion([...conditionClaims]);
  const materialsOut = dropConclusion(materialClaims);

  const deadlineOut = dropConclusion(deadlineClaims);
  const feeOut = dropConclusion(feeClaims);
  if (intent === '时间要求') conditions = [...deadlineOut, ...conditions];
  else conditions = [...conditions, ...deadlineOut];
  if (intent === '费用类') conditions = [...feeOut, ...conditions];
  else conditions = [...conditions, ...feeOut.slice(0, 2)];
  conditions = conditions.slice(0, 8);

  // 事项信息（受理部门/办理时间/联系方式…）放 notes，不混进流程；抽取式 notes 总量封顶
  const nodge = (list) => list.filter((c) => normKey(c.text) !== cKey);
  const extractiveNotes = [
    ...nodge(metaClaims).slice(0, 2),
    ...nodge(noticeClaims),
  ].slice(0, 5);
  const noteList = [...noteStrings(extractiveNotes)];
  for (const t of extraNotes || []) noteList.unshift({ text: t });
  if (conflict) {
    const detail = conflict.pairs
      .map((p) => `《${p.a.title}》（${p.a.version}）×《${p.b.title}》（${p.b.version}）`)
      .slice(0, 2)
      .join('；');
    const newestDoc = conflict.docIndex.get(conflict.newest);
    const olderDocs = uniq(conflict.docIds.filter((id) => id !== conflict.newest))
      .map((id) => {
        const d = conflict.docIndex.get(id);
        return d ? `《${d.title}》（${d.version}）` : id;
      })
      .join('、');
    if (conflict.determinable) {
      // 新旧可判定：不拒绝作答，只提示存在旧版本（P0 修复）
      noteList.unshift({
        text: `${UPDATE_HINT}：该主题存在多个版本（${detail}），旧版本 ${olderDocs} 已被取代；本回答**只采用现行版本**《${(newestDoc && newestDoc.title) || conflict.newest}》（${(newestDoc && newestDoc.version) || ''}）的条文，未混入旧版内容。`,
      });
    } else {
      noteList.unshift({
        text: `${UPDATE_HINT}：知识库中同一主题存在多个版本（${detail}），且无法判定孰新孰旧，本回答优先采用较新的《${(newestDoc && newestDoc.title) || conflict.newest}》（${(newestDoc && newestDoc.version) || ''}），请以官方最新通知为准。`,
      });
    }
  }
  const coveredTopics = (analysis.multiSegments || []).filter((seg) => {
    const topic = seg;
    return !cards.some((c) => {
      const hay = `${c.chunk.title} ${c.chunk.section} ${c.chunk.text}`;
      return topic.length >= 2 && hay.includes(topic.slice(0, 2));
    });
  });
  if (analysis.isMulti) {
    for (const seg of analysis.multiSegments) {
      const hit = cards.some((c) => `${c.chunk.title}${c.chunk.section}${c.chunk.text}`.includes(seg.replace(/\s*(怎么办|怎么办理|如何办理)$/, '')));
      if (!hit) {
        noteList.push({
          text: `资料中未找到关于「${seg}」的官方说明，该部分无法确认，请通过官方渠道核实。`,
        });
      }
    }
  }
  if (coveredTopics.length) {
    // coveredTopics 仅用于调试，notes 已逐条补齐
  }
  // 部分充分：有相关证据但覆盖不足 → 仍作答，但必须明确标注相关度有限
  if (weakEvidence) {
    noteList.push({
      text: '本次检索到的资料与问题相关度有限（部分要点可能未覆盖），以上条目仅供参考；如需确切结论请通过官方渠道确认。',
    });
  }
  // 费用类问题：资料中没有金额时明确说明"未规定"，不拿别的费用条款冒充
  if (intent === '费用类') {
    const feeAll = [...stepsOut, ...conditions, ...materialsOut, ...(conclusionClaim ? [conclusionClaim] : [])]
      .map((c) => c.text)
      .join(' ');
    // 注意 "10分钟" 不是金额：金额单位后不得紧跟汉字（"12元/张" 可以）
    const FEE_AMOUNT_RE = /(\d+(?:\.\d+)?\s*(?:元|块|角)(?![\u4e00-\u9fff])|\d+(?:\.\d+)?\s*分(?!钟)|免费|不收费|收费标准为|费用为|收费标准如下)/;
    if (!FEE_AMOUNT_RE.test(feeAll)) {
      noteList.push({
        text: '资料中未明确规定该事项的费用金额（或资料中的收费标准明确排除了该类情形），请以官方渠道公布的最新收费标准为准。',
      });
    }
  }
  noteList.push({
    text: `本回答为官方资料逐字摘录，标注 [n] 的句子可在「官方依据」中定位到原文；具体办理以${orgHint(analysis.plannedSources)}最新通知为准。`,
  });

  const determinableOnly = Boolean(conflict && conflict.determinable);
  return finalize({
    status: conflict && !determinableOnly ? STATUS.VERSION_CONFLICT : STATUS.ANSWERED,
    question,
    planObj: {
      intent: analysis.intent,
      missing_info: analysis.missingInfo.slice(),
      planned_sources: analysis.plannedSources.slice(),
      sub_queries: analysis.subQueries.slice(),
    },
    evidenceLabel: conflict
      ? EVIDENCE_LABEL.MAY_UPDATE
      : weakEvidence
        ? EVIDENCE_LABEL.NOT_SPECIFIED
        : EVIDENCE_LABEL.SPECIFIED,
    conclusionClaim,
    steps: stepsOut,
    conditions,
    materials: materialsOut,
    notes: noteList,
    cards: ordered,
    mode,
    trace,
  });
}

/** 资料不足 */
export function composeInsufficient({ question, analysis, trace = [], extraNotes = [] }) {
  const q = truncate(analysis.norm || question, 40);
  const notes = [
    `资料中未找到关于「${q}」的官方说明，知识库中现有资料不足以确认办理方式。`,
    ...extraNotes,
  ];
  if (analysis.dynamic && analysis.dynamic.hit) {
    notes.push('本工具基于静态官方资料，无法获取实时信息（如当日菜单、实时排队、个人余额等）。');
  }
  notes.push(`请以${orgHint(analysis.plannedSources)}发布的最新通知为准，必要时电话咨询相关部门。`);
  return finalize({
    status: STATUS.INSUFFICIENT_EVIDENCE,
    question,
    planObj: {
      intent: analysis.intent,
      missing_info: analysis.missingInfo.slice(),
      planned_sources: analysis.plannedSources.slice(),
      sub_queries: analysis.subQueries.slice(),
    },
    evidenceLabel: EVIDENCE_LABEL.NOT_SPECIFIED,
    conclusionClaim: null,
    steps: [],
    conditions: [],
    materials: [],
    notes: noteStrings(notes),
    cards: [],
    trace,
  });
}

/** 模糊问题 → 追问 */
export function composeClarify({ question, analysis, kb, trace = [] }) {
  const cards = [];
  if (kb && analysis.ambiguity && analysis.ambiguity.term) {
    for (const doc of kb.docs || []) {
      if (!(analysis.ambiguity.term && String(doc.title || '').includes(analysis.ambiguity.term))) continue;
      const chunk = (kb.chunks || []).find((c) => c.doc_id === doc.doc_id);
      if (chunk) cards.push({ chunk, score: 0, matched: [] });
      if (cards.length >= 3) break;
    }
  }
  const notes = [
    `需要补充：${analysis.missingInfo.join('；')}。`,
    ...noteStrings(notesOfCards(cards)),
  ];
  notes.push('补充信息后，本工具将给出对应的官方依据、办理流程与材料清单。');
  return finalize({
    status: STATUS.NEED_CLARIFICATION,
    question,
    planObj: {
      intent: analysis.intent,
      missing_info: analysis.missingInfo.slice(),
      planned_sources: analysis.plannedSources.slice(),
      sub_queries: analysis.subQueries.slice(),
    },
    evidenceLabel: EVIDENCE_LABEL.NOT_SPECIFIED,
    conclusionClaim: null,
    steps: [],
    conditions: [],
    materials: [],
    notes,
    cards,
    trace,
  });
}

function notesOfCards(cards) {
  const out = [];
  for (const c of cards) {
    out.push({ text: `可参考的官方文件：《${c.chunk.title}》— ${c.chunk.section}（${c.chunk.source_org}）`, card: null });
  }
  return out;
}

/** 超范围 / 诱导编造 → 拒答 + 官方渠道 */
export function composeOutOfScope({ question, analysis, kb, cards = [], trace = [] }) {
  const rule = analysis.outOfScope;
  const contact = pickContactClaim(cards);
  const notes = [];
  if (rule.channel) notes.push(`该问题涉及${rule.kind}，建议通过${rule.channel}等官方渠道咨询。`);
  notes.push('本工具不提供代写、伪造或规避校规的建议，只做官方可用资料的逐字摘录与整理。');
  if (contact) notes.push(contact);
  return finalize({
    status: STATUS.OUT_OF_SCOPE,
    question,
    planObj: {
      intent: analysis.intent,
      missing_info: analysis.missingInfo.slice(),
      planned_sources: analysis.plannedSources.slice(),
      sub_queries: analysis.subQueries.slice(),
    },
    evidenceLabel: EVIDENCE_LABEL.NOT_SPECIFIED,
    conclusionClaim: null,
    conclusionText: rule.conclusion || TEMPLATE_CONCLUSIONS[STATUS.OUT_OF_SCOPE],
    steps: [],
    conditions: [],
    materials: [],
    notes,
    cards: contact ? [contact.card] : cards.slice(0, 2),
    trace,
  });
}

/** 质量门禁回落用：最小安全信封（不可编造任何内容） */
export function safeFallbackEnvelope(question, reason, planObj) {
  return finalize({
    status: STATUS.INSUFFICIENT_EVIDENCE,
    question,
    planObj: planObj || { intent: '解释类', missing_info: [], planned_sources: [], sub_queries: [String(question || '')] },
    evidenceLabel: EVIDENCE_LABEL.NOT_SPECIFIED,
    conclusionClaim: null,
    steps: [],
    conditions: [],
    materials: [],
    notes: noteStrings([
      `资料中未找到关于「${truncate(String(question || ''), 40)}」的官方说明，知识库中现有资料不足以确认办理方式。`,
      `质量门禁回落：${reason}`,
      '请以学校官方渠道发布的最新通知为准。',
    ]),
    cards: [],
    trace: [{ node: 'qa', detail: `回落为 insufficient_evidence：${reason}` }],
  });
}

const FIVE_SECTION_TITLES = ['结论', '流程 / 条件', '材料', '官方依据', '注意事项'];

function markerFor(text, citations) {
  const t = normSpace(text);
  for (const c of citations) {
    const q = normSpace(c.quote);
    if (q && (t === q || t.startsWith(q))) return c.marker;
  }
  return '';
}

/** 五段式 Markdown 渲染（06_WEB 渲染顺序固定：结论 → 流程/条件 → 材料 → 官方依据 → 注意事项） */
export function renderFiveSections(env) {
  const L = [];
  L.push('### 结论');
  L.push(env.conclusion || '（无）');
  L.push('');
  L.push('### 流程 / 条件');
  if (env.steps.length === 0 && env.conditions.length === 0) L.push('（无）');
  env.steps.forEach((s, i) => L.push(`${i + 1}. ${s} ${markerFor(s, env.citations)}`.trim()));
  if (env.conditions.length) {
    L.push('');
    L.push('**条件 / 时限 / 费用要求：**');
    env.conditions.forEach((c) => L.push(`- ${c} ${markerFor(c, env.citations)}`.trim()));
  }
  L.push('');
  L.push('### 材料');
  if (env.materials.length === 0) L.push('（无）');
  env.materials.forEach((m, i) => L.push(`${i + 1}. ${m} ${markerFor(m, env.citations)}`.trim()));
  L.push('');
  L.push('### 官方依据');
  if (env.official_basis.length === 0) L.push('（本次回答未引用知识库资料）');
  env.official_basis.forEach((b, i) => {
    L.push(`${i + 1}. 《${b.title}》— ${b.section}（${b.source_org}，${b.version}，抓取于 ${b.retrieved_at}）`);
    if (b.source_url && b.source_url !== '未知') L.push(`   - 原文链接：${b.source_url}   doc_id: \`${b.doc_id}\``);
  });
  if (env.citations.length) {
    L.push('');
    L.push('**逐字引用（citation → chunk）：**');
    env.citations.forEach((c) => L.push(`- ${c.marker} \`${c.chunk_id}\` 「${c.quote}」`));
  }
  L.push('');
  L.push('### 注意事项');
  if (env.notes.length === 0) L.push('（无）');
  env.notes.forEach((n) => L.push(`- ${n}`));
  return L.join('\n');
}

/** 模板型 note 判定（validator / qa 复用） */
export function isTemplateNote(text) {
  const t = normSpace(text);
  return TEMPLATE_NOTE_RES.some((re) => re.test(t));
}

/** 供 llm 模式复用：组装最终信封 */
export function finalizeEnvelope(spec) {
  return finalize(spec);
}

/**
 * LLM 模式合成：**只接受能在证据卡里逐字定位的句子**，模型幻觉出来的句子一律丢弃。
 * 若一条可用句子都没有 → 返回 null，调用方回落 answerSync（确定性抽取式）。
 */
export function composeFromLLM({ question, analysis, kb, cards, llmOutput }) {
  if (!llmOutput || typeof llmOutput !== 'object') return null;
  const findCard = (s) => {
    for (const c of cards) if (isVerbatim(s, c.chunk.text)) return c;
    return null;
  };
  const toClaims = (arr, limit) => {
    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(arr) ? arr : []) {
      if (typeof raw !== 'string') continue;
      const text = normSpace(raw);
      if (!text || text.length < 4) continue;
      const key = normKey(text);
      if (seen.has(key)) continue;
      const card = findCard(text);
      if (!card) continue; // 模型自由发挥 → 丢弃
      seen.add(key);
      out.push({ text, card });
      if (out.length >= limit) break;
    }
    return out;
  };
  const steps = toClaims(llmOutput.steps, 10);
  const conditions = toClaims(llmOutput.conditions, 8);
  const materials = toClaims(llmOutput.materials, 8);
  const noticeClaims = toClaims(llmOutput.notes, 4);
  const conclusionText = normSpace(llmOutput.conclusion || '');
  const conclusionClaim = conclusionText ? (() => {
    const card = findCard(conclusionText);
    return card ? { text: conclusionText, card } : null;
  })() : null;
  if (!steps.length && !conditions.length && !materials.length) return null;

  const used = [];
  const usedSeen = new Set();
  for (const c of [conclusionClaim, ...steps, ...conditions, ...materials, ...noticeClaims]) {
    if (!c) continue;
    if (usedSeen.has(c.card.chunk.chunk_id)) continue;
    usedSeen.add(c.card.chunk.chunk_id);
    used.push(c.card);
  }
  const dropped = [];
  const collectDropped = (arr) => {
    for (const raw of Array.isArray(arr) ? arr : []) {
      if (typeof raw === 'string' && raw.trim() && !findCard(normSpace(raw))) dropped.push(raw.slice(0, 40));
    }
  };
  collectDropped(llmOutput.steps);
  collectDropped(llmOutput.conditions);
  collectDropped(llmOutput.materials);

  const notes = [
    ...noteStrings(noticeClaims),
    { text: `本回答由大模型在检索到的官方资料内逐字选取（mode=llm），其中 ${dropped.length} 条无法逐字定位的模型输出已被丢弃。` },
  ];
  return finalize({
    status: STATUS.ANSWERED,
    question,
    planObj: {
      intent: analysis.intent,
      missing_info: analysis.missingInfo.slice(),
      planned_sources: analysis.plannedSources.slice(),
      sub_queries: analysis.subQueries.slice(),
    },
    evidenceLabel: EVIDENCE_LABEL.SPECIFIED,
    conclusionClaim,
    steps,
    conditions,
    materials,
    notes,
    cards: used,
    mode: 'llm',
    trace: [{ node: 'llm_compose', detail: `LLM 输出被逐字校验：接受 ${steps.length + conditions.length + materials.length} 条，丢弃 ${dropped.length} 条` }],
  });
}

export { FIVE_SECTION_TITLES, titleSimilarity };
