<script setup lang="ts">
/**
 * PRD-015 批5 · 移动端底部弹层（demo v5 的 .mask + .sheet 结构组件化）。
 * 结算确认 / 台账 / 充值 / 反馈编辑 / 导出预览 五处共用，样式在 views/m/mobile.css（.m-app 作用域）。
 * 不 teleport：保持在 .m-app 子树内，CSS 作用域与移动版式（min(430px,100%)）才成立。
 */
defineProps<{
  modelValue: boolean
  title?: string
  sub?: string
}>()

const emit = defineEmits<{ 'update:modelValue': [boolean] }>()

function close() {
  emit('update:modelValue', false)
}
</script>

<template>
  <div v-if="modelValue" class="m-mask" @click="close" />
  <div v-if="modelValue" class="m-sheet" role="dialog" aria-modal="true">
    <h3 v-if="title">{{ title }}</h3>
    <p v-if="sub" class="sub">{{ sub }}</p>
    <slot />
    <div class="acts">
      <slot name="acts">
        <button class="m-btn ghost" @click="close">关闭</button>
      </slot>
    </div>
  </div>
</template>
