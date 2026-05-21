<script setup lang="ts">
/**
 * ContentWrap — 页面级内容包裹器
 * 抽取自 vue-element-plus-admin 模板（kailong321200875）
 * 基于 ElCard shadow="never"，支持 title / message / header slot
 * 接口完全对齐模板真实版本
 */
import { ElCard, ElTooltip } from 'element-plus'
import { useDesign } from '@/hooks/web/useDesign'
import Icon from '@/components/Icon/index.vue'

const { getPrefixCls } = useDesign()
const prefixCls = getPrefixCls('content-wrap')

interface Props {
  /** 卡片标题 */
  title?: string
  /** 标题右侧 tooltip 提示文字 */
  message?: string
}

withDefaults(defineProps<Props>(), {
  title: '',
  message: ''
})
</script>

<template>
  <ElCard :class="[prefixCls]" shadow="never">
    <template v-if="title" #header>
      <div class="flex items-center">
        <span class="text-16px font-700">{{ title }}</span>
        <ElTooltip v-if="message" effect="dark" placement="right">
          <template #content>
            <div class="max-w-200px">{{ message }}</div>
          </template>
          <Icon class="ml-5px" icon="vi-bi:question-circle-fill" :size="14" />
        </ElTooltip>
        <div class="flex pl-20px flex-grow">
          <slot name="header"></slot>
        </div>
      </div>
    </template>
    <div>
      <slot></slot>
    </div>
  </ElCard>
</template>

<style scoped>
.v-content-wrap {
  --el-card-border-color: #f2f3f5;
  border-radius: 8px;
}
</style>
