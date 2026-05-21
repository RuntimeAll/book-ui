<script setup lang="ts">
/**
 * BaseButton — 按钮统一组件
 * 抽取自 vue-element-plus-admin 模板 Button 组件（kailong321200875）
 * 接口对齐模板真实版本（size / type / disabled / plain / text / bg / link /
 *   round / circle / loading / loadingIcon / icon / autofocus / nativeType /
 *   autoInsertSpace / color / darker / tag）
 *
 * 简化说明：模板原版依赖 useAppStore 读取主题 elColorPrimary，
 * 本项目无模板完整 store，直接透传 color 或用 Element Plus 默认主题色。
 */
import { ElButton, type ComponentSize, type ButtonType } from 'element-plus'
import { type Component, computed } from 'vue'
import { useDesign } from '@/hooks/web/useDesign'

const { getPrefixCls } = useDesign()
const prefixCls = getPrefixCls('button')

interface Props {
  size?: ComponentSize
  type?: ButtonType
  disabled?: boolean
  plain?: boolean
  text?: boolean
  bg?: boolean
  link?: boolean
  round?: boolean
  circle?: boolean
  loading?: boolean
  loadingIcon?: string | Component
  icon?: string | Component
  autofocus?: boolean
  nativeType?: 'button' | 'submit' | 'reset'
  autoInsertSpace?: boolean
  color?: string
  darker?: boolean
  tag?: string | Component
}

const props = withDefaults(defineProps<Props>(), {
  size: undefined,
  type: 'default',
  disabled: false,
  plain: false,
  text: false,
  bg: false,
  link: false,
  round: false,
  circle: false,
  loading: false,
  loadingIcon: undefined,
  icon: undefined,
  autofocus: false,
  nativeType: 'button',
  autoInsertSpace: false,
  color: '',
  darker: false,
  tag: 'button'
})

const emits = defineEmits<{
  click: []
}>()

// 主色处理：当 type=primary 且未显式传 color 时，使用 Element Plus 默认主题变量
// （对齐模板行为，但不依赖 useAppStore）
const resolvedColor = computed(() => {
  if (props.color) return props.color
  return ''
})

const buttonStyle = computed(() => {
  const { type, link } = props
  if (type === 'primary' && !link) {
    return '--el-button-text-color: #fff; --el-button-hover-text-color: #fff'
  }
  return ''
})
</script>

<template>
  <ElButton
    :class="`${prefixCls}`"
    v-bind="{ ...props }"
    :color="resolvedColor"
    :style="buttonStyle"
    @click="() => emits('click')"
  >
    <slot></slot>
    <slot name="icon"></slot>
    <slot name="loading"></slot>
  </ElButton>
</template>
