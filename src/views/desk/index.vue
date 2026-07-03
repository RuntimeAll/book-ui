<script setup lang="ts">
/**
 * 备课台壳（PRD-C-212 V1）—— 导航 9→6 收敛后的聚合分区壳。
 * 左·菜单（登录即全显，无权限过滤）+ 右·router-view（子路由=各分区页，原页面零重写只换壳）。
 * 结构照抄 views/manage/index.vue（系统管理中心壳），class 前缀 mc- 改 dk-。
 */
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'

const route = useRoute()
const router = useRouter()

interface MenuItem {
  title: string
  path: string
}

const MENUS: MenuItem[] = [
  { title: '概览', path: '/desk/overview' },
  { title: '我的工作台', path: '/desk/workspace' },
  { title: '我的题库', path: '/desk/my-question' },
  { title: '举一反三', path: '/desk/ai-variant' },
  { title: '几何画板', path: '/desk/geo-board' },
  { title: '收藏夹', path: '/desk/favorites' },
]

const activePath = computed(() => {
  const p = route.path
  // 几何画板画廊子页归位到「几何画板」高亮
  if (p.startsWith('/desk/geo-board')) return '/desk/geo-board'
  return p
})

function go(path: string) {
  if (path !== route.path) router.push(path)
}
</script>

<template>
  <div class="dk-page">
    <aside class="dk-side">
      <div class="dk-side-head">备课台</div>
      <nav class="dk-menu">
        <button
          v-for="m in MENUS"
          :key="m.path"
          type="button"
          class="dk-menu-item"
          :class="{ on: activePath === m.path }"
          @click="go(m.path)"
        >{{ m.title }}</button>
      </nav>
    </aside>
    <section class="dk-body">
      <router-view />
    </section>
  </div>
</template>

<style scoped>
.dk-page { display: flex; gap: 12px; min-height: calc(100vh - 60px); padding: 12px; background: #f4f7f7; box-sizing: border-box; align-items: stretch; }
.dk-side { width: 168px; flex-shrink: 0; background: #fff; border: 1px solid #eef1f1; border-radius: 10px; box-shadow: 0 1px 3px rgba(22, 36, 42, .05); overflow: hidden; align-self: flex-start; position: sticky; top: 12px; }
.dk-side-head { font-size: 13px; font-weight: 700; color: #16242a; padding: 12px 14px 8px; border-bottom: 1px solid #f1f4f4; }
.dk-menu { display: flex; flex-direction: column; padding: 6px; gap: 2px; }
.dk-menu-item { text-align: left; border: 0; background: transparent; font-size: 13px; color: #435560; padding: 8px 10px; border-radius: 7px; cursor: pointer; transition: .15s; }
.dk-menu-item:hover { background: #f0f7f6; color: #0f766e; }
.dk-menu-item.on { background: #e6f3f1; color: #0f766e; font-weight: 700; }
.dk-body { flex: 1; min-width: 0; }
</style>
