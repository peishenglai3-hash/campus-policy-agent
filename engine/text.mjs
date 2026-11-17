/**
 * Campus Policy Agent V1.0 — 文本处理工具（零依赖 / ESM）
 *
 * 设计要点：
 *  - 中文检索单位 = bigram（二元字），零依赖、无需分词库。
 *  - 查询侧先做「词典前向最大匹配」切词，再在词内生成 bigram，
 *    避免「本科生退学怎么办理」被切成 生退 / 学怎 这类跨词垃圾二元组。
 *  - 知识库正文侧只做 Markdown 语法去格式（不是改写内容），
 *    保证 AnswerEnvelope 里的每一步都能在清洗后的 chunk.text 中逐字定位。
 */

const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
const CJK_RUN_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]+/g;

export function hasCJK(s) {
  return CJK_RE.test(String(s || ''));
}

/** 全角 → 半角（仅用于问题文本，不用于知识库正文） */
export function toHalfWidth(s) {
  return String(s || '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
}

/** 问题文本规整：BOM / 换行 / 全角 / 连续空白 */
export function normalizeQuestion(s) {
  let t = String(s == null ? '' : s);
  t = t.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  t = toHalfWidth(t);
  t = t.replace(/[\t\u00a0]+/g, ' ');
  t = t.replace(/ {2,}/g, ' ');
  t = t.replace(/[?？!！。;；,，\s]+$/g, '');
  return t.trim();
}

/** 空白规整（逐字校验时的唯一宽容：把连续空白视为一个空格） */
export function normSpace(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/**
 * 去 Markdown 语法（保留原文字符本身，不做任何改写/意译）。
 * 目的：让 chunk.text 成为"可以直接引用"的纯文本。
 */
export function cleanMarkdown(src) {
  let t = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
  t = t.replace(/\uFEFF/g, '');
  t = t.replace(/<!--[\s\S]*?-->/g, '');
  t = t.replace(/^\s{0,3}#{1,6}\s*/gm, ''); // 标题井号（### 及以下；## 已在切分时用掉）
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  t = t.replace(/__([^_\n]+)__/g, '$1');
  t = t.replace(/`([^`\n]*)`/g, '$1');
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/^\s{0,3}>\s?/gm, '');
  return t;
}

/** 常见编号前缀（"1." "（1）" "一、" "①" "-" "•" …） */
const NUM_PREFIX_RE =
  /^\s*(?:[（(]\s*(?:\d{1,2}|[一二三四五六七八九十]{1,3})\s*[)）]|第\s*[一二三四五六七八九十百\d]{1,4}\s*[条章节款项]|\d{1,2}\s*[.、)）]|[一二三四五六七八九十]{1,3}\s*[、.)）]|[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]|[-*•·▪◦]\s+)\s*/;

/** 去掉行首编号/项目符号（契约允许"逐字子串 + 编号前缀规整"） */
export function stripNumbering(s) {
  let p = String(s == null ? '' : s);
  for (let i = 0; i < 4; i += 1) {
    const n = p.replace(NUM_PREFIX_RE, '');
    if (n === p) break;
    p = n;
  }
  return p.trim();
}

/**
 * 逐字子串判定（唯一宽容：连续空白等价 + 允许行首编号前缀被去掉）
 */
export function isVerbatim(needle, haystack) {
  const n = normSpace(needle);
  if (!n) return false;
  const h = normSpace(haystack);
  if (!h) return false;
  if (h.includes(n)) return true;
  const sn = normSpace(stripNumbering(n));
  if (sn && sn !== n && h.includes(sn)) return true;
  return false;
}

/** 按字符数截断（保证结果仍是原串的子串） */
export function truncate(s, n) {
  const arr = Array.from(String(s == null ? '' : s));
  if (arr.length <= n) return arr.join('');
  return arr.slice(0, n).join('');
}

/** 行 → 句子单元（只在标点处切分，绝不改写字符） */
const SENT_SPLIT_RE = /(?<=[。！？；!?;])/;

export function splitUnits(text) {
  const out = [];
  const lines = String(text == null ? '' : text).split('\n');
  for (const line of lines) {
    const raw = line.trim();
    if (!raw) continue;
    const parts = raw.split(SENT_SPLIT_RE);
    for (const p of parts) {
      const s = p.trim();
      if (s) out.push(s);
    }
  }
  return out;
}

/** bigram 分词（知识库侧，无词典） */
export function tokenize(s) {
  const out = [];
  const text = String(s == null ? '' : s).toLowerCase();
  const re = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]+|[a-z0-9][a-z0-9._-]*/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const run = m[0];
    if (/^[a-z0-9]/.test(run)) {
      if (run.length >= 2) out.push(run);
      continue;
    }
    if (run.length === 1) out.push(run);
    else for (let i = 0; i < run.length - 1; i += 1) out.push(run.slice(i, i + 2));
  }
  return out;
}

/** 词典前向最大匹配切词（查询侧） */
export function segment(text, vocab, maxLen = 8) {
  const s = String(text == null ? '' : text);
  const segs = [];
  let i = 0;
  const buf = [];
  const flush = () => {
    if (buf.length) {
      segs.push(buf.join(''));
      buf.length = 0;
    }
  };
  while (i < s.length) {
    const ch = s[i];
    if (!CJK_RE.test(ch)) {
      const m = /^[a-zA-Z0-9._-]+/.exec(s.slice(i));
      if (m) {
        flush();
        segs.push(m[0].toLowerCase());
        i += m[0].length;
        continue;
      }
      flush();
      // 标点/空白直接丢弃
      i += 1;
      continue;
    }
    let matched = '';
    const max = Math.min(maxLen, s.length - i);
    for (let len = max; len >= 2; len -= 1) {
      const cand = s.slice(i, i + len);
      if (vocab.has(cand)) {
        matched = cand;
        break;
      }
    }
    if (matched) {
      flush();
      segs.push(matched);
      i += matched.length;
    } else {
      buf.push(ch);
      i += 1;
    }
  }
  flush();
  return segs;
}

/** 词典切词后生成查询 token（词内 bigram + 已知单字组合） */
export function queryTokens(text, vocab, knownBigram) {
  const segs = segment(text, vocab);
  const out = [];
  const singles = [];
  for (const seg of segs) {
    if (/^[a-z0-9]/.test(seg)) {
      out.push(seg);
      continue;
    }
    if (seg.length === 1) {
      out.push(seg);
      singles.push(seg);
      continue;
    }
    if (seg.length === 2) {
      out.push(seg);
      continue;
    }
    if (seg.length <= 8) {
      // 长词：整体不作为 token（索引里没有长词），用词内 bigram
      for (let i = 0; i < seg.length - 1; i += 1) out.push(seg.slice(i, i + 2));
      continue;
    }
    for (let i = 0; i < seg.length - 1; i += 1) out.push(seg.slice(i, i + 2));
  }
  // 相连的单字：只有当组合在知识库里出现过（knownBigram）才合并
  for (let i = 0; i < singles.length - 1; i += 1) {
    const bi = singles[i] + singles[i + 1];
    if (knownBigram && knownBigram.has(bi)) out.push(bi);
  }
  return out;
}

/** bigram 集合（用于标题相似度） */
export function bigramSet(s) {
  return new Set(tokenize(s));
}

export function jaccard(aSet, bSet) {
  if (!aSet.size || !bSet.size) return 0;
  let inter = 0;
  for (const x of aSet) if (bSet.has(x)) inter += 1;
  return inter / (aSet.size + bSet.size - inter);
}

export function jaccardText(a, b) {
  return jaccard(bigramSet(a), bigramSet(b));
}

/** 提取正文中的 CJK 片段（用于从问题里抠主题词） */
export function cjkRuns(s) {
  return String(s == null ? '' : s).match(CJK_RUN_RE) || [];
}

export function uniq(arr) {
  return Array.from(new Set(arr));
}

export function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    const k = keyFn(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

export function pad3(n) {
  return String(n).padStart(3, '0');
}

export function nowIso() {
  return new Date().toISOString();
}

/** ISO 时间戳 → 文件名安全（Windows 不允许 ':'） */
export function stampForFile(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-');
}
