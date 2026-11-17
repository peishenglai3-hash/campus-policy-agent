/**
 * Campus Policy Agent V1.0 — 知识库解析（零依赖 / ESM）
 *
 * 职责：解析 `02_KNOWLEDGE_BASE/**\/*.md`
 *   1. 手写 YAML front-matter 解析器（只支持 `key: value` 单行 + 简单列表/引号）
 *   2. `## 小节标题` 切分 chunk
 *   3. 生成 chunk_id = `<doc_id>#<3位序号>`
 *
 * 契约参考：_INTERFACES.md 第 1、2 节。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHUNK_ID_RE, TIER_ORDER, UNKNOWN, NONE } from './constants.mjs';
import { cleanMarkdown, pad3 } from './text.mjs';

const __filename = fileURLToPath(import.meta.url);
export const ENGINE_DIR = path.dirname(__filename);
export const PROJECT_ROOT = path.resolve(ENGINE_DIR, '..');
export const DEFAULT_KB_ROOT = path.join(PROJECT_ROOT, 'examples', 'knowledge');
export const FIXTURE_KB_ROOT = path.join(PROJECT_ROOT, 'examples', 'knowledge');

/** 契约第 1 节：字段名固定，缺失写 未知，不得省略字段 */
export const FRONT_MATTER_FIELDS = Object.freeze([
  'doc_id', 'title', 'tier', 'source_org', 'source_url', 'source_type',
  'retrieved_at', 'version', 'effective_date', 'supersedes', 'contact',
  'shareable', 'contains_personal_data', 'notes',
]);

/** 逐行解析 front-matter（够用即可：key: value，支持引号与行内 # 注释以外的原样值） */
export function parseFrontMatter(raw) {
  const text = String(raw == null ? '' : raw).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!m) return { data: {}, body: text, hasFrontMatter: false };
  const data = {};
  for (const line of m[1].split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const idx = s.indexOf(':');
    if (idx <= 0) continue;
    const key = s.slice(0, idx).trim();
    let value = s.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (/^\[.*\]$/.test(value)) {
      value = value
        .slice(1, -1)
        .split(',')
        .map((x) => x.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    }
    if (value === '') value = UNKNOWN;
    data[key] = value;
  }
  return { data, body: text.slice(m[0].length), hasFrontMatter: true };
}

function asBool(v) {
  if (typeof v === 'boolean') return v;
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (['true', 'yes', '1', '是'].includes(s)) return true;
  if (['false', 'no', '0', '否'].includes(s)) return false;
  return null;
}

function inferTierFromPath(rel) {
  const first = String(rel).split(/[\\/]/)[0] || '';
  const m = /^(A[0-5])/.exec(first);
  return m ? m[1] : UNKNOWN;
}

function normalizeTier(v, rel) {
  const t = String(v == null ? '' : v).trim().toUpperCase();
  if (TIER_ORDER.includes(t)) return t;
  return inferTierFromPath(rel);
}

/** 递归收集 .md（跳过 `_` 前缀目录/文件，例如 _manifest / _SCHEMA.md / README.md） */
export function listMarkdownFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    for (const e of entries) {
      if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
      if (/^readme\.md$/i.test(e.name)) continue; // 说明性占位文件不是知识卡
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && /\.md$/i.test(e.name)) out.push(full);
    }
  };
  walk(root);
  return out;
}

/**
 * 契约 v3：`source_url` 允许 `;` 分隔多个 URL。
 * 返回规范化 URL 列表（供前端渲染成多个 <a>，不得整串当 href）。
 */
export function splitSourceUrls(value) {
  return String(value == null ? '' : value)
    .split(/[;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s && s !== UNKNOWN && s !== NONE);
}

/** `## 小节` 切分；`#`/`###` 等其它层级保持原样留在正文里 */
export function splitSections(body) {
  const text = String(body == null ? '' : body).replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const sections = [];
  let cur = { section: '', lines: [] };
  for (const line of lines) {
    const m = /^##[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (m) {
      sections.push(cur);
      cur = { section: m[1].trim(), lines: [] };
      continue;
    }
    // 顶级 `# 标题` 与文档 title 重复，不作为小节但也不进正文
    if (/^#[ \t]+/.test(line) && cur.lines.length === 0 && sections.length === 0) continue;
    cur.lines.push(line);
  }
  sections.push(cur);
  return sections
    .map((s) => ({
      section: s.section,
      text: cleanMarkdown(s.lines.join('\n')).replace(/\n{3,}/g, '\n\n').trim(),
    }))
    .filter((s) => s.text.length > 0);
}

function docFromFile(file, root) {
  const rel = path.relative(root, file).split(path.sep).join('/');
  const raw = fs.readFileSync(file, 'utf8');
  const { data, body, hasFrontMatter } = parseFrontMatter(raw);
  const warnings = [];
  if (!hasFrontMatter) warnings.push(`${rel}: 缺少 YAML front-matter，已按文件名兜底`);
  // 编码健壮性：非法 UTF-8 会被 Node 替换为 U+FFFD；中文正文缺失也可疑（GBK 误存的特征）
  const badChars = (raw.match(/\uFFFD/g) || []).length;
  if (badChars > 0) warnings.push(`${rel}: 检测到 ${badChars} 个非法 UTF-8 替换字符（U+FFFD），文件可能不是 UTF-8 编码`);
  const cjkCount = (body.match(/[\u4E00-\u9FFF]/g) || []).length;
  const bodyLen = body.replace(/\s/g, '').length;
  if (bodyLen > 40 && cjkCount / bodyLen < 0.15) {
    warnings.push(`${rel}: 正文中文占比仅 ${(cjkCount / bodyLen * 100).toFixed(1)}%，疑似编码错误或非中文页面`);
  }
  if (bodyLen > 0 && bodyLen < 40) warnings.push(`${rel}: 正文异常短（${bodyLen} 字），可能抓取失败（如验证码拦截页），已保留但不建议引用`);
  const doc = {};
  for (const f of FRONT_MATTER_FIELDS) {
    let v = data[f];
    if (Array.isArray(v)) v = v.join('; ');
    if (v === undefined || v === null || v === '') v = UNKNOWN;
    doc[f] = v;
  }
  doc.tier = normalizeTier(doc.tier, rel);
  doc.shareable = asBool(doc.shareable);
  doc.contains_personal_data = asBool(doc.contains_personal_data);
  if (!doc.doc_id || doc.doc_id === UNKNOWN) {
    const base = path.basename(file, '.md');
    doc.doc_id = `${doc.tier}-UNKNOWN-${base.slice(0, 24)}`;
    warnings.push(`${rel}: 缺少 doc_id，已用文件名兜底为 ${doc.doc_id}`);
  }
  if (doc.supersedes === '' || doc.supersedes == null) doc.supersedes = NONE;
  doc.file = rel;
  doc.warnings = warnings;
  return { doc, body, warnings };
}

function chunkId(docId, seq) {
  return `${docId}#${pad3(seq)}`;
}

/**
 * 加载知识库。
 * @param {string} [kbRoot] 知识库根目录（默认 02_KNOWLEDGE_BASE，可用 HUST_KB_ROOT 覆盖）
 * @returns {{docs: Array, chunks: Array, root: string, warnings: string[], exists: boolean}}
 */
export function loadKB(kbRoot) {
  const root = path.resolve(kbRoot || process.env.HUST_KB_ROOT || DEFAULT_KB_ROOT);
  const warnings = [];
  const docs = [];
  const chunks = [];
  if (!fs.existsSync(root)) {
    warnings.push(`知识库目录不存在：${root}`);
    return { docs, chunks, root, warnings, exists: false };
  }
  const files = listMarkdownFiles(root);
  if (files.length === 0) warnings.push(`知识库目录为空：${root}`);

  for (const file of files) {
    let parsed;
    try {
      parsed = docFromFile(file, root);
    } catch (err) {
      warnings.push(`${path.relative(root, file)}: 读取失败 ${err && err.message}`);
      continue;
    }
    const { doc, body } = parsed;
    warnings.push(...parsed.warnings);
    if (doc.shareable === false) {
      warnings.push(`${doc.file}: shareable=false，按契约不得入库，已跳过`);
      continue;
    }
    if (doc.contains_personal_data === true) {
      warnings.push(`${doc.file}: contains_personal_data=true，按契约不得入库，已跳过`);
      continue;
    }
    const sections = splitSections(body);
    const docChunks = [];
    let seq = 0;
    for (const s of sections) {
      seq += 1;
      docChunks.push({
        chunk_id: chunkId(doc.doc_id, seq),
        doc_id: doc.doc_id,
        tier: doc.tier,
        title: doc.title,
        section: s.section,
        text: s.text,
        source_org: doc.source_org,
        source_url: doc.source_url,
        retrieved_at: doc.retrieved_at,
        version: doc.version,
        seq,
      });
    }
    if (docChunks.length === 0) {
      warnings.push(`${doc.file}: 正文没有任何 '## 小节'，未生成 chunk`);
    }
    doc.chunk_count = docChunks.length;
    doc.sections = docChunks.map((c) => c.section);
    docs.push(doc);
    chunks.push(...docChunks);
  }

  // chunk_id 唯一性自检（doc_id 重复时必须暴露出来）
  const seen = new Map();
  for (const c of chunks) {
    if (seen.has(c.chunk_id)) {
      warnings.push(`chunk_id 重复：${c.chunk_id}（doc_id 可能重复）`);
    }
    seen.set(c.chunk_id, c);
    if (!CHUNK_ID_RE.test(c.chunk_id)) {
      warnings.push(`chunk_id 形状不合契约：${c.chunk_id}`);
    }
  }

  const kb = { docs, chunks, root, warnings, exists: true };
  try {
    Object.defineProperty(kb, '__root', { value: root, enumerable: false });
  } catch {
    /* ignore */
  }
  return kb;
}

/** 该知识库是否可用于回答（至少 1 个 chunk） */
export function kbUsable(kb) {
  return Boolean(kb && Array.isArray(kb.chunks) && kb.chunks.length > 0);
}

/** 解析 01_SOURCE_MANIFEST.csv（server 的 /api/campus/sources 用） */
export function parseCsv(text) {
  const rows = [];
  const src = String(text == null ? '' : text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  const clean = rows.filter((r) => r.some((c) => String(c).trim() !== ''));
  if (clean.length === 0) return [];
  const header = clean[0].map((h) => h.trim());
  return clean.slice(1).map((r) => {
    const o = {};
    header.forEach((h, i) => {
      o[h] = (r[i] == null ? '' : r[i]).trim();
    });
    return o;
  });
}

export function loadSourceManifest(projectRoot = PROJECT_ROOT) {
  const p = path.join(projectRoot, '01_SOURCE_MANIFEST.csv');
  if (!fs.existsSync(p)) return [];
  try {
    return parseCsv(fs.readFileSync(p, 'utf8'));
  } catch {
    return [];
  }
}
