<script setup lang="ts">
/**
 * PRD-015 · 移动端底部弹层 —— **Vant 化后只是 van-popup 的薄壳**。
 *
 * 🔴 2026-07-31 重做：原来是手搓 .m-mask + .m-sheet（自管遮罩/层级/滚动/动画，问题一堆）。
 *    现在整个交给 `<van-popup position="bottom" round>`：遮罩、锁滚动、滑入动画、安全区、
 *    ESC/点遮罩关闭全由 Vant 负责。本组件**只**保留三件事，好让五处调用点写法不变：
 *      ① 统一的标题 + 副标题版式  ② 内容区滚动容器  ③ 底部动作条插槽
 *    不 teleport：留在 .m-app 子树内，430px 版心的 CSS 约束（mobile.css）才生效。
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
  <van-popup
    :show="modelValue"
    position="bottom"
    round
    :safe-area-inset-bottom="true"
    @update:show="emit('update:modelValue', $event)"
  >
    <div v-if="title || sub" class="m-sheethead">
      <h3 v-if="title">{{ title }}</h3>
      <p v-if="sub">{{ sub }}</p>
    </div>
    <div class="m-sheetbody">
      <slot />
    </div>
    <div class="m-sheetacts">
      <slot name="acts">
        <van-button block @click="close">关闭</van-button>
      </slot>
    </div>
  </van-popup>
</template>
