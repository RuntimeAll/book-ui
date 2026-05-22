<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { FormInstance, FormRules } from 'element-plus'
import {
  DEFAULT_CLIENT_ID,
  DEFAULT_TENANT_ID,
  GRANT_TYPE_PASSWORD,
  login,
} from '@/api/auth'
import { getCurrentUser } from '@/api/user'
import { useUserStore } from '@/store/user'

// Y2 卡 2a 波 — 登录页（PRD §3.2 登录契约）
//
// 表单只露 username + password；clientId / tenantId / grantType 硬编码兜底。
// 失败兜底：拦截器已 ElMessage.error；本页仅 catch 后释放 loading 即可。

const router = useRouter()
const route = useRoute()
const userStore = useUserStore()

const formRef = ref<FormInstance | null>(null)

const form = reactive({
  username: 'admin',
  password: '',
})

// U 卡 段⑧ — 从 /register 跳回时 query.u 含注册的用户名，自动预填登录表单
onMounted(() => {
  const u = route.query.u
  if (typeof u === 'string' && u.length > 0) {
    form.username = u
    form.password = ''
  }
})

function goRegister() {
  router.push('/register')
}

const rules: FormRules = {
  username: [
    { required: true, message: '请输入用户名', trigger: 'blur' },
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
  ],
}

const loading = ref(false)

async function onSubmit() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return

  loading.value = true
  try {
    const result = await login({
      username: form.username.trim(),
      password: form.password,
      clientId: DEFAULT_CLIENT_ID,
      tenantId: DEFAULT_TENANT_ID,
      grantType: GRANT_TYPE_PASSWORD,
    })
    userStore.setAuth(result)

    // U 卡新增 — 登录后拉用户信息（含 roles）做角色分流。
    // 拉失败兜底跳题库（不阻塞用户登录，view 层后续懒拉再补 store.userInfo）。
    try {
      const userInfo = await getCurrentUser()
      userStore.setUserInfo(userInfo)
      if (userInfo.roles?.includes('teacher')) {
        await router.push('/workspace')
      } else {
        await router.push('/home')
      }
    } catch {
      await router.push('/question/index')
    }
  }
  catch {
    // 拦截器已 ElMessage.error；这里只需释放 loading
  }
  finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-page">
    <el-card class="login-card" shadow="always">
      <div class="login-title">misikt 教师端复刻</div>
      <div class="login-subtitle">请登录后继续</div>

      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-position="top"
        class="login-form"
        @submit.prevent="onSubmit"
      >
        <el-form-item label="用户名" prop="username">
          <el-input
            v-model="form.username"
            placeholder="请输入用户名"
            autocomplete="username"
            clearable
          />
        </el-form-item>

        <el-form-item label="密码" prop="password">
          <el-input
            v-model="form.password"
            type="password"
            placeholder="请输入密码"
            autocomplete="current-password"
            show-password
            @keyup.enter="onSubmit"
          />
        </el-form-item>

        <el-button
          type="primary"
          class="login-button"
          :loading="loading"
          @click="onSubmit"
        >
          登录
        </el-button>

        <div class="register-link">
          还没有账号？<el-link type="primary" :underline="false" @click="goRegister">立即注册</el-link>
        </div>
      </el-form>
    </el-card>
  </div>
</template>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f5f5f5;
}

.login-card {
  width: 380px;
  padding: 8px 16px 16px;
}

.login-title {
  font-size: 20px;
  font-weight: 600;
  color: #303133;
  text-align: center;
  margin-bottom: 4px;
}

.login-subtitle {
  font-size: 13px;
  color: #909399;
  text-align: center;
  margin-bottom: 24px;
}

.login-form {
  margin-top: 8px;
}

.login-button {
  width: 100%;
  margin-top: 8px;
}

.register-link {
  margin-top: 16px;
  text-align: center;
  font-size: 13px;
  color: #606266;
}
</style>
