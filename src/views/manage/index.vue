<script setup lang="ts">
/**
 * 系统管理中心壳（PRD-C-211）—— B 线 admin「系统管理」直接移植的承载壳。
 * 左·二级菜单（按 /getInfo permissions 显隐）+ 右·router-view（子路由=移植页面）。
 *
 * - 权限：路由守卫已保证进到这里的是 superadmin/org_admin 且 adminStore.fetchInfo() 已完成；
 *   菜单项按 perms 过滤（superadmin 的 permissions=['*:*:*'] 全显）。
 * - 207-V9 三卡片页已退役（成员管理并入用户管理；内容管理/邀请码本期不挂，代码在 git 历史）。
 */
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore as useAdminUserStore } from '@/store/modules/user'

const route = useRoute()
const router = useRouter()
const adminStore = useAdminUserStore()

interface MenuItem {
  title: string
  path: string
  perms: string[]
}

/** 与截图信息架构对齐的 11 模块（+oss 配置为 oss 页内跳转，不单列菜单） */
const MENUS: MenuItem[] = [
  { title: '用户管理', path: '/manage/user', perms: ['system:user:list'] },
  { title: '角色管理', path: '/manage/role', perms: ['system:role:list'] },
  { title: '菜单管理', path: '/manage/menu', perms: ['system:menu:list'] },
  { title: '部门管理', path: '/manage/dept', perms: ['system:dept:list'] },
  { title: '岗位管理', path: '/manage/post', perms: ['system:post:list'] },
  { title: '字典管理', path: '/manage/dict', perms: ['system:dict:list'] },
  { title: '参数设置', path: '/manage/config', perms: ['system:config:list'] },
  { title: '通知公告', path: '/manage/notice', perms: ['system:notice:list'] },
  { title: '操作日志', path: '/manage/operlog', perms: ['monitor:operlog:list'] },
  { title: '登录日志', path: '/manage/logininfor', perms: ['monitor:logininfor:list'] },
  { title: '文件管理', path: '/manage/oss', perms: ['system:oss:list'] },
  { title: '客户端管理', path: '/manage/client', perms: ['system:client:list'] },
]

const visibleMenus = computed(() =>
  MENUS.filter((m) => adminStore.permissions.some((p) => p === '*:*:*' || m.perms.includes(p))),
)

const activePath = computed(() => {
  // 二级页（分配角色/分配用户/OSS配置）归位到所属一级菜单高亮
  const p = route.path
  if (p.startsWith('/manage/user-auth')) return '/manage/user'
  if (p.startsWith('/manage/role-auth')) return '/manage/role'
  if (p.startsWith('/manage/oss-config')) return '/manage/oss'
  return p
})

function go(path: string) {
  if (path !== route.path) router.push(path)
}
</script>

<template>
  <div class="mc-page">
    <aside class="mc-side">
      <div class="mc-side-head">系统管理</div>
      <nav class="mc-menu">
        <button
          v-for="m in visibleMenus"
          :key="m.path"
          type="button"
          class="mc-menu-item"
          :class="{ on: activePath === m.path }"
          @click="go(m.path)"
        >{{ m.title }}</button>
      </nav>
    </aside>
    <section class="mc-body">
      <router-view />
    </section>
  </div>
</template>

<style scoped>
.mc-page { display: flex; gap: 12px; min-height: calc(100vh - 60px); padding: 12px; background: #f4f7f7; box-sizing: border-box; align-items: stretch; }
.mc-side { width: 168px; flex-shrink: 0; background: #fff; border: 1px solid #eef1f1; border-radius: 10px; box-shadow: 0 1px 3px rgba(22, 36, 42, .05); overflow: hidden; align-self: flex-start; position: sticky; top: 12px; }
.mc-side-head { font-size: 13px; font-weight: 700; color: #16242a; padding: 12px 14px 8px; border-bottom: 1px solid #f1f4f4; }
.mc-menu { display: flex; flex-direction: column; padding: 6px; gap: 2px; }
.mc-menu-item { text-align: left; border: 0; background: transparent; font-size: 13px; color: #435560; padding: 8px 10px; border-radius: 7px; cursor: pointer; transition: .15s; }
.mc-menu-item:hover { background: #f0f7f6; color: #0f766e; }
.mc-menu-item.on { background: #e6f3f1; color: #0f766e; font-weight: 700; }
.mc-body { flex: 1; min-width: 0; }
/* 移植页自带 plus-ui 结构（.p-2 等），给个白底容器兜住 */
.mc-body :deep(.p-2) { padding: 0; }
</style>
