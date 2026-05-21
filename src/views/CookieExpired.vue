<script setup lang="ts">
// Cookie 失效友好提示页（FE-6.5）
function reloadPage() {
  window.location.reload()
}
</script>

<template>
  <div class="cookie-expired-page">
    <el-result
      icon="warning"
      title="登录凭据已失效"
      sub-title="misikt cookie 已过期，请按以下步骤更新后重试"
    >
      <template #extra>
        <el-card class="steps-card" shadow="never">
          <div class="steps-title">更新步骤</div>
          <el-steps direction="vertical" :active="0" class="update-steps">
            <el-step
              title="登录 misikt"
              description="打开 https://www.misikt.com/teacher/ 并登录你的教师账号"
            />
            <el-step
              title="导出 cookie"
              description="使用浏览器扩展（如 Cookie-Editor）导出 JSON 格式 cookie"
            />
            <el-step
              title="替换文件"
              description="将导出的 cookie.json 替换到项目的 PRD/2026-05-20-B-question-crud-scaffold/cookie.json"
            />
            <el-step
              title="重启开发服务器"
              description="在 book-ui 目录执行 pnpm dev 重启（Vite proxy 会重新加载 cookie）"
            />
          </el-steps>
        </el-card>
        <el-button type="primary" @click="reloadPage">
          已更新，刷新重试
        </el-button>
      </template>
    </el-result>
  </div>
</template>

<style scoped>
.cookie-expired-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f5f5f5;
}

.steps-card {
  width: 480px;
  margin-bottom: 24px;
  text-align: left;
}

.steps-title {
  font-size: 14px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 16px;
}

.update-steps {
  padding: 0 8px;
}
</style>
