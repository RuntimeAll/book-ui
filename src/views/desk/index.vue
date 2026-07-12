<script setup lang="ts">
/**
 * 备课台壳（PRD-C-212 V1）—— 导航 9→6 收敛后的聚合分区壳。
 * 左·菜单（登录即全显，无权限过滤）+ 右·router-view（子路由=各分区页，原页面零重写只换壳）。
 * 结构照抄 views/manage/index.vue（系统管理中心壳），class 前缀 mc- 改 dk-。
 * PRD-C-213 终审修订：侧栏按设计稿正本改分组排版（备课台/教学安排[新]/我的资产/AI 工具）+ 每项 LineIcon。
 */
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import LineIcon, { type LineIconName } from '@/components/LineIcon.vue'

const route = useRoute()
const router = useRouter()

interface MenuItem {
  title: string
  path: string
  icon: LineIconName
}

interface MenuGroup {
  title: string
  badge?: string
  items: MenuItem[]
}

const MENU_GROUPS: MenuGroup[] = [
  {
    title: '备课台',
    items: [{ title: '概览', path: '/desk/overview', icon: 'overview' }],
  },
  {
    // 教学安排（PRD-C-213），分组语义与「新」徽标对照设计稿正本侧栏
    title: '教学安排',
    badge: '新',
    items: [
      { title: '排课总览', path: '/desk/schedule', icon: 'schedule' },
      { title: '学生与班级', path: '/desk/targets', icon: 'targets' },
      { title: '课程计划', path: '/desk/plans', icon: 'plans' },
      { title: '课后反馈', path: '/desk/feedback', icon: 'prep' },
    ],
  },
  {
    title: '我的资产',
    items: [
      { title: '我的题库', path: '/desk/my-question', icon: 'my-question' },
      { title: '我的卷库', path: '/desk/my-papers', icon: 'my-papers' },
      { title: '收藏夹', path: '/desk/favorites', icon: 'favorites' },
    ],
  },
  {
    title: 'AI 工具',
    items: [
      { title: '举一反三', path: '/desk/ai-variant', icon: 'ai-variant' },
      { title: '几何画板', path: '/desk/geo-board', icon: 'geo-board' },
      { title: '我的工作台', path: '/desk/workspace', icon: 'workspace' },
    ],
  },
]

const activePath = computed(() => {
  const p = route.path
  // 几何画板画廊子页归位到「几何画板」高亮
  if (p.startsWith('/desk/geo-board')) return '/desk/geo-board'
  // 反馈单编辑子页归位到「课后反馈」高亮
  if (p.startsWith('/desk/feedback')) return '/desk/feedback'
  return p
})

function go(path: string) {
  if (path !== route.path) router.push(path)
}
</script>

<template>
  <div class="dk-page">
    <aside class="dk-side">
      <nav class="dk-menu">
        <div v-for="g in MENU_GROUPS" :key="g.title" class="dk-group">
          <div class="dk-group-head">
            <span>{{ g.title }}</span>
            <span v-if="g.badge" class="dk-badge">{{ g.badge }}</span>
          </div>
          <button
            v-for="m in g.items"
            :key="m.path"
            type="button"
            class="dk-menu-item"
            :class="{ on: activePath === m.path }"
            @click="go(m.path)"
          >
            <LineIcon :name="m.icon" :size="17" class="dk-ico" />
            <span>{{ m.title }}</span>
          </button>
        </div>
      </nav>
    </aside>
    <section class="dk-body">
      <router-view />
    </section>
  </div>
</template>

<style scoped>
.dk-page { display: flex; gap: 12px; min-height: calc(100vh - 60px); padding: 12px; background: #f4f7f7; box-sizing: border-box; align-items: stretch; }
.dk-side { width: 178px; flex-shrink: 0; background: #fff; border: 1px solid var(--bk-line); border-radius: 12px; box-shadow: 0 1px 3px rgba(22, 36, 42, .05); overflow: hidden; align-self: flex-start; position: sticky; top: 12px; }
.dk-menu { display: flex; flex-direction: column; padding: 8px 6px 10px; }
.dk-group { display: flex; flex-direction: column; gap: 2px; }
.dk-group + .dk-group { margin-top: 12px; }
.dk-group-head { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; color: #7b8b93; letter-spacing: .5px; padding: 4px 10px 4px; }
.dk-badge { font-size: 10px; font-weight: 700; line-height: 1; color: #fff; background: var(--bk-teal); border-radius: 8px; padding: 3px 6px; }
.dk-menu-item { display: flex; align-items: center; gap: 8px; text-align: left; border: 0; background: transparent; font-size: 13px; color: #435560; padding: 8px 10px; border-radius: 7px; cursor: pointer; transition: .15s; }
.dk-menu-item:hover { background: #f0f7f6; color: var(--bk-teal); } /* hover 比选中浅一档,保留两级区分 */
.dk-menu-item.on { background: var(--bk-teal-soft); color: var(--bk-teal); font-weight: 700; }
.dk-ico { flex-shrink: 0; opacity: .85; }
.dk-body { flex: 1; min-width: 0; }
</style>
