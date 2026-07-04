<script setup lang="ts">
// PRD-C-212 V0：全量 ElementPlus 注册已删（unplugin 按需导入），
// zh-cn locale 改由 ElConfigProvider 提供（el-date-picker/el-pagination 等中文文案依赖）
import zhCn from 'element-plus/es/locale/lang/zh-cn'
// PRD-C-212 增量：页内登录弹窗（替代独立 /login 页）挂根级——AppLayout 内外（含 /register）都能唤起
import LoginDialog from '@/components/LoginDialog/index.vue'
</script>

<template>
  <el-config-provider :locale="zhCn">
    <RouterView />
    <LoginDialog />
  </el-config-provider>
</template>
