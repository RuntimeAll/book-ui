import { fetchEventSource } from '@microsoft/fetch-event-source'
import request from '@/http/request'

// ---------------------------------------------------------------------------
// PRD-C-009 — 图片举一反三 agent（agent-service-toolkit :8093，LangGraph）SSE 封装。
//
// 与 src/api/chat（ai-orchestrator :8092）是两套独立协议，不复用：
//   - 走 vite proxy /agent/variant/stream → rewrite 掉 /agent → :8093/variant/stream。
//   - toolkit 原生 SSE 协议（见 service.py message_generator）：
//       data: {"type":"token",  "content":"<片段>"}            ← LLM 逐字（打字机）
//       data: {"type":"message","content":<ChatMessage 全量>}  ← 节点产出的整块 AI 消息
//       data: {"type":"error",  "content":"<错误>"}
//       data: [DONE]                                            ← 流结束（🔴 非 JSON，单独判）
//   - variant agent 结果块用 AIMessage 文本沟通（DNA 外显 / 题组带 ✓⚠ / 反问 / 入库回执都在
//     message.content 文本里），前端「聊天式」逐块渲染；另有 type=custom 的 stage 帧
//     （custom_data.stage，PRD-C-010 思维外放）驱动思路条，不进消息气泡。
//
// 多轮记忆 = thread_id（toolkit checkpointer）。同一会话内所有 send 复用同一 thread_id，
// agent 才记得住「当前题组」，老师的每句话才是对题组的一条编辑指令。刷新换新 thread。
//
// 图片入口：母题图先传 OSS 拿公网 URL，把 URL 写进消息文本发出去（agent 端 _extract_image_url
// 从最近一条 human 文本里抠 URL）。toolkit 未设 AUTH_SECRET，故本调用不带鉴权头。
// ---------------------------------------------------------------------------

/** /variant/stream 请求体（toolkit StreamInput 子集） */
export interface VariantRequest {
  message: string
  /** 多轮会话标识；同会话复用 = agent 记住当前题组。省略则 toolkit 新开一轮。 */
  thread_id?: string
  /** 🔴 登录老师 RuoYi access_token：经 agent_config 透传给 toolkit，入库 owner=该老师本人。 */
  ruoyiToken?: string
}

/** toolkit ChatMessage（只取前端用得到的字段，其余宽松忽略） */
export interface ToolkitChatMessage {
  type: 'human' | 'ai' | 'tool' | 'custom'
  content: string
  custom_data?: Record<string, unknown>
  [k: string]: unknown
}

/**
 * PRD-C-010 思维外放 — stage 事件（BE 在节点内经 langgraph custom 流发出，
 * 落在 type=custom 消息的 custom_data.stage 上，content 通常为空字符串）。
 * 契约（BE/FE 严格一致）：key=七步阶段名，title=中文标题，status 三态，detail=副文。
 */
export interface VariantStage {
  key: string
  title: string
  status: 'running' | 'done' | 'warn'
  detail?: string
}

/** 从 custom 消息里安全抠出 stage（结构不符返回 null，宽松向后兼容） */
function pickStage(msg: ToolkitChatMessage): VariantStage | null {
  const raw = msg.custom_data?.stage
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Partial<VariantStage>
  if (typeof s.key !== 'string' || !s.key || typeof s.title !== 'string') return null
  return {
    key: s.key,
    title: s.title,
    status: s.status === 'done' || s.status === 'warn' ? s.status : 'running',
    detail: typeof s.detail === 'string' && s.detail ? s.detail : undefined,
  }
}

// ---------------------------------------------------------------------------
// PRD-C-011 Bucket3 — artifact 快照帧（右栏卡片栅的唯一数据源，FE 不 parse markdown 拼卡片）。
// BE 发射点 = assemble 收尾 + persist_to_bank 成功后（persisted 逐题置位）；
// 帧落在 type=custom 消息的 custom_data.artifact 上，snapshot 全量语义（FE 整量替换）。
// ---------------------------------------------------------------------------

/**
 * PRD-C-014 T2/T3 — DNA 维度（题目 DNA 面板展示 + 逐维编辑的数据源）。
 * 字段对齐 22-题目维度 SSOT §1：随 facts/item 从 BE artifact 帧流到前端。
 * 🔴 现状容差：B4 批次时 BE 的 _artifact_payload 不一定全带这些键 —— pickArtifact 对每个
 *    DNA 维都做存在性兜底（缺失 → null / 空数组），DNA 面板对空维显「未标」占位、仍可编辑补。
 */
export interface VariantDna {
  /** 主考点（知识点名，可改 → field=main_kp，知识点树选叶子回写） */
  mainKp: string | null
  /** 主考点知识点 id（树选叶子时回写；tagsByKp 候选标签按它取） */
  mainKpId: string | null
  /** 副考点 ×0~3（知识点名数组，field=secondary_kps） */
  secondaryKps: string[]
  /** 考察类型（闭集 10，见 EXAM_TYPES；field=exam_type） */
  examType: string | null
  /** 解法骨架（结构步骤，【】包最难步；点击-说话改 → revise target=skeleton） */
  skeleton: string | null
  /** 难点（半开放·克制，基础题为空；展示用，编辑随骨架/整卡 revise 联动） */
  hardPoints: string[]
  /** 标签 ×3~6（自由标签，field=tags，多选弹层 + 手输补充） */
  tags: string[]
  /** 场景（"纯代数" 或一句话场景；点击-说话改 → revise target=scene） */
  scene: string | null
  /**
   * PRD-C-015 块② — 解题模型维（双轴指纹「怎么解」轴；1~3 项，含保底 M00 概念直用）。
   * field=models，归 rewrite_solve 视觉档（改 models=换解法=重写解析）。BE 缺失 → []。
   */
  models: VariantModel[]
}

// ---------------------------------------------------------------------------
// PRD-C-015 批5 — DNA 改→重生四分流（前后端共用常量）。
// 每个 DNA 维按 regen_class 分四类，FE 据此渲染分流徽章 + 决定改后行为：
//   hard_anchor 【主考点/年级】 改 → 立即解冻重锚（清 items 重出，不进 dirty 攒批）
//   soft_regen  【题型/难度/考察类型/场景】改 → 标 dna_dirty + 角标，点「重生」统一重出
//   rewrite_solve【解法骨架/models】 改 → 重写解析（过闸B），置 dirty 直到重写完
//   meta        【标签/副考点】 改 → 只标注即时生效，不进 dirty
// 🔴 与 BE src/agents/variant.py REGEN_CLASS 严格对齐（批4 落）。
// ---------------------------------------------------------------------------
export type RegenClass = 'hard_anchor' | 'soft_regen' | 'rewrite_solve' | 'meta'

/** edit-dna 的 field 全集（批5 在批1~4 基础上扩 skeleton/hard_points/models） */
export type DnaField =
  | 'main_kp'
  | 'secondary_kps'
  | 'qtype'
  | 'exam_type'
  | 'difficulty'
  | 'tags'
  | 'scene'
  | 'grade'
  | 'skeleton'
  | 'hard_points'
  | 'models'

/** field → regen_class 映射（前后端共用常量，按 field 渲染四分流徽章） */
export const REGEN_CLASS: Record<DnaField, RegenClass> = {
  main_kp: 'hard_anchor',
  grade: 'hard_anchor',
  qtype: 'soft_regen',
  difficulty: 'soft_regen',
  exam_type: 'soft_regen',
  scene: 'soft_regen',
  skeleton: 'rewrite_solve',
  models: 'rewrite_solve',
  tags: 'meta',
  secondary_kps: 'meta',
  hard_points: 'meta',
}

/** 四分流徽章文案（FE 维度旁挂角标） */
export const REGEN_CLASS_BADGE: Record<RegenClass, { label: string; hint: string }> = {
  hard_anchor: { label: '硬锚', hint: '改→立即解冻重锚' },
  soft_regen: { label: '软重生', hint: '改→待重生，点重生统一重出' },
  rewrite_solve: { label: '重写解析', hint: '改→重写解析（过闸B）' },
  meta: { label: '只标注', hint: '改→即时生效不重出' },
}

/** 取某 field 的 regen_class（未知 field 兜底 meta，不崩） */
export function regenClassOf(field: string): RegenClass {
  return REGEN_CLASS[field as DnaField] ?? 'meta'
}

/** 解题模型维（PRD-C-015 块② models，{id,name}；归 rewrite_solve 视觉档） */
export interface VariantModel {
  id: string
  name: string
}

/** artifact 快照 — 单题（契约与 BE _artifact_payload 严格一致） */
export interface VariantArtifactItem {
  index: number
  /**
   * PRD-C-013 P2b 逐题上屏 — 稳定原位 merge 键（BE 题序号，跨增量帧不变）。
   * BE 增量帧按此键 upsert：同 seq 二次到达 = 原位更新（首帧无 tier→闸链完成补 tier）。
   * 旧后端/旧线程恢复可能缺 seq → 解析端回退用 index 兜底（见 pickArtifact）。
   */
  seq: number
  stem: string
  answer: string
  solution: string
  qtype: string
  difficulty: number
  level: string
  /** check.verify 或 check.review（证明类只有 review 键，如 proof_needs_human） */
  verify: string | null
  /**
   * 4d 外显层级（PRD-C-012 _apply_visibility）：verified/self_ok/proof/silent/both_low；
   * PRD-C-013 P2b：增量帧首发该题时无 tier（闸链未跑完）→ null，VariantCard 渲染「验算中…」
   * 过渡态；闸链完成后 BE 原位重发同 seq 带 tier。可显式取 'checking' 表过渡（向前兼容）。
   */
  tier: string | null
  /** gene.gate（平行度闸） */
  gene: string | null
  persisted: boolean
  /**
   * 题组编辑器（FE 端编辑）：BE edit-item 后置位 tier='manual'（验算待重跑的中性态）。
   * VariantCard 据此渲染中性「手动编辑」徽章 + 显示「重新验算」按钮（reverify 后变真实 tier）。
   * 注：BE 字段白名单已挡 manual_edited/from_edit 不外漏入库，故 FE 仅消费 tier='manual'。
   */
  /**
   * PRD-C-014 T2：本题 DNA 维度（主/副考点·题型·考察类型·难度·骨架·难点·场景·标签）。
   * 来源 = artifact 帧里随 item 流来的 dna 字段（或散键，pickArtifact 兼容两种形态）。
   */
  dna: VariantDna
  /**
   * PRD-C-014 T2/T3：本题任一 DNA 维被老师手动改过（BE edit-dna 置位）→ 卡显「手动编辑」徽章。
   * 兼容老 manual_edited 键；无则按 tier==='manual' 兜底（内容编辑也算改过）。
   */
  manualEdited: boolean
  /**
   * PRD-C-013 P2b：BE 后续帧标记本题被剔除（闸链判废）。true → ArtifactPanel 触发退场过渡后移除。
   * 增量 merge 语义专用；定稿帧不应再带 _dropped 的题。
   */
  _dropped?: boolean
  // ----- PRD-C-015 批4/批5 DNA 改→重生新键（BE _artifact_payload 透传，旧后端缺失向后兼容）-----
  /**
   * 批4 致命①：本题有软重生维/重写解析维改过、尚未重生 → true（标角标 + 禁入库）。
   * 软重生维（题型/难度/考察类型/场景）+ 重写解析维（骨架/models）改置位；元数据维改不置位。
   */
  dnaDirty: boolean
  /** dirty 的维列表（哪些维改了等重生；FE 在该维旁打「待重生⏳」角标） */
  dirtyDims: string[]
  /** 母题守恒维改波及本变式的维列表（D-merge8 回流；FE 全组打角标，与 dirtyDims 合并显示） */
  motherDirtyDims: string[]
  /** 本题可「撤销重生」（批4 重生前存了快照）→ true 时显示撤销入口（缺口12） */
  canUndoRegen: boolean
}

/**
 * PRD-C-014 §1 / 22-SSOT §1 — 考察类型闭集 10 种（DNA 面板「考察类型」维的下拉枚举）。
 * 顺序与 SSOT 一致；DNA 值不在此集时下拉仍可显示原值（兼容存量/异常值），但选只能选这 10。
 */
export const EXAM_TYPES = [
  '概念辨析',
  '直接计算',
  '公式套用',
  '性质判定',
  '证明推理',
  '应用建模',
  '作图',
  '探究归纳',
  '阅读理解迁移',
  '纠错',
] as const

/** PRD-C-014 §1 — 题型枚举（DNA 面板「题型」维下拉；与库值 1/4/5 语义对齐） */
export const QTYPE_OPTIONS = ['选择', '填空', '解答'] as const

/**
 * PRD-C-015 块① — 母题守恒维合并确认状态（D-merge7 确定性异常门控 + 缺口5 合并闸）。
 * BE build_mother_confirm 算（批1 就位）：flags=确定性异常标记列表（无逐维置信分）；
 * needs_confirm=(flags 非空) ∨ (年级+主考点三锚没定死) → true 时 FE 弹合并确认面。
 */
export interface VariantMotherConfirm {
  /** 确定性异常标记（FLAG_SECONDARY_KP_OOB / FLAG_EXAM_TYPE_OOB / FLAG_SKELETON_EMPTY） */
  flags: string[]
  /** 是否需要老师确认（异常或三锚未定）→ FE 外显合并确认面 */
  needsConfirm: boolean
  /** 已确认的维（老师过/改后回填，FE 据此显示已确认态） */
  confirmedDims: string[]
}

/** 确定性异常 flag → 中文提示（FE 合并确认面外显原因） */
export const MOTHER_CONFIRM_FLAG_LABEL: Record<string, string> = {
  FLAG_SECONDARY_KP_OOB: '副考点越界（不在知识图谱 / 越学段）',
  FLAG_EXAM_TYPE_OOB: '考察类型不在枚举闭集',
  FLAG_SKELETON_EMPTY: '解法骨架为空',
}

/** artifact 快照 — 画布头 */
export interface VariantArtifactHeader {
  recipe: string | null
  kp: string | null
  grade: string | null
  // ----- PRD-C-015 批4/批5 header 级新键 -----
  /** 母题守恒维改了、母题 DNA 脏（D-merge8）→ true 时下游变式全标 dirty + 禁入库 */
  motherDirty: boolean
  /** 待重生题号（1-based）数组；非空 → 「重生」按钮可点、入库按钮禁用（致命①前置 UX） */
  regenPending: number[]
  /** 母题守恒维合并确认状态（块①，弹合并确认面时读它） */
  motherConfirm: VariantMotherConfirm | null
}

/** artifact 快照（整帧 = 当前题组全量） */
export interface VariantArtifact {
  items: VariantArtifactItem[]
  header: VariantArtifactHeader
  /**
   * PRD-C-012 P2 渐进渲染 — 增量帧标记：true = 流内增量帧（items = 已完成题的
   * 全量快照，按生成序）；定稿帧没有 partial 键（解析后为 undefined = 定稿语义）。
   * 会话恢复（/variant/artifact）与入库返回天然无此键，不受影响。
   */
  partial?: boolean
  /** 增量帧宣称的本组预期总题数（BE expected_total）；占位卡数 = expectedTotal - items.length */
  expectedTotal?: number
}

// 宽松取字符串（null/空 → null）
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}
// 宽松取字符串数组（元素取 name 或自身字符串；非数组 → []）
function strArr(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const x of v) {
    if (typeof x === 'string' && x.trim()) out.push(x.trim())
    else if (x && typeof x === 'object') {
      const n = (x as Record<string, unknown>).name ?? (x as Record<string, unknown>).knowledgeName
      if (typeof n === 'string' && n.trim()) out.push(n.trim())
    }
  }
  return out
}

/**
 * PRD-C-014 T2 — 从 item 解出 DNA 维度。兼容两种 BE 形态：
 *   ① 嵌套：item.dna = {main_kp, secondary_kps, exam_type, skeleton, hard_points, tags, scene}
 *   ② 散键：上述键直接散在 item 顶层（旧/过渡形态）
 * 每维缺失 → null / 空数组（DNA 面板按「未标」占位、仍可编辑补）。
 */
function pickDna(o: Record<string, unknown>): VariantDna {
  const d = (o.dna && typeof o.dna === 'object' ? o.dna : o) as Record<string, unknown>
  return {
    mainKp: str(d.main_kp) ?? str(d.mainKp) ?? str(d.kp),
    mainKpId: str(d.main_kp_id) ?? str(d.mainKpId) ?? str(d.kp_id) ?? str(d.dim1_kp_id),
    secondaryKps:
      strArr(d.secondary_kps).length ? strArr(d.secondary_kps) : strArr(d.secondaryKps),
    examType: str(d.exam_type) ?? str(d.examType),
    skeleton: str(d.skeleton) ?? str(d.solution_skeleton),
    hardPoints:
      strArr(d.hard_points).length ? strArr(d.hard_points) : strArr(d.hardPoints),
    tags: strArr(d.tags).length ? strArr(d.tags) : strArr(d.free_tags),
    scene: str(d.scene) ?? str(d.scenario),
    // PRD-C-015 块②：models 维（[{id,name}]；兼容嵌套 d.models 或散键，缺失 → []）
    models: pickModels(d.models),
  }
}

/** 宽松取数字数组（1-based 题号；非数组 → []）—— header.regen_pending 用 */
function numArr(v: unknown): number[] {
  if (!Array.isArray(v)) return []
  const out: number[] = []
  for (const x of v) {
    const n = typeof x === 'number' ? x : Number(x)
    if (Number.isFinite(n) && n > 0) out.push(Math.floor(n))
  }
  return out
}

/**
 * PRD-C-015 块② — 从原始值解出 models（[{id,name}]）。
 * 兼容三态：[{id,name}] / ["概念直用"] 纯名字符串 / null。缺失 → []。id 雪花全 string。
 */
function pickModels(v: unknown): VariantModel[] {
  if (!Array.isArray(v)) return []
  const out: VariantModel[] = []
  for (const x of v) {
    if (typeof x === 'string' && x.trim()) {
      out.push({ id: x.trim(), name: x.trim() })
    } else if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>
      const id = o.id === null || o.id === undefined ? '' : String(o.id)
      const name = str(o.name) ?? str(o.model_name) ?? id
      if (name) out.push({ id: id || name, name })
    }
  }
  return out
}

/**
 * PRD-C-015 块① — 从原始值解出 mother_confirm（宽松；结构不符 → null）。
 * BE 缺该键（旧后端/无母题）→ null，FE 视为「无须确认」不打扰。
 */
function pickMotherConfirm(v: unknown): VariantMotherConfirm | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  return {
    flags: strArr(o.flags),
    needsConfirm: o.needs_confirm === true || o.needsConfirm === true,
    confirmedDims: strArr(o.confirmed_dims).length
      ? strArr(o.confirmed_dims)
      : strArr(o.confirmedDims),
  }
}

/** 从 custom 消息里安全抠出 artifact（镜像 pickStage 的宽松校验，结构不符返回 null） */
function pickArtifact(msg: ToolkitChatMessage): VariantArtifact | null {
  const raw = msg.custom_data?.artifact
  if (!raw || typeof raw !== 'object') return null
  const a = raw as { items?: unknown; header?: unknown }
  if (!Array.isArray(a.items)) return null
  const items: VariantArtifactItem[] = []
  for (const it of a.items) {
    if (!it || typeof it !== 'object') continue
    const o = it as Record<string, unknown>
    const index = typeof o.index === 'number' ? o.index : Number(o.index) || items.length + 1
    // P2b：seq = 稳定 merge 键，缺失（旧后端/旧帧）→ 回退用 index（与一期等价，单键不分叉）
    const seqRaw = typeof o.seq === 'number' ? o.seq : Number(o.seq)
    const tier = typeof o.tier === 'string' && o.tier ? o.tier : null
    items.push({
      index,
      seq: Number.isFinite(seqRaw) && seqRaw > 0 ? seqRaw : index,
      stem: typeof o.stem === 'string' ? o.stem : '',
      answer: typeof o.answer === 'string' ? o.answer : '',
      solution: typeof o.solution === 'string' ? o.solution : '',
      qtype: typeof o.qtype === 'string' ? o.qtype : '',
      difficulty: typeof o.difficulty === 'number' ? o.difficulty : Number(o.difficulty) || 0,
      level: typeof o.level === 'string' && o.level ? o.level : 'normal',
      verify: typeof o.verify === 'string' && o.verify ? o.verify : null,
      tier,
      gene: typeof o.gene === 'string' && o.gene ? o.gene : null,
      persisted: o.persisted === true,
      // PRD-C-014 T2：DNA 维度（兼容嵌套 o.dna 或散在 item 顶层的散键）
      dna: pickDna(o),
      // 手动编辑标记：显式 manual_edited / manualEdited，或内容编辑兜底 tier==='manual'
      manualEdited:
        o.manual_edited === true || o.manualEdited === true || tier === 'manual',
      _dropped: o._dropped === true,
      // PRD-C-015 批4/批5：DNA 改→重生新键（旧后端缺失 → false/[]，向后兼容不坏）
      dnaDirty: o.dna_dirty === true || o.dnaDirty === true,
      dirtyDims: strArr(o.dirty_dims).length ? strArr(o.dirty_dims) : strArr(o.dirtyDims),
      motherDirtyDims: strArr(o.mother_dirty_dims).length
        ? strArr(o.mother_dirty_dims)
        : strArr(o.motherDirtyDims),
      canUndoRegen: o.can_undo_regen === true || o.canUndoRegen === true,
    })
  }
  const h = (a.header && typeof a.header === 'object' ? a.header : {}) as Record<string, unknown>
  const out: VariantArtifact = {
    items,
    header: {
      recipe: typeof h.recipe === 'string' && h.recipe ? h.recipe : null,
      kp: typeof h.kp === 'string' && h.kp ? h.kp : null,
      grade: typeof h.grade === 'string' && h.grade ? h.grade : null,
      // PRD-C-015 批4/批5 header 级新键（旧后端缺失 → false/[]/null，向后兼容）
      motherDirty: h.mother_dirty === true || h.motherDirty === true,
      regenPending: numArr(h.regen_pending).length ? numArr(h.regen_pending) : numArr(h.regenPending),
      motherConfirm: pickMotherConfirm(h.mother_confirm ?? h.motherConfirm),
    },
  }
  // PRD-C-012 P2：增量帧字段宽松解析 —— partial 非 true 一律视为定稿（不设键）；
  // expected_total 非正数/非数值忽略（占位卡计算端再兜底，绝不因脏值崩渲染）。
  const ax = a as Record<string, unknown>
  if (ax.partial === true) out.partial = true
  const et = typeof ax.expected_total === 'number' ? ax.expected_total : Number(ax.expected_total)
  if (Number.isFinite(et) && et > 0) out.expectedTotal = Math.floor(et)
  return out
}

/** 逐字 token */
export interface VariantTokenEvent {
  type: 'token'
  content: string
}
/** 整块消息（节点产出，content 即要渲染的文本块） */
export interface VariantMessageEvent {
  type: 'message'
  content: ToolkitChatMessage
}
/** 服务端错误 */
export interface VariantErrorEvent {
  type: 'error'
  content: string
}

export type VariantEvent = VariantTokenEvent | VariantMessageEvent | VariantErrorEvent

/** streamVariant 回调集 */
export interface VariantStreamHandlers {
  /** 逐字 token（打字机追加） */
  onToken: (delta: string) => void
  /** 整块 AI 消息（一个新气泡） */
  onMessage: (msg: ToolkitChatMessage) => void
  /** stage 事件（type=custom 且 custom_data.stage）→ 思路条。不传则 stage 帧静默丢弃，旧行为不变 */
  onStage?: (stage: VariantStage) => void
  /** artifact 快照帧（type=custom 且 custom_data.artifact）→ 右栏卡片栅。不传则静默丢弃，向后兼容 */
  onArtifact?: (artifact: VariantArtifact) => void
  /** 服务端 error 帧 */
  onServerError?: (msg: string) => void
  /** 连接异常 / 非 SSE 响应 / 不可达。fatal 后流终止 */
  onError?: (err: unknown) => void
  /** 流自然结束（收到 [DONE] 或连接关闭） */
  onClose?: () => void
}

/** 控制句柄：调用方可主动中止 */
export interface VariantStreamHandle {
  abort: () => void
}

class NonSseResponseError extends Error {
  constructor(status: number, contentType: string) {
    super(`/variant/stream 返回非 SSE 响应: status=${status}, content-type=${contentType}`)
    this.name = 'NonSseResponseError'
  }
}

/**
 * 调 toolkit variant agent（SSE 流式）。
 *
 * @returns 控制句柄，调用方可 abort()（组件卸载 / 重新发送中止上一条）。
 *
 * 要点：
 *   - onopen 校验 res.ok + content-type 含 text/event-stream，否则抛错走兜底；
 *   - onmessage：ev.data === '[DONE]' → 收尾（toolkit 用裸 [DONE] 不是 JSON）；
 *     其余 JSON.parse 成 VariantEvent，按 type 分流（token/message/error）；
 *   - onerror throw → 阻止 fetch-event-source 默认无限重连（单轮编辑即走，不重试）；
 *   - openWhenHidden:true → 出题慢（出 3 道各自 solve 可能重生，十几次 LLM），切后台不断流。
 */
export function streamVariant(
  payload: VariantRequest,
  handlers: VariantStreamHandlers
): VariantStreamHandle {
  const ctrl = new AbortController()

  // toolkit StreamInput：message/thread_id/stream_tokens + agent_config（透传登录老师 token）。
  // ruoyi_token 走 agent_config（toolkit _handle_input 会并进 graph config.configurable），
  // 不放顶层（避免 StreamInput 未知字段）；persist 节点据此用老师身份入库。
  const body: Record<string, unknown> = {
    message: payload.message,
    stream_tokens: true,
  }
  if (payload.thread_id) body.thread_id = payload.thread_id
  if (payload.ruoyiToken) body.agent_config = { ruoyi_token: payload.ruoyiToken }

  fetchEventSource('/agent/variant/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: ctrl.signal,
    openWhenHidden: true,

    async onopen(res) {
      const ct = res.headers.get('content-type') || ''
      if (res.ok && ct.includes('text/event-stream')) return
      throw new NonSseResponseError(res.status, ct)
    },

    onmessage(ev) {
      if (!ev.data) return
      // 🔴 toolkit 流结束标志是裸字符串 [DONE]（非 JSON），单独处理
      if (ev.data === '[DONE]') {
        handlers.onClose?.()
        ctrl.abort() // 主动收尾，避免 fetch-event-source 继续等
        return
      }
      let parsed: VariantEvent
      try {
        parsed = JSON.parse(ev.data) as VariantEvent
      } catch (e) {
        console.warn('[variant] SSE 帧解析失败，跳过:', ev.data, e)
        return
      }
      switch (parsed.type) {
        case 'token':
          handlers.onToken(parsed.content)
          break
        case 'message': {
          const msg = parsed.content
          if (!msg) break
          // 🔴 PRD-C-010：custom 帧（langgraph 自定义流）数据全在 custom_data，content
          // 惯例为空串 —— 不能走下面「content 非空」过滤，按 custom_data.stage 放行。
          if (msg.type === 'custom') {
            const stage = pickStage(msg)
            if (stage) {
              handlers.onStage?.(stage)
              break // stage 帧只进思路条，不进消息气泡
            }
            // PRD-C-011：artifact 快照帧 → 右栏卡片栅（snapshot 全量替换），不进消息气泡
            const artifact = pickArtifact(msg)
            if (artifact) {
              handlers.onArtifact?.(artifact)
              break
            }
            // 无 stage / artifact 的 custom：落回旧逻辑（content 非空才透传），向后兼容
          }
          // 只渲染 AI 产出的块；human（agent 回放输入）/ 空内容忽略
          if (msg.type !== 'human' && String(msg.content || '').trim()) {
            handlers.onMessage(msg)
          }
          break
        }
        case 'error':
          handlers.onServerError?.(parsed.content || '服务处理出错')
          break
      }
    },

    onerror(err) {
      handlers.onError?.(err)
      throw err // 阻止自动重连
    },

    onclose() {
      handlers.onClose?.()
    },
  }).catch((err) => {
    if (ctrl.signal.aborted) return
    if (err instanceof NonSseResponseError) handlers.onError?.(err)
  })

  return { abort: () => ctrl.abort() }
}

// ---------------------------------------------------------------------------
// 会话持久化（2026-06-11 用户反馈③④）：toolkit checkpointer（sqlite）本来就按
// thread_id 持久了全部对话 state —— 缺的只是 FE 取回。两个取回口都走 /agent proxy
//（toolkit 原生接口，无 misikt envelope，不走 http/request 拦截器）：
//   POST /history            {thread_id} → {messages:[{type:'human'|'ai',content,...}]}
//   POST /variant/artifact   {thread_id} → VariantArtifact（右栏卡片栅重建，C 线扩展端点）
// ---------------------------------------------------------------------------

/** 取会话历史消息（回放左栏气泡）。失败抛错，调用方自行兜底（显示空会话）。 */
export async function fetchVariantHistory(threadId: string): Promise<ToolkitChatMessage[]> {
  const res = await fetch('/agent/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ thread_id: threadId }),
  })
  if (!res.ok) throw new Error(`/history ${res.status}`)
  const data = (await res.json()) as { messages?: ToolkitChatMessage[] }
  return Array.isArray(data.messages) ? data.messages : []
}

/** 全部入库直连返回 */
export interface VariantPersistResult {
  ok: boolean
  /** 入库回执（markdown，宿主作为 AI 气泡进对话流） */
  reply: string
  artifact: VariantArtifact | null
}

/**
 * 「全部入库」直连（2026-06-11 用户拍板）：确定性动作不绕 LLM 分类器，直调
 * POST /variant/persist —— BE 按 thread_id 取 checkpointer 里的当前题组，直跑
 * persist 节点同一段代码（防重簿记/血缘逻辑零分叉），回执消息同步写回对话历史。
 */
export async function persistVariantGroup(
  threadId: string,
  ruoyiToken: string
): Promise<VariantPersistResult> {
  const res = await fetch('/agent/variant/persist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ thread_id: threadId, ruoyi_token: ruoyiToken }),
  })
  if (!res.ok) {
    const detail = await res
      .json()
      .then((d: { detail?: string }) => d.detail)
      .catch(() => '')
    throw new Error(detail || `/variant/persist ${res.status}`)
  }
  const data = (await res.json()) as { ok?: boolean; reply?: string; artifact?: unknown }
  return {
    ok: data.ok === true,
    reply: typeof data.reply === 'string' ? data.reply : '',
    artifact: pickArtifact({
      type: 'custom',
      content: '',
      custom_data: { artifact: data.artifact as Record<string, unknown> },
    }),
  }
}

/** 单题入库直连返回（PRD-C-014 §3.1 T1）。 */
export interface VariantPersistOneResult {
  ok: boolean
  /** 入库落地的题目 ID（雪花，全工程 string；用于「加入试题篮」） */
  id: string
  artifact: VariantArtifact | null
}

/**
 * 单题「收录入库」（PRD-C-014 §3.1 T1）：与 persistVariantGroup 同 base / 同直连模式
 * （/agent proxy，无 misikt envelope），只入当前题组里指定的一道题。
 *   - 入参 {thread_id, index(1-based), ruoyi_token}；BE 按 thread_id 取 checkpointer 题组，
 *     只跑该题的 persist（防重簿记/血缘逻辑与全部入库同一段代码）。
 *   - 回 {ok, id, artifact}；artifact 整量替换右栏，被入库题 persisted=true（按钮置「已收录」）。
 *   - 该端点并行开发中（B3 批次按此契约写，联调期再对）。
 */
export async function persistVariantOne(
  threadId: string,
  index: number,
  ruoyiToken: string
): Promise<VariantPersistOneResult> {
  const res = await fetch('/agent/variant/persist-one', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ thread_id: threadId, index, ruoyi_token: ruoyiToken }),
  })
  if (!res.ok) {
    const detail = await res
      .json()
      .then((d: { detail?: string; error?: string }) => d.detail || d.error)
      .catch(() => '')
    throw new Error(detail || `/variant/persist-one ${res.status}`)
  }
  const data = (await res.json()) as { ok?: boolean; id?: unknown; artifact?: unknown }
  // id 雪花全工程 string（铁则：禁 number 截尾）—— BE 返 string，这里再 String() 兜底
  const id = data.id === null || data.id === undefined ? '' : String(data.id)
  return {
    ok: data.ok === true,
    id,
    artifact: pickArtifact({
      type: 'custom',
      content: '',
      custom_data: { artifact: data.artifact as Record<string, unknown> },
    }),
  }
}

/** 取会话当前题组快照（重建右栏卡片栅）。无题组返回 items=[]。 */
export async function fetchVariantArtifact(threadId: string): Promise<VariantArtifact | null> {
  const res = await fetch('/agent/variant/artifact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ thread_id: threadId }),
  })
  if (!res.ok) throw new Error(`/variant/artifact ${res.status}`)
  const raw = (await res.json()) as { items?: unknown }
  // 复用流内帧的宽松校验（同契约）
  return pickArtifact({ type: 'custom', content: '', custom_data: { artifact: raw } })
}

// ---------------------------------------------------------------------------
// 题组编辑器（傻瓜式可视化，3 个直连端点；照 /variant/persist 直连模式：BE aget_state
// → 改 → aupdate_state(as_node) → 返回 _artifact_payload）。
//   - 都走 /agent proxy（toolkit 原生接口，无 misikt envelope，不走 http/request 拦截器）；
//   - body 带 thread_id（会话键），返回 {ok:true, artifact:<_artifact_payload>}；
//   - 不入 RuoYi、无需 ruoyi_token（题组是 toolkit 会话状态，编辑不落库；「全部入库」
//     仍走既有 persistVariantGroup）。失败抛错，调用方自行兜底。
// ---------------------------------------------------------------------------

/** 题组编辑器端点的统一返回（artifact = _artifact_payload，复用 pickArtifact 解包） */
function unpackEditResult(raw: unknown): VariantArtifact | null {
  const data = (raw && typeof raw === 'object' ? raw : {}) as {
    ok?: boolean
    artifact?: unknown
    error?: string
  }
  if (data.ok === false) throw new Error(data.error || '编辑失败')
  return pickArtifact({
    type: 'custom',
    content: '',
    custom_data: { artifact: data.artifact as Record<string, unknown> },
  })
}

async function postEdit(
  path: string,
  body: Record<string, unknown>
): Promise<VariantArtifact | null> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const detail = await res
      .json()
      .then((d: { detail?: string; error?: string }) => d.detail || d.error)
      .catch(() => '')
    throw new Error(detail || `${path} ${res.status}`)
  }
  return unpackEditResult(await res.json())
}

/**
 * 拖动排序（纯代码重排，零 LLM）。order = 1-based 全排列（长度=当前题数，每号恰一次）；
 * 非法（给不全/重复/越界）BE 返 400 或 {ok:false}。返回重排后的 artifact 快照。
 */
export function reorderVariant(threadId: string, order: number[]): Promise<VariantArtifact | null> {
  return postEdit('/agent/variant/reorder', { thread_id: threadId, order })
}

/**
 * 内容编辑（只 patch 传入字段，零 LLM）。index = 1-based；只传改过的字段，其余不动。
 * BE 写回前过 _sanitize_rich_text + 标 manual_edited/from_edit + 置 tier='manual'（验算待重跑）。
 */
export function editVariantItem(
  threadId: string,
  index: number,
  patch: { stem?: string; answer?: string; solution?: string }
): Promise<VariantArtifact | null> {
  return postEdit('/agent/variant/edit-item', { thread_id: threadId, index, ...patch })
}

/**
 * 单题重新验算（on-demand，跑闸B：_solve_one + _machine_verify，只跑一题）。index = 1-based。
 * 判决仍只读 sympy verdict（铁律不破）；跑完该题 tier 变真实验算结果，清掉 manual 待验算语义。
 */
export function reverifyVariantItem(
  threadId: string,
  index: number
): Promise<VariantArtifact | null> {
  return postEdit('/agent/variant/reverify', { thread_id: threadId, index })
}

// ---------------------------------------------------------------------------
// PRD-C-014 T3/T4 — DNA 逐维编辑。两条路径，都走 /agent proxy 直连（无 misikt envelope）、
// 返回 {ok, artifact}（复用 unpackEditResult / pickArtifact 整量替换右栏）。
//
//   T3 列表选编辑（零 LLM，平台数据源）→ POST /agent/variant/edit-dna
//       契约 {thread_id, index(1-based), field, value} → {ok, artifact}
//       field ∈ main_kp | secondary_kps | qtype | exam_type | tags | difficulty
//       value 类型随 field：
//         main_kp        → {id, name}（知识点树选叶子；BE 据 id 绑定，name 展示）
//         secondary_kps  → [{id, name}, …]（≤3）
//         qtype/exam_type→ string（枚举/闭集值）
//         tags           → string[]（多选 + 手输补充）
//         difficulty     → number（点星 1-4，老师覆盖优先级最高）
//
//   T4 点击-说话 vibe（生成维）→ POST /agent/variant/revise
//       契约 {thread_id, index, target, instruction, ruoyi_token} → {ok, artifact}
//       target ∈ skeleton | scene | whole（whole = 整卡「重做这题」）
//
// 🔴 两端点均开发中，B4 批次按此契约写，联调期再对（同 persist-one 的并行开发约定）。
// ---------------------------------------------------------------------------

/**
 * edit-dna 的 value 联合类型（随 field 变；BE 按 field 解读）。
 * PRD-C-015 批5 扩：skeleton/hard_points 走文本/数组，models 走 [{id,name}]。
 */
export type DnaEditValue =
  | { id: string; name: string } // main_kp
  | Array<{ id: string; name: string }> // secondary_kps / models
  | string // qtype / exam_type / scene / grade / skeleton
  | string[] // tags / hard_points
  | number // difficulty

/**
 * T3 列表选编辑（零 LLM，平台数据源）：知识点树选叶子 / 枚举 / 标签多选 / 点星覆盖难度。
 * BE 直改 toolkit 会话 state 对应维 + 据 regen_class 路由（硬锚清 items / 软重生标 dirty /
 * 重写解析标 dirty / 元数据即时生效），返回新 artifact。
 * PRD-C-015 批5：field 扩至 11 维全集（含 skeleton/hard_points/models/scene/grade）。
 */
export function editVariantDna(
  threadId: string,
  index: number,
  field: DnaField,
  value: DnaEditValue
): Promise<VariantArtifact | null> {
  return postEdit('/agent/variant/edit-dna', {
    thread_id: threadId,
    index,
    field,
    value,
  })
}

// ---------------------------------------------------------------------------
// PRD-C-015 批5 — DNA 改→重生 / 撤销重生（批4 已落 BE 端点，直连 /agent proxy）。
//   POST /variant/regen      {thread_id, indexes?} → {ok, regenerated, failed, artifact}
//     indexes 省略 = 对全待重生集合一次性重出（软重生维 _regen_once / 重写解析维只重写 solution）。
//   POST /variant/undo-regen {thread_id, index}    → {ok, artifact}
//     回上一版快照（缺口12，零 LLM）。item.can_undo_regen=true 才有快照可回。
// 都走 /agent proxy（toolkit 原生接口，无 misikt envelope）；失败抛错，调用方兜底。
// ---------------------------------------------------------------------------

/** /variant/regen 返回（含逐题成败明细，FE 可对 failed 给精确提示） */
export interface VariantRegenResult {
  ok: boolean
  /** 重生成功的题号（1-based） */
  regenerated: number[]
  /** 重生失败的题（保留原题，FE 提示哪几题没成） */
  failed: Array<{ index: number; error: string }>
  artifact: VariantArtifact | null
}

/**
 * 重生待重生集合（手动触发，D-merge6）。indexes 省略 = 全待重生集合（变式自身脏 ∪ 母题脏波及）。
 * 重生前 BE 存快照（支持撤销），重出过闸B + 难度 rubric 复评、保留手改 manual 维（BE 语义，FE 不管）。
 */
export async function regenVariant(
  threadId: string,
  indexes?: number[]
): Promise<VariantRegenResult> {
  const body: Record<string, unknown> = { thread_id: threadId }
  if (indexes && indexes.length) body.indexes = indexes
  const res = await fetch('/agent/variant/regen', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const detail = await res
      .json()
      .then((d: { detail?: string; error?: string }) => d.detail || d.error)
      .catch(() => '')
    throw new Error(detail || `/variant/regen ${res.status}`)
  }
  const data = (await res.json()) as {
    ok?: boolean
    regenerated?: unknown
    failed?: unknown
    artifact?: unknown
  }
  const failed: Array<{ index: number; error: string }> = []
  if (Array.isArray(data.failed)) {
    for (const f of data.failed) {
      if (f && typeof f === 'object') {
        const o = f as Record<string, unknown>
        const idx = typeof o.idx === 'number' ? o.idx : Number(o.idx ?? o.index)
        if (Number.isFinite(idx)) {
          failed.push({ index: Math.floor(idx), error: str(o.error) ?? '重生失败' })
        }
      }
    }
  }
  return {
    ok: data.ok === true,
    regenerated: numArr(data.regenerated),
    failed,
    artifact: pickArtifact({
      type: 'custom',
      content: '',
      custom_data: { artifact: data.artifact as Record<string, unknown> },
    }),
  }
}

/** 撤销重生：回上一版快照（缺口12）。返回新 artifact 整量替换右栏。 */
export function undoRegenVariant(
  threadId: string,
  index: number
): Promise<VariantArtifact | null> {
  return postEdit('/agent/variant/undo-regen', { thread_id: threadId, index })
}

// 🔴 PRD-C-015 块① 母题守恒维确认 = 「非硬锁」（D-merge7）：BE 无 confirm-mother 专用端点。
//   老师「改」某守恒维 → 走 editVariantDna(field=secondary_kps/exam_type/skeleton/hard_points)；
//   老师「过」（不改直接认可）→ 纯 FE 态关闭确认面（motherConfirmDismissed），不调后端。
//   置信门控仍由 BE build_mother_confirm 算 needs_confirm，FE 据此首发外显。

/**
 * T4 点击-说话 vibe（生成维 / 整卡重做）：老师用自然语言说「哪里不对、想怎么改」，
 * BE 跑 LLM 按 instruction 重生该维（skeleton/scene）或整题（whole），返回新 artifact。
 * 透传登录老师 ruoyi_token（whole 重做后可能联动验算/血缘，owner 仍是老师本人）。
 */
export function reviseVariantItem(
  threadId: string,
  index: number,
  target: 'skeleton' | 'scene' | 'whole',
  instruction: string,
  ruoyiToken: string
): Promise<VariantArtifact | null> {
  return postEdit('/agent/variant/revise', {
    thread_id: threadId,
    index,
    target,
    instruction,
    ruoyi_token: ruoyiToken,
  })
}

// ---------------------------------------------------------------------------
// 母题图上传（book-server /teacher/variant/upload-image，misikt envelope）
//
// 与上面的 SSE 流不同源：上传走 /api 代理 → book-server :8090（鉴权/envelope 由
// http/request 拦截器统一处理，owner 由服务端 LoginHelper 强制）。BE 上传到
// sys_oss_config 默认公读桶并在 biz_variant_upload 留痕，返回的 url 公网可读
// （LLM 中转要抓这个 URL 做多模态分析）。
// ---------------------------------------------------------------------------

/** 上传成功响应（envelope 解包后的 response） */
export interface VariantUploadResult {
  id: number | string
  url: string
}

/**
 * 上传母题图，返回公网可读 URL（填进消息文本即可触发 analyze）。
 * 约束与 BE 对齐：jpg/png/webp/gif，≤10MB；不符 BE 返 code!==1 → 拦截器弹错并 reject。
 */
export function uploadMotherImage(file: File): Promise<VariantUploadResult> {
  const form = new FormData()
  form.append('file', file)
  return request.post<VariantUploadResult, VariantUploadResult>(
    '/teacher/variant/upload-image',
    form,
    {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 60000, // 10MB 图在慢网下超默认 15s
    }
  )
}
