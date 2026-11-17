/**
 * Campus Policy Agent V1.0 — 不变量自检（零依赖 / ESM）
 *
 * validateEnvelope(env, opts) -> { ok, violations }
 *   opts.kb 传入知识库时，会做**真正的逐字子串**校验（契约不变量 4）；
 *   不传 kb 时退化为"引用与断言自洽性"校验。
 *
 * 覆盖 _INTERFACES.md 第 3 节 5 条硬性不变量：
 *   INV1 answered ⇒ official_basis ≥ 1 且 citations ≥ 1
 *   INV2 citation_check.orphan_claims === 0（独立重算，不信任输入）
 *   INV3 insufficient_evidence ⇒ steps / materials 必须为空数组
 *   INV4 每条 citation.quote 是其 chunk 文本的逐字子串（≤80字）
 *   INV5 disclaimer 恒为固定文案
 */

import {
  CHUNK_ID_RE, DISCLAIMER, EVIDENCE_LABEL_VALUES, EVIDENCE_STATUSES, INTENT_VALUES,
  MODE_VALUES, STATUS, STATUS_VALUES, UPDATE_HINT,
} from './constants.mjs';
import { isTemplateNote } from './compose.mjs';
import { isVerbatim, normSpace } from './text.mjs';

const REQUIRED_KEYS = [
  ['status', 'string'],
  ['question', 'string'],
  ['evidence_label', 'string'],
  ['conclusion', 'string'],
  ['steps', 'array'],
  ['conditions', 'array'],
  ['materials', 'array'],
  ['official_basis', 'array'],
  ['notes', 'array'],
  ['citations', 'array'],
  ['citation_check', 'object'],
  ['plan', 'object'],
  ['trace', 'array'],
  ['mode', 'string'],
  ['disclaimer', 'string'],
];

function typeOf(v) {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v;
}

export function validateEnvelope(env, opts = {}) {
  const violations = [];
  const checks = [];
  const add = (id, ok, detail) => {
    checks.push({ id, ok: Boolean(ok), detail: detail || '' });
    if (!ok) violations.push(`${id}: ${detail || '校验失败'}`);
  };

  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    return { ok: false, violations: ['STRUCT: AnswerEnvelope 必须是对象'], checks: [] };
  }
  const kb = opts.kb || env.__kb || null;
  const kbChunks = kb && Array.isArray(kb.chunks) ? kb.chunks : null;
  const chunkById = kbChunks ? new Map(kbChunks.map((c) => [c.chunk_id, c])) : null;

  // ---- 结构 ----
  let structOk = true;
  const structIssues = [];
  for (const [k, t] of REQUIRED_KEYS) {
    if (!(k in env)) {
      structOk = false;
      structIssues.push(`缺少字段 ${k}`);
      continue;
    }
    if (typeOf(env[k]) !== t) {
      structOk = false;
      structIssues.push(`字段 ${k} 类型应为 ${t}，实际 ${typeOf(env[k])}`);
    }
  }
  add('STRUCT', structOk, structIssues.join('；'));

  // ---- 枚举 ----
  const enumIssues = [];
  if (!STATUS_VALUES.includes(env.status)) enumIssues.push(`status 非法：${env.status}`);
  if (!EVIDENCE_LABEL_VALUES.includes(env.evidence_label)) enumIssues.push(`evidence_label 非法：${env.evidence_label}`);
  if (!MODE_VALUES.includes(env.mode)) enumIssues.push(`mode 非法：${env.mode}`);
  if (env.plan && env.plan.intent && !INTENT_VALUES.includes(env.plan.intent)) enumIssues.push(`plan.intent 非法：${env.plan.intent}`);
  if (env.plan) {
    for (const k of ['missing_info', 'planned_sources', 'sub_queries']) {
      if (!Array.isArray(env.plan[k])) enumIssues.push(`plan.${k} 必须是数组`);
    }
  }
  add('ENUM', enumIssues.length === 0, enumIssues.join('；'));

  // ---- INV5 disclaimer ----
  add('INV5', env.disclaimer === DISCLAIMER, `disclaimer 必须恒为「${DISCLAIMER}」，实际「${env.disclaimer}」`);

  // ---- INV1 ----
  if (env.status === STATUS.ANSWERED) {
    const ok = env.official_basis.length >= 1 && env.citations.length >= 1;
    add('INV1', ok, `answered 要求 official_basis ≥ 1 且 citations ≥ 1，实际 official_basis=${env.official_basis.length} citations=${env.citations.length}`);
  } else {
    add('INV1', true, '非 answered，跳过');
  }

  // ---- INV3 ----
  if (env.status === STATUS.INSUFFICIENT_EVIDENCE) {
    const ok = env.steps.length === 0 && env.materials.length === 0;
    add('INV3', ok, `insufficient_evidence 时 steps/materials 必须为空数组，实际 steps=${env.steps.length} materials=${env.materials.length}`);
    if (env.conditions.length !== 0) {
      add('INV3-EXTRA', false, `insufficient_evidence 时 conditions 也应为空数组，实际 ${env.conditions.length}`);
    } else {
      add('INV3-EXTRA', true, 'conditions 为空');
    }
  } else {
    add('INV3', true, '非 insufficient_evidence，跳过');
  }

  // ---- 断言集合 ----
  const claims = [];
  if (EVIDENCE_STATUSES.includes(env.status) && env.conclusion) {
    claims.push({ where: 'conclusion', text: env.conclusion });
  }
  for (const [where, arr] of [['steps', env.steps], ['conditions', env.conditions], ['materials', env.materials]]) {
    arr.forEach((t, i) => claims.push({ where: `${where}[${i}]`, text: String(t) }));
  }

  // ---- citations 结构 / INV4 ----
  const citeIssues = [];
  const citeSeen = new Set();
  env.citations.forEach((c, i) => {
    if (!c || typeof c !== 'object') {
      citeIssues.push(`citations[${i}] 不是对象`);
      return;
    }
    if (typeof c.marker !== 'string' || !/^\[\d+\]$/.test(c.marker)) citeIssues.push(`citations[${i}].marker 形状非法：${c.marker}`);
    if (typeof c.chunk_id !== 'string' || !CHUNK_ID_RE.test(c.chunk_id)) citeIssues.push(`citations[${i}].chunk_id 形状非法：${c.chunk_id}`);
    if (typeof c.quote !== 'string' || !c.quote.trim()) citeIssues.push(`citations[${i}].quote 为空`);
    if (typeof c.quote === 'string' && Array.from(c.quote).length > 80) citeIssues.push(`citations[${i}].quote 超过 80 字`);
    if (citeSeen.has(c.marker)) citeIssues.push(`marker 重复：${c.marker}`);
    citeSeen.add(c.marker);
    if (chunkById) {
      const chunk = chunkById.get(c.chunk_id);
      if (!chunk) citeIssues.push(`citations[${i}] 的 chunk_id 在知识库中不存在：${c.chunk_id}`);
      else if (!isVerbatim(c.quote, chunk.text)) citeIssues.push(`citations[${i}].quote 不是 ${c.chunk_id} 正文的逐字子串：「${c.quote}」`);
    }
  });
  add('INV4', citeIssues.length === 0, citeIssues.join('；') + (chunkById ? '' : '（未传 kb，仅做形状校验）'));

  // ---- INV2 orphan_claims（独立重算） ----
  const orphan = [];
  const notesNotVerbatim = [];
  for (const claim of claims) {
    const t = normSpace(claim.text);
    if (!t) continue;
    let resolved = false;
    for (const c of env.citations) {
      if (!c || typeof c.quote !== 'string') continue;
      const q = normSpace(c.quote);
      if (!q) continue;
      if (chunkById) {
        const chunk = chunkById.get(c.chunk_id);
        if (chunk && isVerbatim(t, chunk.text) && isVerbatim(q, chunk.text)) {
          resolved = true;
          break;
        }
      } else if (t === q || t.startsWith(q) || q.startsWith(t) || t.includes(q)) {
        resolved = true;
        break;
      }
    }
    if (!resolved) orphan.push(claim.where);
  }
  for (const n of env.notes) {
    const t = normSpace(n);
    if (!t || isTemplateNote(t)) continue;
    let ok = false;
    for (const c of env.citations) {
      const q = normSpace(c.quote || '');
      if (!q) continue;
      if (t === q || t.startsWith(q) || t.includes(q)) {
        ok = true;
        break;
      }
    }
    if (!ok && chunkById) {
      for (const c of env.citations) {
        const chunk = chunkById.get(c.chunk_id);
        if (chunk && isVerbatim(t, chunk.text)) {
          ok = true;
          break;
        }
      }
    }
    if (!ok) notesNotVerbatim.push(t.slice(0, 40));
  }
  add('INV2', orphan.length === 0, orphan.length ? `存在无法映射到任何 citation 的断言：${orphan.join(', ')}` : '全部断言均可映射到 citation');
  add('NOTE-SAFE', notesNotVerbatim.length === 0, notesNotVerbatim.length ? `notes 中存在既非模板、又无法在资料中逐字定位的文本：${notesNotVerbatim.join(' | ')}` : 'notes 均为模板文本或逐字摘录');

  // ---- citation_check 自洽 ----
  const cc = env.citation_check || {};
  const ccIssues = [];
  const expectTotal = env.citations.length;
  if (cc.total_citations !== expectTotal) ccIssues.push(`citation_check.total_citations=${cc.total_citations} 与 citations.length=${expectTotal} 不一致`);
  if (cc.orphan_claims !== orphan.length) ccIssues.push(`citation_check.orphan_claims=${cc.orphan_claims} 与实际重算 ${orphan.length} 不一致`);
  if (!Array.isArray(cc.failures)) ccIssues.push('citation_check.failures 必须是数组');
  if (cc.valid !== (ccIssues.length === 0 && orphan.length === 0)) ccIssues.push(`citation_check.valid=${cc.valid} 与实际不符`);
  if (typeof cc.resolved_citations !== 'number') ccIssues.push('citation_check.resolved_citations 必须是数字');
  add('CITATION_CHECK', ccIssues.length === 0, ccIssues.join('；'));

  // ---- 状态策略 ----
  const policyIssues = [];
  const notesAll = env.notes.join(' ');
  if (env.status === STATUS.ANSWERED && !env.conclusion) policyIssues.push('answered 必须有 conclusion');
  if (env.status === STATUS.INSUFFICIENT_EVIDENCE) {
    if (!env.notes.length) policyIssues.push('insufficient_evidence 必须给出说明性 notes');
    if (!/(未检索到|未找到|无法确认|资料不足|不足以)/.test(`${env.conclusion} ${notesAll}`)) {
      policyIssues.push('insufficient_evidence 的结论/notes 必须明确说明"资料不足/无法确认"');
    }
  }
  if (env.status === STATUS.NEED_CLARIFICATION) {
    if (!env.plan.missing_info || env.plan.missing_info.length === 0) policyIssues.push('need_clarification 必须在 plan.missing_info 中给出缺失信息');
    if (!env.notes.length) policyIssues.push('need_clarification 必须给出追问 notes');
  }
  if (env.status === STATUS.OUT_OF_SCOPE) {
    if (!/(不予作答|不提供|超出|不会帮助|属于学术不端)/.test(env.conclusion)) {
      policyIssues.push('out_of_scope 的 conclusion 必须是明确的拒答表述');
    }
    if (!env.notes.length) policyIssues.push('out_of_scope 必须给出官方渠道等 notes');
  }
  if (env.status === STATUS.VERSION_CONFLICT) {
    if (!notesAll.includes(UPDATE_HINT)) policyIssues.push(`version_conflict 的 notes 必须包含「${UPDATE_HINT}」`);
    if (env.evidence_label !== '可能存在更新，需查最新通知') policyIssues.push('version_conflict 的 evidence_label 应为「可能存在更新，需查最新通知」');
  }
  add('POLICY', policyIssues.length === 0, policyIssues.join('；'));

  return {
    ok: violations.length === 0,
    violations,
    checks,
    stats: {
      status: env.status,
      claims: claims.length,
      citations: env.citations.length,
      orphan_claims: orphan.length,
      checked_with_kb: Boolean(chunkById),
    },
  };
}
