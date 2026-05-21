import { defineConfig, presetWind3, presetAttributify, presetIcons } from 'unocss'

/**
 * UnoCSS 配置
 * 设计 token 系统参考 misikt 真站（蓝绿调，饱和度低）
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
      // misikt 主色系 — 蓝绿调，低饱和
      primary: {
        DEFAULT: '#4080ff',
        light: '#a0c4ff',
        lighter: '#d6e8ff',
        dark: '#1a5fcc',
        hover: '#3370e8',
      },
      success: {
        DEFAULT: '#34c38f',
        light: '#b7ead8',
        lighter: '#e8f8f2',
        dark: '#1e9e6e',
      },
      warning: {
        DEFAULT: '#f6a623',
        light: '#fad99a',
        lighter: '#fef6e6',
        dark: '#c47d0e',
      },
      danger: {
        DEFAULT: '#f56c6c',
        light: '#fab6b6',
        lighter: '#fef0f0',
        dark: '#c45656',
      },
      info: {
        DEFAULT: '#909399',
        light: '#c8c9cc',
        lighter: '#f4f4f5',
      },
      // 背景色
      bg: {
        DEFAULT: '#f0f2f5',
        card: '#ffffff',
        sidebar: '#ffffff',
        hover: '#f5f7fa',
      },
      // 文字色
      text: {
        primary: '#1d2129',
        regular: '#4e5969',
        secondary: '#86909c',
        placeholder: '#c9cdd4',
      },
      // 边框色
      border: {
        DEFAULT: '#e5e6eb',
        light: '#f2f3f5',
        dark: '#c9cdd4',
      },
    },
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
    borderRadius: {
      none: '0',
      sm: '4px',
      DEFAULT: '6px',
      md: '8px',
      lg: '12px',
      xl: '16px',
      '2xl': '20px',
      full: '9999px',
    },
    boxShadow: {
      sm: '0 1px 2px 0 rgba(0,0,0,0.05)',
      DEFAULT: '0 2px 8px 0 rgba(0,0,0,0.08)',
      md: '0 4px 12px 0 rgba(0,0,0,0.1)',
      lg: '0 8px 24px 0 rgba(0,0,0,0.12)',
      card: '0 2px 8px 0 rgba(64,128,255,0.06)',
      'card-hover': '0 8px 24px 0 rgba(64,128,255,0.14)',
      header: '0 2px 12px 0 rgba(0,0,0,0.06)',
      float: '0 12px 32px 0 rgba(64,128,255,0.2)',
    },
  },

  shortcuts: {
    // 通用布局
    'flex-center': 'flex items-center justify-center',
    'flex-between': 'flex items-center justify-between',
    'flex-start': 'flex items-center justify-start',
    'flex-col-center': 'flex flex-col items-center justify-center',

    // 卡片基础样式
    'card-base': 'bg-white rounded-md shadow-card border border-border-light',
    'card-hover': 'transition-all duration-200 hover:shadow-card-hover hover:-translate-y-0.5',
    'card-padding': 'p-4',

    // 按钮悬浮效果
    'btn-lift': 'transition-all duration-200 hover:shadow-md hover:-translate-y-0.5',
    'btn-primary-gradient': 'bg-gradient-to-r from-primary to-primary-dark text-white border-0',

    // 文字样式
    'text-title': 'text-text-primary font-semibold text-base',
    'text-body': 'text-text-regular text-sm',
    'text-caption': 'text-text-secondary text-xs',

    // 分割线
    'divider-h': 'border-0 border-b border-border-light',

    // 悬浮效果
    'hover-lift': 'transition-transform duration-200 hover:-translate-y-px',
    'hover-scale': 'transition-transform duration-200 hover:scale-102',

    // Tag 样式
    'tag-blue': 'bg-primary-lighter text-primary rounded-sm px-2 py-0.5 text-xs font-medium',
    'tag-green': 'bg-success-lighter text-success-dark rounded-sm px-2 py-0.5 text-xs font-medium',
    'tag-orange': 'bg-warning-lighter text-warning-dark rounded-sm px-2 py-0.5 text-xs font-medium',
    'tag-gray': 'bg-info-lighter text-info rounded-sm px-2 py-0.5 text-xs font-medium',

    // FAB 浮动按钮
    'fab-btn': 'fixed bottom-8 right-8 rounded-full shadow-float z-50 btn-lift',

    // 侧边栏
    'sidebar-base': 'bg-white border-r border-border-light',

    // 筛选栏
    'filter-bar': 'bg-white rounded-md p-4 mb-3 flex items-center gap-3 flex-wrap border border-border-light',
  },

  // 安全列表（确保这些 class 即使在模板中动态使用也被生成）
  safelist: [
    'text-primary',
    'text-success',
    'text-warning',
    'text-danger',
    'bg-primary-lighter',
    'bg-success-lighter',
    'bg-warning-lighter',
    'hover:-translate-y-0.5',
    'hover:-translate-y-px',
  ],
})
