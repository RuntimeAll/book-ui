import { computed, ref, type CSSProperties } from 'vue'

// ---------------------------------------------------------------------------
// PRD-C-009 — 题目展示字号（小 / 中 / 大）全局可调，跨页一致。
//
// 用途：变式题组编辑器（VariantCard 预览）与个人题库（题库列表卡 / 题目详情）
//   共用同一个 MarkdownMath 渲染组件，再共用同一份字号状态 —— 老师在任一处调字号，
//   两边同步放大/缩小，且「这里做成什么样，个人题库打开就一样」。
//
// 实现：
//   - 模块级单例 ref（scale）：所有 useFontScale() 调用方共享同一状态，一处改处处变。
//   - 持久化 localStorage：刷新/换页后记住老师偏好。
//   - cssVars：把当前字号注成 CSS 变量 --md-font-size，绑在含 MarkdownMath 的容器
//     根上即可级联生效（MarkdownMath 的 .md-math 读 var(--md-font-size, 14px)，
//     未设变量处保持 14px 默认 —— 聊天气泡等不受影响）。
// ---------------------------------------------------------------------------

export type FontScaleKey = 'small' | 'medium' | 'large'

/** 三档对应的基准字号（px）。medium=16 比旧默认 14 略大，缓解「太小看着累」。 */
const SIZE_PX: Record<FontScaleKey, number> = {
  small: 14,
  medium: 16,
  large: 19,
}

export const FONT_SCALE_OPTIONS: ReadonlyArray<{ key: FontScaleKey; label: string }> = [
  { key: 'small', label: '小' },
  { key: 'medium', label: '中' },
  { key: 'large', label: '大' },
]

const STORAGE_KEY = 'qbank-font-scale'

function readInitial(): FontScaleKey {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'small' || v === 'medium' || v === 'large') return v
  } catch {
    // localStorage 不可用（隐私模式等）→ 用默认，不报错
  }
  return 'medium'
}

// 单例：模块加载时初始化一次，全应用共享
const scale = ref<FontScaleKey>(readInitial())

export function useFontScale() {
  const px = computed(() => SIZE_PX[scale.value])

  function setScale(s: FontScaleKey) {
    scale.value = s
    try {
      localStorage.setItem(STORAGE_KEY, s)
    } catch {
      // 持久化失败不影响本次会话内的即时生效
    }
  }

  /** 绑到含 MarkdownMath 的容器根 :style 上，使其子树 MarkdownMath 按当前字号渲染。 */
  const cssVars = computed<CSSProperties>(() => ({
    '--md-font-size': `${px.value}px`,
  }))

  return { scale, px, setScale, cssVars }
}
