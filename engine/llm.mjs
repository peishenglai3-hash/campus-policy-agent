/**
 * Campus Policy Agent V1.0 — LLM 适配器（零依赖 / ESM）
 *
 * 契约第 4 节：
 *   getLLM() -> { available, reason, chat(messages, opts): Promise<string> }
 *   - 读 process.env.DEEPSEEK_API_KEY；无 key 或 401 → available:false
 *   - **严禁硬编码任何 key**（deepseek API key.txt 里的 key 已确认失效返回 401，仅作占位说明）
 *   - LLM 不可用时 answer() 自动回落确定性抽取式回答，不抛错
 */

const DEFAULT_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const DEFAULT_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const TIMEOUT_MS = Number(process.env.DEEPSEEK_TIMEOUT_MS || 20000);

/** 运行时探测状态：一旦确认 401/无权限，就不再反复尝试 */
const probe = {
  authFailed: false,
  reason: '',
  lastError: '',
  lastLatencyMs: null,
  calls: 0,
};

function noopChat() {
  return async () => {
    throw new Error(`LLM 不可用：${probe.reason || '未配置 DEEPSEEK_API_KEY'}`);
  };
}

function readKey() {
  const k = process.env.DEEPSEEK_API_KEY;
  return typeof k === 'string' ? k.trim() : '';
}

/** 契约 API：同步返回可用性 + chat 实现 */
export function getLLM() {
  const key = readKey();
  if (!key) {
    probe.reason = '未配置环境变量 DEEPSEEK_API_KEY（引擎不硬编码任何 API key）';
    return { available: false, reason: probe.reason, chat: noopChat() };
  }
  if (probe.authFailed) {
    probe.reason = `DEEPSEEK_API_KEY 调用失败（${probe.lastError || '401'}），已回落确定性模式`;
    return { available: false, reason: probe.reason, chat: noopChat() };
  }
  return {
    available: true,
    reason: '已配置 DEEPSEEK_API_KEY，可调用大模型增强',
    model: DEFAULT_MODEL,
    baseUrl: DEFAULT_BASE_URL,
    async chat(messages, opts = {}) {
      const started = Date.now();
      probe.calls += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs || TIMEOUT_MS);
      try {
        const res = await fetch(`${opts.baseUrl || DEFAULT_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            model: opts.model || DEFAULT_MODEL,
            messages,
            temperature: opts.temperature === undefined ? 0 : opts.temperature,
            stream: false,
          }),
          signal: controller.signal,
        });
        probe.lastLatencyMs = Date.now() - started;
        if (res.status === 401 || res.status === 403) {
          probe.authFailed = true;
          probe.lastError = `HTTP ${res.status}`;
          const err = new Error(`DEEPSEEK_API_KEY 鉴权失败（HTTP ${res.status}）`);
          err.status = res.status;
          throw err;
        }
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          probe.lastError = `HTTP ${res.status}`;
          const err = new Error(`LLM 调用失败 HTTP ${res.status}: ${body.slice(0, 200)}`);
          err.status = res.status;
          throw err;
        }
        const data = await res.json();
        const text = data && data.choices && data.choices[0] && data.choices[0].message
          ? data.choices[0].message.content
          : '';
        return String(text || '');
      } catch (err) {
        probe.lastError = err && err.message ? err.message : String(err);
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function llmStatus() {
  const l = getLLM();
  return {
    available: l.available,
    reason: l.reason,
    model: DEFAULT_MODEL,
    baseUrl: DEFAULT_BASE_URL,
    calls: probe.calls,
    last_latency_ms: probe.lastLatencyMs,
  };
}

/** 从模型输出里抠出 JSON（容忍 ```json 代码块与前后解释文字） */
export function extractJson(text) {
  const s = String(text == null ? '' : text);
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  const candidate = fence ? fence[1] : s;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}
