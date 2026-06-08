import { defineConfig, presetWind3, presetAttributify, presetIcons } from 'unocss'

/**
 * UnoCSS 配置
 * 设计 token 系统事实源 = workplace/产品规划/DESIGN.md §3/§4/§5
 * 方向：清新理性 · 数学底色 · AI 在场而不喧宾（青主色 teal + 紫 AI violet + 冷浅清新底）
 * 🔴 改 token 必先对齐 DESIGN.md（代码先于文档 = 代码错）。
 *
 * 命名约定：
 * - 语义 token（DESIGN §3 权威名）：teal-* / violet-* / ink-* / bg-* / border-* / 语义色（green/amber/red）
 * - 兼容别名（primary / text-* / bg.* / border.* / success / warning / danger / info）：
 *   保留旧别名但全部映射到新冷青系色值，让存量组件引用平滑变青（PRD-A-010 T2 再逐步替换为语义名）。
 */
export default defineConfig({
  presets: [
    presetWind3(),
    presetAttributify(),
    presetIcons({
      scale: 1.2,
      warn: true,
      collections: {
        ep: () => import('@iconify-json/ep/icons.json').then((i) => i.default),
      },
    }),
  ],

  theme: {
    colors: {
      // ── DESIGN §3.2 品牌色（青 · 主色，老师的事）────────────────────
      teal: {
        800: '#145C5C', // 青最深 · 极少
        700: '#176E6E', // 青深 · hover/active
        600: '#1E8A8A', // 青主 · 主 CTA / 选中态 / 激活导航 / logo / 链接
        500: '#2BA3A3', // 青亮 · 强调数字 / 渐变上端
        50: '#E6F2F2', // 青极浅底 · 选中 tag 底 / hover 底
      },
      // ── DESIGN §3.3 AI 在场色（紫 · AI 专用，AI 的事）──────────────
      violet: {
        700: '#5B4FD6', // 紫深 · AI 文字强调 / AI 按钮 hover
        600: '#7B6CF0', // 紫主 · AI 触发按钮 / 思路条左条 / 流式光标 / AI 激活导航
        500: '#9285F4', // 紫亮 · "正在思考" 闪烁
        50: '#F2F0FE', // 紫浅底 · 思路条 / AI 卡片底 / AI 气泡底
      },
      // ── DESIGN §3.1 中性色（冷浅系，全站铺底）──────────────────────
      bg: {
        DEFAULT: '#F5F8F8', // = bg-50 页面主背 · 冷浅清新（兼容别名）
        50: '#F5F8F8', // 页面主背
        100: '#EDF2F2', // 区块次背 / hover
        200: '#E3EAEA', // 分隔带 / disabled 背
        card: '#FFFFFF', // 卡片底
        sidebar: '#FFFFFF', // 侧栏底
        hover: '#EDF2F2', // hover（= bg-100，兼容别名）
      },
      ink: {
        900: '#1D2A2E', // 主文 · 冷墨
        700: '#33464C', // 次主文 / 强调副文
        500: '#536268', // 正文次级
        400: '#7C8B91', // 辅文 / 注释
        300: '#A6B2B6', // 占位 / disabled 文字
      },
      // 文字色兼容别名 → 映射到 ink-*
      text: {
        primary: '#1D2A2E', // = ink-900
        regular: '#536268', // = ink-500
        secondary: '#7C8B91', // = ink-400
        placeholder: '#A6B2B6', // = ink-300
      },
      // 边框色（DESIGN §3.1 / §5.4）
      border: {
        DEFAULT: '#E3E9E9',
        strong: '#D2DCDC', // 深边框 / 输入框
        light: '#EDF2F2', // 浅分割（= bg-100）
        dark: '#D2DCDC', // 兼容别名（= border-strong）
      },
      // ── DESIGN §3.4 语义色 ──────────────────────────────────────
      green: {
        600: '#0E9F6E', // 成功 · 偏青祖母绿
        50: '#E3F5EE', // 成功 tag 底
      },
      amber: {
        500: '#E0A23C', // 警告 · 暖琥珀（仅难度星 / 提醒小点）
      },
      red: {
        500: '#E5484D', // 危险 · 克制红
        50: '#FDECEC', // 错误底
      },
      // ── 兼容别名（存量组件 el-tag type / primary 引用 → 全部冷青化）──
      primary: {
        DEFAULT: '#1E8A8A', // = teal-600
        light: '#2BA3A3', // = teal-500
        lighter: '#E6F2F2', // = teal-50
        dark: '#176E6E', // = teal-700
        hover: '#176E6E', // = teal-700
      },
      success: {
        DEFAULT: '#0E9F6E', // = green-600
        light: '#9FE3CB',
        lighter: '#E3F5EE', // = green-50
        dark: '#0B7E58',
      },
      warning: {
        DEFAULT: '#E0A23C', // = amber-500
        light: '#F3D8A8',
        lighter: '#FBF1E0',
        dark: '#B97F25',
      },
      danger: {
        DEFAULT: '#E5484D', // = red-500
        light: '#F3A5A8',
        lighter: '#FDECEC', // = red-50
        dark: '#C23A3E',
      },
      info: {
        DEFAULT: '#7C8B91', // = ink-400
        light: '#A6B2B6', // = ink-300
        lighter: '#EDF2F2', // = bg-100
      },
    },
    // DESIGN §5.1 间距（4px grid）— 保留
    spacing: {
      '1': '4px',
      '2': '8px',
      '3': '12px',
      '4': '16px',
      '5': '20px',
      '6': '24px',
      '8': '32px',
      '10': '40px',
      '12': '48px',
      '16': '64px',
    },
    // DESIGN §5.2 圆角（中等柔和 · 8-10px 为主）
    borderRadius: {
      none: '0', // sharp（仅分隔带）
      sm: '4px', // chip / tag / small button
      DEFAULT: '6px', // input / button
      md: '8px', // small card / dropdown
      lg: '10px', // card / 主面板（最常用）
      xl: '14px', // modal / drawer / 主画布容器（封顶）
      '2xl': '14px', // 收敛到 xl（不再 20px 大圆角）
      full: '9999px', // 头像 / 圆点状态
    },
    // DESIGN §5.3 阴影（冷中性 · rgba(29,42,46,*)，去蓝去暖）
    boxShadow: {
      sm: '0 1px 2px 0 rgba(29,42,46,0.04)', // 悬浮微抬
      DEFAULT: '0 2px 8px 0 rgba(29,42,46,0.06)', // 卡片默认
      md: '0 4px 12px 0 rgba(29,42,46,0.08)', // hover 加深
      lg: '0 8px 24px 0 rgba(29,42,46,0.10)', // modal / drawer
      teal: '0 2px 6px 0 rgba(30,138,138,0.20)', // 青 CTA 专属
      violet: '0 2px 8px 0 rgba(123,108,240,0.20)', // 紫 AI 元素专属（轻微辉光）
      // 兼容别名（存量 shadow-card / shadow-float / shadow-header 引用 → 冷中性化）
      card: '0 2px 8px 0 rgba(29,42,46,0.06)', // = DEFAULT
      'card-hover': '0 8px 24px 0 rgba(29,42,46,0.10)', // = lg
      header: '0 2px 12px 0 rgba(29,42,46,0.06)',
      float: '0 8px 24px 0 rgba(29,42,46,0.10)', // 去蓝（原 rgba(64,128,255,0.2)）
    },
  },

  shortcuts: {
    // 通用布局
    'flex-center': 'flex items-center justify-center',
    'flex-between': 'flex items-center justify-between',
    'flex-start': 'flex items-center justify-start',
    'flex-col-center': 'flex flex-col items-center justify-center',

    // ── 卡片（DESIGN §7.1）────────────────────────────────────────
    'card-base': 'bg-white rounded-lg shadow-card border border-border',
    'card-hover': 'transition-all duration-200 hover:shadow-md hover:-translate-y-px',
    'card-padding': 'p-4',
    'card-selected': 'border-l-2 border-l-teal-600 bg-teal-50', // 选中（老师态）
    'card-ai': 'border-l-2 border-l-violet-600 bg-violet-50', // AI 卡片（AI 态）

    // ── 按钮三级 + AI 级（DESIGN §7.2）────────────────────────────
    'btn-lift': 'transition-all duration-200 hover:shadow-md hover:-translate-y-px',
    'btn-primary': 'bg-teal-600 text-white border-0 shadow-teal hover:bg-teal-700', // 老师主 CTA（青）
    'btn-secondary': 'bg-white text-ink-900 border border-border-strong hover:bg-bg-100', // 次要动作
    'btn-ghost': 'bg-transparent text-ink-700 hover:bg-bg-100 border-0', // 第三级 / 工具栏
    'btn-ai': 'bg-violet-600 text-white border-0 shadow-violet hover:bg-violet-700', // AI 触发（紫）
    // 兼容别名（存量引用渐变主按钮 → 改青实底，去蓝渐变）
    'btn-primary-gradient': 'bg-teal-600 text-white border-0 shadow-teal hover:bg-teal-700',

    // ── 文字样式（DESIGN §4）──────────────────────────────────────
    'text-title': 'text-ink-900 font-semibold text-base',
    'text-body': 'text-ink-500 text-sm',
    'text-caption': 'text-ink-400 text-xs',

    // 分割线（DESIGN §5.4 清爽实线）
    'divider-h': 'border-0 border-b border-border-light',

    // 悬浮效果
    'hover-lift': 'transition-transform duration-200 hover:-translate-y-px',
    'hover-scale': 'transition-transform duration-200 hover:scale-102',

    // ── tag / chip（DESIGN §7.4）──────────────────────────────────
    'tag-default': 'bg-bg-100 text-ink-700 rounded-sm px-2 py-0.5 text-xs font-medium', // 通用
    'tag-teal': 'bg-teal-50 text-teal-700 rounded-sm px-2 py-0.5 text-xs font-medium', // 重要 / 选中 / 试题栏
    'tag-ai': 'bg-violet-50 text-violet-700 rounded-sm px-2 py-0.5 text-xs font-medium', // AI 相关
    'tag-green': 'bg-green-50 text-green-600 rounded-sm px-2 py-0.5 text-xs font-medium', // 成功
    // 兼容别名（存量 tag-blue / tag-gray / tag-orange 引用 → 青/中性/琥珀）
    'tag-blue': 'bg-teal-50 text-teal-700 rounded-sm px-2 py-0.5 text-xs font-medium', // 旧"蓝"→青
    'tag-gray': 'bg-bg-100 text-ink-500 rounded-sm px-2 py-0.5 text-xs font-medium',
    'tag-orange': 'bg-warning-lighter text-warning-dark rounded-sm px-2 py-0.5 text-xs font-medium',

    // FAB 浮动按钮
    'fab-btn': 'fixed bottom-8 right-8 rounded-full shadow-float z-50 btn-lift',

    // 侧边栏
    'sidebar-base': 'bg-white border-r border-border-light',

    // 筛选栏
    'filter-bar': 'bg-white rounded-md p-4 mb-3 flex items-center gap-3 flex-wrap border border-border',
  },

  // 安全列表（确保这些 class 即使在模板中动态使用也被生成）
  safelist: [
    'text-teal-600',
    'text-violet-600',
    'text-primary',
    'text-success',
    'text-warning',
    'text-danger',
    'bg-teal-50',
    'bg-violet-50',
    'bg-primary-lighter',
    'bg-success-lighter',
    'bg-warning-lighter',
    'hover:-translate-y-0.5',
    'hover:-translate-y-px',
  ],
})
