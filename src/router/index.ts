import { createRouter, createWebHashHistory } from 'vue-router'
import AppLayout from '@/layout/AppLayout.vue'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      component: AppLayout,
      redirect: '/question/index',
      children: [
        // 题库（FE-2 真实现）
        {
          path: '/question/index',
          name: 'QuestionIndex',
          component: () => import('@/views/question/index.vue'),
        },
        // 组卷工作台（FE-4 真实现）
        {
          path: '/papers/edit',
          name: 'PapersEdit',
          component: () => import('@/views/papers/edit.vue'),
        },
        // 空壳菜单页
        {
          path: '/home',
          name: 'Home',
          component: () => import('@/views/PlaceholderView.vue'),
          props: { title: '首页' },
        },
        {
          path: '/assignment/index',
          name: 'AssignmentIndex',
          component: () => import('@/views/PlaceholderView.vue'),
          props: { title: '作业管理' },
        },
        {
          path: '/student/index',
          name: 'StudentIndex',
          component: () => import('@/views/PlaceholderView.vue'),
          props: { title: '学生管理' },
        },
        {
          path: '/class/index',
          name: 'ClassIndex',
          component: () => import('@/views/PlaceholderView.vue'),
          props: { title: '班级管理' },
        },
        {
          path: '/papers/index',
          name: 'PapersIndex',
          component: () => import('@/views/PlaceholderView.vue'),
          props: { title: '卷库' },
        },
        {
          path: '/materials/index',
          name: 'MaterialsIndex',
          component: () => import('@/views/PlaceholderView.vue'),
          props: { title: '资料库' },
        },
      ],
    },
    // Cookie 失效提示页（无 layout 包裹）
    {
      path: '/cookie-expired',
      name: 'CookieExpired',
      component: () => import('@/views/CookieExpired.vue'),
    },
  ],
})

export default router
