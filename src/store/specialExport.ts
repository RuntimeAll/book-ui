/**
 * useSpecialExportStore — 全局导出对话框开关（PRD-003 P5）。
 *
 * 备课栏卡片「导出 PDF」与专项编辑器「导出 PDF」都调 open(specialId, title)，
 * 对话框单例挂在 AppLayout，避免多处重复挂载。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useSpecialExportStore = defineStore('special-export', () => {
  const visible = ref(false)
  const specialId = ref('')
  const title = ref('')

  function open(id: string, name: string): void {
    specialId.value = id
    title.value = name
    visible.value = true
  }

  function close(): void {
    visible.value = false
  }

  return { visible, specialId, title, open, close }
})
