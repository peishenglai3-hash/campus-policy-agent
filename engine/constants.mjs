/**
 * Campus Policy Agent V1.0 — 全局常量（零依赖 / ESM）
 *
 * 严格对齐 `_INTERFACES.md`：
 *  - 第 3 节 AnswerEnvelope 枚举（不得新造）
 *  - 第 3 节硬性不变量
 *  - 第 7 节写域（本文件位于 engine/ 内）
 */

/** 硬性不变量 5：disclaimer 恒为该固定文案 */
export const DISCLAIMER = '合成演示内容，仅用于软件示例；不代表任何机构的正式政策或服务。';

/** status 枚举（契约第 3 节，逐字一致） */
export const STATUS = Object.freeze({
  ANSWERED: 'answered',
  INSUFFICIENT_EVIDENCE: 'insufficient_evidence',
  NEED_CLARIFICATION: 'need_clarification',
  OUT_OF_SCOPE: 'out_of_scope',
  VERSION_CONFLICT: 'version_conflict',
});
export const STATUS_VALUES = Object.freeze(Object.values(STATUS));

/** 有资料依据的状态（这两类才允许出现"来自资料"的断言） */
export const EVIDENCE_STATUSES = Object.freeze([
  STATUS.ANSWERED,
  STATUS.VERSION_CONFLICT,
]);

/** evidence_label 枚举（契约第 3 节，三选一，必须出现） */
export const EVIDENCE_LABEL = Object.freeze({
  SPECIFIED: '资料明确规定',
  NOT_SPECIFIED: '资料未明确规定',
  MAY_UPDATE: '可能存在更新，需查最新通知',
});
export const EVIDENCE_LABEL_VALUES = Object.freeze(Object.values(EVIDENCE_LABEL));

/** plan.intent 枚举（契约第 3 节，8 类） */
export const INTENT = Object.freeze({
  PROCEDURE: '流程类',
  MATERIAL: '材料类',
  CONDITION: '条件类',
  TIME: '时间要求',
  FEE: '费用类',
  EXPLAIN: '解释类',
  BOUNDARY: '边界类',
  MULTI: '多意图',
});
export const INTENT_VALUES = Object.freeze(Object.values(INTENT));

/** mode 枚举 */
export const MODE_VALUES = Object.freeze(['deterministic', 'llm']);

/** tier 优先级：A0 > A1 > A2 > A3 > A4 > A5（契约第 1 节目录约定） */
export const TIER_ORDER = Object.freeze(['A0', 'A1', 'A2', 'A3', 'A4', 'A5']);
export const TIER_WEIGHT = Object.freeze({
  A0: 1.5,
  A1: 1.35,
  A2: 1.25,
  A3: 1.15,
  A4: 1.08,
  A5: 1.0,
});

/** chunk_id 形状：<doc_id>#<3位序号> */
export const CHUNK_ID_RE = /^[^#\s]+#\d{3}$/;

export const UNKNOWN = '未知';
export const NONE = '无';

/** 版本冲突时必须出现的提示语（契约/任务书要求「可能存在更新，需查最新通知」） */
export const UPDATE_HINT = '可能存在更新，需查最新通知';

/** 非证据型状态的结论模板（模板不是"来自资料的断言"，故不参与逐字校验） */
export const TEMPLATE_CONCLUSIONS = Object.freeze({
  [STATUS.INSUFFICIENT_EVIDENCE]:
    '知识库中未检索到与该问题直接相关的官方资料，无法确认具体办理方式，请以学校官方渠道发布的最新通知为准。',
  [STATUS.NEED_CLARIFICATION]:
    '该问题涉及多种情形，需要补充关键信息后，才能给出对应的官方依据与办理流程。',
  [STATUS.OUT_OF_SCOPE]:
    '该问题超出校园办事知识库的回答范围，本工具不予作答；请通过学校官方渠道咨询。',
});

/** 模板型 notes 的正则（模板文本不参与"逐字子串"校验） */
export const TEMPLATE_NOTE_RES = Object.freeze([
  /^可能存在更新/,
  /^资料中未找到关于/,
  /^本工具基于静态官方资料/,
  /^本工具不提供/,
  /^本工具不会帮助/,
  /^本回答为官方资料逐字摘录/,
  /^本回答由大模型/,
  /^如需办理/,
  /^该问题涉及/,
  /^代写作业/,
  /^学业与职业规划/,
  /^请以/,
  /^补充信息后/,
  /^需要补充/,
  /^可参考的官方文件/,
  /^质量门禁回落/,
  /^本次检索到的资料与问题相关度有限/,
  /^资料中未明确规定该事项的费用金额/,
  /^资料不足说明/,
  /^另：该问题本身涉及多种情形/,
]);

/** 检索默认参数 */
export const DEFAULTS = Object.freeze({
  topK: 6,
  internalTopK: 8,
  mergedTopK: 12,
  tierBoost: true,
  bm25: Object.freeze({ k1: 1.2, b: 0.75 }),
  /** 证据充分性阈值（经验值，见 WORKFLOW.md / README 说明） */
  gate: Object.freeze({
    /** 常规问题：查询词加权覆盖率下限 */
    coverage: 0.45,
    /** 含"实时/动态"标记的问题：覆盖率下限更高（静态知识库无法回答实时信息） */
    dynamicCoverage: 0.6,
    /** 部分充分：有相关证据但覆盖不足，仍作答但标注"资料未明确规定" */
    weakCoverage: 0.3,
    /** 至少命中 1 个原查询词 */
    minRawHits: 1,
    /** top1 BM25 得分下限 */
    minScore: 0.8,
    /** top1 强命中兜底：得分 ≥ strongScore 且命中 ≥ strongRawHits 个原词且标题/小节与主题词有交集 */
    strongScore: 3.0,
    strongRawHits: 2,
    /** 覆盖率计算时 idf 上限，避免"知识库里根本没有的词"主导分母 */
    idfCap: 3.0,
    /** 单字查询词权重（区分度低，降权） */
    singleCharWeight: 0.6,
    /** 同义词扩展项权重 */
    expansionWeight: 0.35,
  }),
});
