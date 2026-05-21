<script setup lang="ts">
/**
 * Icon — 统一图标渲染组件
 * 抽取自 vue-element-plus-admin 模板（kailong321200875）
 * 支持：svg-icon: 前缀本地 SVG 符号 / Iconify 在线图标 / CSS 类图标
 * 接口对齐模板真实 props（icon / color / size / hoverColor）
 */
import { computed, unref } from 'vue'
import { ElIcon } from 'element-plus'
import { Icon } from '@iconify/vue'
import { useDesign } from '@/hooks/web/useDesign'
import { ICON_PREFIX } from '@/constants'

const { getPrefixCls } = useDesign()
const prefixCls = getPrefixCls('icon')

interface Props {
  /** 图标名称，支持：
   *  - 'svg-icon:xxx' → 本地 SVG symbol
   *  - 'ep:edit' / 'vi-ep:edit' → Iconify 图标
   *  - 其他 → CSS 类名图标（iconify 离线模式）
   */
  icon?: string
  /** 图标颜色 */
  color?: string
  /** 图标大小（px） */
  size?: number
  /** hover 时颜色 */
  hoverColor?: string
}

const props = withDefaults(defineProps<Props>(), {
  icon: '',
  color: undefined,
  size: 16,
  hoverColor: undefined
})

const isLocal = computed(() => props.icon?.startsWith('svg-icon:'))

const symbolId = computed(() => {
  return unref(isLocal) ? `#icon-${props.icon.split('svg-icon:')[1]}` : props.icon
})

// 本项目强制使用 Iconify 离线（@iconify-json/ep 已安装）
// 对齐模板 VITE_USE_ONLINE_ICON=false 时的 CSS class 渲染路径
const isUseOnline = computed(() => false)

const getIconifyStyle = computed(() => {
  const { color, size } = props
  return {
    fontSize: `${size}px`,
    ...(color ? { color } : {})
  }
})

const getIconName = computed(() => {
  if (!props.icon) return ''
  return props.icon.startsWith(ICON_PREFIX)
    ? props.icon.replace(ICON_PREFIX, '')
    : props.icon
})
</script>

<template>
  <ElIcon :class="prefixCls" :size="size" :color="color">
    <svg v-if="isLocal" aria-hidden="true">
      <use :xlink:href="symbolId" />
    </svg>

    <template v-else>
      <Icon v-if="isUseOnline" :icon="getIconName" :style="getIconifyStyle" />
      <Icon v-else :icon="getIconName" :style="getIconifyStyle" />
    </template>
  </ElIcon>
</template>

<style scoped>
.v-icon {
  display: inline-flex;
  align-items: center;
  vertical-align: middle;
}

.v-icon :deep(svg):hover {
  color: v-bind(hoverColor);
}
</style>
