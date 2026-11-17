/**
 * Campus Policy Agent V1.0 — 确定性检索（零依赖 / ESM）
 *
 * 中文 BM25：bigram（二元字）分词 + 倒排索引 + 长度归一化
 * 加权策略：
 *   1. 字段加权：正文 ×1、小节名 ×2、文档标题 ×2（进入 tf）
 *   2. tier 优先级加权：A0 > A1 > A2 > A3 > A4 > A5（契约第 1 节）
 *   3. 意图同义词扩展（lexicon.SYNONYM_GROUPS），扩展项权重 0.35
 *   4. 证据充分性 = 查询词加权覆盖率（idf 封顶 + 单字降权），不靠"分数拍脑袋"
 */

import { DEFAULTS, TIER_WEIGHT } from './constants.mjs';
import {
  ALIAS_TERMS, ASPECT_TERMS, STOP_BIGRAMS, STOP_CHARS, SYNONYM_GROUPS, TOPIC_TERMS,
} from './lexicon.mjs';
import { queryTokens, tokenize, uniq } from './text.mjs';

const { k1: K1, b: B } = DEFAULTS.bm25;

function addTokens(tf, tokens, weight) {
  for (const t of tokens) {
    if (!t) continue;
    tf.set(t, (tf.get(t) || 0) + weight);
  }
}

/** 构建（并缓存到 kb 上，非枚举属性，不影响 JSON 形状） */
export function buildIndex(kb) {
  const chunks = (kb && kb.chunks) || [];
  const cached = kb && kb.__index;
  if (cached && cached.key === `${chunks.length}:${chunks[0] ? chunks[0].chunk_id : ''}`) {
    return cached;
  }
  const df = new Map();
  const postings = new Map();
  const lens = new Array(chunks.length).fill(0);
  for (let i = 0; i < chunks.length; i += 1) {
    const c = chunks[i] || {};
    const tf = new Map();
    addTokens(tf, tokenize(c.text || ''), 1);
    addTokens(tf, tokenize(c.section || ''), 2);
    addTokens(tf, tokenize(c.title || ''), 2);
    let len = 0;
    for (const v of tf.values()) len += v;
    lens[i] = len || 1;
    for (const [t, f] of tf) {
      let p = postings.get(t);
      if (!p) {
        p = new Map();
        postings.set(t, p);
      }
      p.set(i, f);
      df.set(t, (df.get(t) || 0) + 1);
    }
  }
  const N = chunks.length;
  const avgLen = N ? lens.reduce((a, b) => a + b, 0) / N : 1;
  const index = { key: `${N}:${chunks[0] ? chunks[0].chunk_id : ''}`, N, df, postings, lens, avgLen, chunks };
  Object.defineProperty(index, 'vocab', { value: null, writable: true, enumerable: false });
  Object.defineProperty(index, 'knownBigrams', { value: null, writable: true, enumerable: false });
  if (kb) {
    try {
      Object.defineProperty(kb, '__index', { value: index, writable: true, enumerable: false, configurable: true });
    } catch {
      /* ignore */
    }
  }
  return index;
}

/** idf（BM25 标准形式，恒为正） */
export function idf(index, term) {
  const df = index.df.get(term) || 0;
  return Math.log(1 + (index.N - df + 0.5) / (df + 0.5));
}

const CJK_CHAR_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;

/** 切词词典：领域主题词 + 方面词 + 同义词 + 知识库高频子串 */
export function getVocabulary(kb) {
  const index = buildIndex(kb);
  if (index.vocab) return index.vocab;
  const vocab = new Set();
  const add = (w) => {
    if (!w) return;
    const s = String(w).trim();
    if (s.length >= 2 && s.length <= 8) vocab.add(s);
  };
  for (const t of TOPIC_TERMS) add(t);
  for (const t of ASPECT_TERMS) add(t);
  for (const g of SYNONYM_GROUPS) for (const t of g) add(t);
  for (const w of [
    '本科生', '研究生', '博士生', '硕士生', '在校生', '新生', '毕业生', '同学', '学生',
    '辅导员', '教务员', '班主任', '导师', '任课教师', '学院', '院系', '学校', '老师',
    '本科生院', '教务处', '研究生院', '学工部', '学生工作部', '总务后勤', '校团委',
    '办理', '申请', '提交', '审批', '审核', '受理', '材料', '证件', '流程', '步骤',
    '条件', '资格', '时限', '工作日', '费用', '收费标准', '注意事项', '咨询电话',
    '联系方式', '办理地点', '通知', '公告', '规定', '管理办法', '实施细则', '指南',
    '证明', '证明文件', '盖章', '签字', '申请表', '复印件', '原件', '照片',
    '智慧华中大', '办事大厅', '统一身份认证', '自助打印', '校园卡', '一卡通',
    '怎么', '什么', '哪些', '如何', '是否', '可以', '需要', '多少', '多久',
  ]) add(w);
  // 知识库派生：标题/小节名里出现 ≥2 次的 2~8 字子串
  const counter = new Map();
  for (const c of (kb && kb.chunks) || []) {
    for (const src of [c.title || '', c.section || '']) {
      for (const phrase of String(src).split(/[^\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFFa-zA-Z0-9]+/)) {
        if (phrase.length < 2) continue;
        for (let len = Math.min(8, phrase.length); len >= 2; len -= 1) {
          for (let i = 0; i + len <= phrase.length; i += 1) {
            const sub = phrase.slice(i, i + len);
            counter.set(sub, (counter.get(sub) || 0) + 1);
          }
        }
      }
    }
  }
  for (const [k, v] of counter) if (v >= 2) add(k);
  index.vocab = vocab;

  const knownBigrams = new Set();
  for (const t of index.df.keys()) {
    if (t.length === 2 && CJK_CHAR_RE.test(t[0]) && CJK_CHAR_RE.test(t[1])) knownBigrams.add(t);
  }
  index.knownBigrams = knownBigrams;
  return vocab;
}

function vocabOf(index) {
  if (!index.vocab) getVocabulary({ chunks: index.chunks, __index: index });
  return index.vocab;
}

/**
 * 查询词 → 加权词项表（含同义词扩展）。
 * @returns {{terms: Array<{term:string,weight:number,kind:'raw'|'expansion'}>, rawTerms: string[], expansions: string[]}}
 */
export function analyzeTerms(query, kb) {
  const index = buildIndex(kb);
  const vocab = vocabOf(index);
  const toks = queryTokens(String(query == null ? '' : query), vocab, index.knownBigrams);
  const termMap = new Map();
  const rawTerms = [];
  for (const t of toks) {
    if (!t) continue;
    if (t.length === 1) {
      if (STOP_CHARS.has(t)) continue;
    } else {
      if (STOP_BIGRAMS.has(t)) continue;
      if (ALIAS_TERMS.has(t)) continue;
    }
    if (termMap.has(t)) continue;
    termMap.set(t, { term: t, weight: 1, kind: 'raw' });
    rawTerms.push(t);
  }
  const expansions = [];
  const q = String(query == null ? '' : query).toLowerCase();
  for (const group of SYNONYM_GROUPS) {
    const hit = group.some((x) => q.includes(x.toLowerCase()));
    if (!hit) continue;
    for (const x of group) {
      for (const t of tokenize(x)) {
        if (t.length === 1 || STOP_BIGRAMS.has(t) || ALIAS_TERMS.has(t)) continue;
        const existing = termMap.get(t);
        if (existing) {
          // 原查询词优先级更高；已存在则不动
          continue;
        }
        if (termMap.has(t)) continue;
        termMap.set(t, { term: t, weight: DEFAULTS.gate.expansionWeight, kind: 'expansion' });
        expansions.push(t);
      }
    }
  }
  return { terms: Array.from(termMap.values()), rawTerms, expansions: uniq(expansions), index };
}

/** 单次查询评分（保留 matched / coverage 中间量，供 assessEvidence 复用） */
export function analyzeQuery(query, kb, opts = {}) {
  const index = buildIndex(kb);
  const { terms, rawTerms, expansions } = analyzeTerms(query, kb);
  const tierBoost = opts.tierBoost !== false;
  const scores = new Float64Array(index.N);
  const matchedPer = new Map();
  for (const t of terms) {
    const post = index.postings.get(t.term);
    if (!post) continue;
    const idfV = idf(index, t.term);
    for (const [i, tf] of post) {
      const dl = index.lens[i] || 1;
      const denom = tf + K1 * (1 - B + (B * dl) / (index.avgLen || 1));
      scores[i] += (t.weight * idfV * (tf * (K1 + 1))) / denom;
      let set = matchedPer.get(i);
      if (!set) {
        set = [];
        matchedPer.set(i, set);
      }
      set.push(t.term);
    }
  }
  const idfCap = DEFAULTS.gate.idfCap;
  let denom = 0;
  for (const t of terms) {
    const df = index.df.get(t.term) || 0;
    if (t.kind === 'expansion' && df === 0) continue; // 知识库中不存在的扩展项不计入分母
    const w = t.weight * (t.term.length === 1 ? DEFAULTS.gate.singleCharWeight : 1);
    denom += w * Math.min(idf(index, t.term), idfCap);
  }
  const results = [];
  for (let i = 0; i < index.N; i += 1) {
    let s = scores[i];
    if (!(s > 0)) continue;
    const chunk = index.chunks[i];
    if (tierBoost) s *= TIER_WEIGHT[chunk.tier] || 1;
    const matched = uniq(matchedPer.get(i) || []);
    let numer = 0;
    for (const m of matched) {
      const t = terms.find((x) => x.term === m);
      if (!t) continue;
      const df = index.df.get(m) || 0;
      if (t.kind === 'expansion' && df === 0) continue;
      const w = t.weight * (m.length === 1 ? DEFAULTS.gate.singleCharWeight : 1);
      numer += w * Math.min(idf(index, m), idfCap);
    }
    results.push({
      chunk,
      score: Number(s.toFixed(6)),
      matched,
      coverage: denom > 0 ? Number((numer / denom).toFixed(4)) : 0,
    });
  }
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ta = TIER_WEIGHT[a.chunk.tier] || 0;
    const tb = TIER_WEIGHT[b.chunk.tier] || 0;
    if (tb !== ta) return tb - ta;
    return String(a.chunk.chunk_id).localeCompare(String(b.chunk.chunk_id));
  });
  return { query: String(query == null ? '' : query), terms, rawTerms, expansions, results, index, denom };
}

/**
 * 契约第 4 节 API：retrieve(query, kb, opts) -> Array<{chunk, score, matched}>
 */
export function retrieve(query, kb, opts = {}) {
  const topK = Number.isFinite(opts.topK) ? opts.topK : DEFAULTS.topK;
  if (!kb || !Array.isArray(kb.chunks) || kb.chunks.length === 0) return [];
  const { results } = analyzeQuery(query, kb, opts);
  return results.slice(0, Math.max(0, topK)).map((r) => ({
    chunk: r.chunk,
    score: r.score,
    matched: r.matched,
  }));
}

/**
 * 证据充分性判定（决策核心，三态）。
 *
 * level:
 *   sufficient  — 覆盖率达标，或 top1 强命中（得分高 + 命中多个原词 + 标题/小节含主题词）
 *   partial     — 有相关证据但覆盖不足（仍作答，但标注「资料未明确规定」并提示相关度有限）
 *   insufficient— 证据不足（拒答）
 *
 * 注意：含"实时/动态"标记的问题（如"食堂明天中午吃什么"）不享受强命中兜底，
 *       也不允许 partial —— 静态知识库确实无法回答实时信息。
 */
export function assessEvidence(kb, query, results, opts = {}) {
  const g = DEFAULTS.gate;
  const index = buildIndex(kb);
  const { terms } = analyzeTerms(query, kb);
  const idfCap = g.idfCap;
  let denom = 0;
  const weightOf = (t) => t.weight * (t.term.length === 1 ? g.singleCharWeight : 1);
  for (const t of terms) {
    const df = index.df.get(t.term) || 0;
    if (t.kind === 'expansion' && df === 0) continue;
    denom += weightOf(t) * Math.min(idf(index, t.term), idfCap);
  }
  const use = (results || []).slice(0, Math.max(1, opts.unionTop || 3));
  const union = new Set();
  for (const r of use) for (const m of r.matched || []) union.add(m);
  let numer = 0;
  let rawHits = 0;
  let expHits = 0;
  for (const t of terms) {
    if (!union.has(t.term)) continue;
    const df = index.df.get(t.term) || 0;
    if (t.kind === 'expansion' && df === 0) continue;
    numer += weightOf(t) * Math.min(idf(index, t.term), idfCap);
    if (t.kind === 'raw') rawHits += 1;
    else expHits += 1;
  }
  const coverage = denom > 0 ? numer / denom : 0;
  const top = (results && results[0]) || null;
  const topScore = (top && top.score) || 0;
  const isDynamic = opts.dynamic === true;
  const covThreshold = isDynamic ? g.dynamicCoverage : g.coverage;
  const minRawHits = Number.isFinite(opts.minRawHits) ? opts.minRawHits : g.minRawHits;
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : g.minScore;

  // top1 强命中兜底：长问句/口语问句不应被"覆盖率"一刀切掉
  const rawTermList = terms.filter((t) => t.kind === 'raw' && t.term.length >= 2).map((t) => t.term);
  const topHay = top ? `${top.chunk.title} ${top.chunk.section}` : '';
  const titleTopicHit = rawTermList.some((t) => topHay.includes(t));
  const strongHit = Boolean(
    !isDynamic
    && top
    && topScore >= g.strongScore
    && rawHits >= g.strongRawHits
    && coverage >= g.weakCoverage
    && titleTopicHit,
  );

  const base = coverage >= covThreshold && rawHits >= minRawHits && topScore >= minScore;
  let level;
  if (base || strongHit) level = 'sufficient';
  else if (!isDynamic && coverage >= g.weakCoverage && topScore >= minScore && rawHits >= 1) level = 'partial';
  else level = 'insufficient';

  const reasons = [];
  if (level !== 'sufficient') {
    reasons.push(`加权覆盖率 ${coverage.toFixed(2)} < 阈值 ${covThreshold}${isDynamic ? '（问题含实时信息诉求）' : ''}`);
    if (!strongHit && top) {
      reasons.push(`top1 强化兜底未触发（score=${topScore.toFixed(2)}/${g.strongScore}，原词命中 ${rawHits}，标题/小节含主题词=${titleTopicHit}）`);
    }
  }
  if (rawHits < minRawHits) reasons.push(`原查询词命中数 ${rawHits} < ${minRawHits}`);
  if (!(topScore >= minScore)) reasons.push(`top1 得分 ${topScore.toFixed(2)} < ${minScore}`);
  if (!results || results.length === 0) reasons.push('未检索到任何候选片段');
  return {
    sufficient: level !== 'insufficient',
    level,
    strongHit,
    coverage: Number(coverage.toFixed(4)),
    rawHits,
    expHits,
    topScore: Number(topScore.toFixed(4)),
    covThreshold,
    minScore,
    dynamic: isDynamic,
    reason: reasons.length
      ? reasons.join('；')
      : level === 'sufficient' && strongHit
        ? `top1 强命中兜底放行（score=${topScore.toFixed(2)}，覆盖率 ${coverage.toFixed(2)}，原词命中 ${rawHits}）`
        : `加权覆盖率 ${coverage.toFixed(2)} ≥ ${covThreshold}，原查询词命中 ${rawHits} 个`,
  };
}

/** 按 sub_query 轮转合并（多意图时保证各子问题都有机会进入证据集） */
export function mergeByRoundRobin(lists, { topK = DEFAULTS.mergedTopK } = {}) {
  const out = [];
  const seen = new Set();
  const max = lists.reduce((a, l) => Math.max(a, l.length), 0);
  for (let rank = 0; rank < max; rank += 1) {
    for (const list of lists) {
      const r = list[rank];
      if (!r) continue;
      const id = r.chunk.chunk_id;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(r);
      if (out.length >= topK) return out;
    }
  }
  return out;
}
