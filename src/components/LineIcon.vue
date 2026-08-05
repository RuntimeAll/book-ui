<!--
  LineIcon — 简笔画线性图标集（PRD-C-212 增量，与 PRD 目录《设计稿-备课台与顶栏-V1.html》同源）。
  统一 24×24 viewBox、1.8px 圆头描边、无填充；颜色继承 currentColor（外层控色）。
  顶栏 6 枚（home/qbank/papers/lecture/desk/manage）+ 备课台 8 枚（overview/my-question/
  my-papers/my-lectures/favorites/ai-variant/geo-board/workspace）。
  新增图标：加一个 v-else-if 分支即可，笔触语言保持一致（圆头、轻微不对称、语义直给）。
-->
<script lang="ts">
// 类型走普通 script 块导出（<script setup> 不允许命名导出）
export type LineIconName =
  | 'home' | 'qbank' | 'papers' | 'lecture' | 'desk' | 'manage'
  | 'overview' | 'my-question' | 'my-papers' | 'my-lectures'
  | 'favorites' | 'ai-variant' | 'geo-board' | 'workspace'
  | 'schedule' | 'targets' | 'plans' | 'prep' | 'shelf' | 'account'
</script>

<script setup lang="ts">
withDefaults(defineProps<{ name: LineIconName; size?: number }>(), { size: 19 })
</script>

<template>
  <svg
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true" class="line-icon"
  >
    <template v-if="name === 'home'">
      <path d="M4 11.2 12 4.5l8 6.7" /><path d="M6 10v9h4.5v-5h3v5H18v-9" />
    </template>
    <template v-else-if="name === 'qbank'">
      <rect x="4" y="5" width="13" height="15" rx="2" /><path d="M8 5V3.5h11V17" /><path d="M7.5 10.5l2 2 3.5-3.5" />
    </template>
    <template v-else-if="name === 'papers'">
      <path d="M6 3.5h9l3 3V20.5H6z" /><path d="M15 3.5v3h3" /><path d="M9 10h6M9 13.5h6M9 17h4" />
    </template>
    <template v-else-if="name === 'lecture'">
      <path d="M12 6.5c-1.8-1.6-4.4-2-7-1.4v13.4c2.6-.6 5.2-.2 7 1.4 1.8-1.6 4.4-2 7-1.4V5.1c-2.6-.6-5.2-.2-7 1.4z" /><path d="M12 6.5V20" />
    </template>
    <template v-else-if="name === 'desk'">
      <path d="M4 20l3.5-.7L19 7.8a1.9 1.9 0 0 0-2.7-2.7L4.8 16.6z" /><path d="M13.5 7.5l3 3" /><path d="M14 20h6" />
    </template>
    <template v-else-if="name === 'manage'">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19 12a7 7 0 0 0-.15-1.4l2-1.55-2-3.45-2.35.95a7 7 0 0 0-2.4-1.4L13.7 2.7h-3.4l-.4 2.45a7 7 0 0 0-2.4 1.4L5.15 5.6l-2 3.45 2 1.55A7 7 0 0 0 5 12c0 .48.05.94.15 1.4l-2 1.55 2 3.45 2.35-.95a7 7 0 0 0 2.4 1.4l.4 2.45h3.4l.4-2.45a7 7 0 0 0 2.4-1.4l2.35.95 2-3.45-2-1.55c.1-.46.15-.92.15-1.4z" />
    </template>
    <template v-else-if="name === 'overview'">
      <rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" /><path d="M16.5 13.5v6M13.5 16.5h6" />
    </template>
    <template v-else-if="name === 'my-question'">
      <rect x="4" y="6" width="12" height="14" rx="2" /><path d="M8 6V4h12v13" />
      <circle cx="10" cy="11.5" r="1.7" /><path d="M6.8 17c.6-1.6 1.8-2.4 3.2-2.4s2.6.8 3.2 2.4" />
    </template>
    <template v-else-if="name === 'my-papers'">
      <path d="M5 20.5V5a1.5 1.5 0 0 1 1.5-1.5h8L19 8v12.5z" /><path d="M14 3.5V8h5" />
      <circle cx="12" cy="13" r="1.7" /><path d="M9 18c.5-1.4 1.6-2.1 3-2.1s2.5.7 3 2.1" />
    </template>
    <template v-else-if="name === 'my-lectures'">
      <path d="M12 7c-1.6-1.4-3.9-1.8-6.2-1.3v11.8c2.3-.5 4.6-.1 6.2 1.3 1.6-1.4 3.9-1.8 6.2-1.3V5.7" />
      <path d="M14.5 9.5 20 4M20 4h-3.2M20 4v3.2" />
    </template>
    <template v-else-if="name === 'favorites'">
      <path d="M12 4.5 14.2 9l5 .7-3.6 3.5.85 5-4.45-2.35L7.55 18.2l.85-5L4.8 9.7l5-.7z" />
    </template>
    <template v-else-if="name === 'ai-variant'">
      <rect x="4" y="4.5" width="6.5" height="6.5" rx="1.5" /><path d="M10.5 8h4" /><path d="M14 5.5l4 2.5-4 2.5" />
      <rect x="14.5" y="13.5" width="5.5" height="5.5" rx="1.3" /><rect x="4.5" y="13.5" width="5.5" height="5.5" rx="1.3" />
      <path d="M7.25 11v2.5M16 11v2.5" />
    </template>
    <template v-else-if="name === 'geo-board'">
      <path d="M12 4v3" /><circle cx="12" cy="5.5" r="1.5" />
      <path d="M12 7 5.5 20M12 7l6.5 13" /><path d="M8 14.5c2.6 1.6 5.4 1.6 8 0" />
    </template>
    <template v-else-if="name === 'workspace'">
      <rect x="3.5" y="5" width="17" height="11" rx="2" /><path d="M8 20h8M12 16v4" /><path d="M7.5 9h5M7.5 12h3" />
    </template>
    <!-- 教学安排四枚（PRD-C-213）：日历 / 两人 / 课程清单 / 带勾备课夹 -->
    <template v-else-if="name === 'schedule'">
      <rect x="3.5" y="5" width="17" height="15.5" rx="2" /><path d="M3.5 9.5h17" /><path d="M8 3v4M16 3v4" />
      <path d="M7.5 13.5h3M13.5 13.5h3M7.5 17h3" />
    </template>
    <template v-else-if="name === 'targets'">
      <circle cx="9" cy="8.5" r="2.8" /><path d="M4.5 19c.7-3 2.4-4.5 4.5-4.5s3.8 1.5 4.5 4.5" />
      <circle cx="16.8" cy="9.5" r="2.1" /><path d="M15.8 14.6c1.9.3 3.2 1.7 3.8 4.1" />
    </template>
    <template v-else-if="name === 'plans'">
      <rect x="5" y="4" width="14" height="16" rx="2" /><path d="M9 8.5h6M9 12h6M9 15.5h3.5" />
    </template>
    <template v-else-if="name === 'prep'">
      <rect x="5" y="5" width="14" height="15.5" rx="2" /><path d="M9 5V3.5h6V5" /><path d="M8.8 13.2l2.1 2.1 4.3-4.3" />
    </template>
    <!-- 书架（PRD-002）：三本立书 + 底板 -->
    <template v-else-if="name === 'shelf'">
      <rect x="4" y="4.5" width="3.5" height="13" rx="1" /><rect x="9" y="6.5" width="3.5" height="11" rx="1" />
      <path d="M14.2 7.4l3.3-.9 2.3 8.6-3.3.9z" /><path d="M3 20.5h18" />
    </template>
    <!-- 课时账单（PRD-018 D12）：小票单据 + 撕齿底边 + 两行条目一行金额 -->
    <template v-else-if="name === 'account'">
      <path d="M6 3.5h12v17l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4z" />
      <path d="M9 8h6M9 11.5h6M9 15h3" />
    </template>
  </svg>
</template>
