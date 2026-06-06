<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { FormInstance, FormRules } from 'element-plus'
import {
  DEFAULT_CLIENT_ID,
  DEFAULT_TENANT_ID,
  GRANT_TYPE_PASSWORD,
  getCaptcha,
  login,
} from '@/api/auth'
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
  code: '',
})

// PRD-A-005 T1 — 图形验证码状态
// captchaEnabled=false（如 dev）时隐藏控件、提交不带 code/uuid。
const captchaEnabled = ref(false)
const captchaImg = ref('')
const captchaUuid = ref('')

async function refreshCaptcha() {
  try {
    const res = await getCaptcha()
    captchaEnabled.value = res.captchaEnabled
    if (res.captchaEnabled) {
      captchaImg.value = res.img ? `data:image/gif;base64,${res.img}` : ''
      captchaUuid.value = res.uuid ?? ''
      form.code = ''
    }
  } catch {
    // 拉验证码失败不阻塞页面；拦截器已提示。开关保持 false（降级为不强制验证码）。
  }
}

// U 卡 段⑧ — 从 /register 跳回时 query.u 含注册的用户名，自动预填登录表单
onMounted(() => {
  const u = route.query.u
  if (typeof u === 'string' && u.length > 0) {
    form.username = u
    form.password = ''
  }
  refreshCaptcha()
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
  // 验证码必填仅在 captchaEnabled 时生效（动态 required）
  code: [
    {
      validator: (_r: unknown, value: string, cb: (e?: Error) => void) => {
        if (captchaEnabled.value && !value) cb(new Error('请输入验证码'))
        else cb()
      },
      trigger: 'blur',
    },
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
      ...(captchaEnabled.value
        ? { code: form.code.trim(), uuid: captchaUuid.value }
        : {}),
    })
    userStore.setAuth(result)

    // PRD-A-005 T1 / [[feedback_fe_user_info_onmount_fallback]] —
    // 写 auth localStorage 后必须 location.reload() 整页刷：仅改 hash 会被 router guard
    // 踢回 /login（守卫在 reload 前读不到刚写入的登录态时序）。reload 后由首屏/业务页
    // onMounted 兜底拉 getCurrentUser 做角色分流，故此处不再在本页拉 current。
    // redirect 回跳：若来时带 query.redirect 则刷到该 hash，否则走根路由（/→/question/index）。
    const redirect = route.query.redirect
    const target = typeof redirect === 'string' && redirect.length > 0 ? redirect : '/'
    window.location.hash = `#${target}`
    window.location.reload()
  }
  catch {
    // 拦截器已 ElMessage.error；登录失败刷新验证码（多为验证码/密码错，旧码已失效）
    if (captchaEnabled.value) refreshCaptcha()
    loading.value = false
  }
}
</script>

<template>
  <div class="login-page">
    <el-card class="login-card" shadow="always">
      <div class="login-title"><span class="brand-ai">AI</span>·备课助手</div>
      <div class="login-subtitle">教培老师的命题外脑 · 请登录后继续</div>

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

        <!-- PRD-A-005 T1 — 图形验证码（captchaEnabled=false 时整块隐藏） -->
        <el-form-item v-if="captchaEnabled" label="验证码" prop="code">
          <div class="captcha-row">
            <el-input
              v-model="form.code"
              placeholder="请输入验证码"
              autocomplete="off"
              class="captcha-input"
              @keyup.enter="onSubmit"
            />
            <img
              v-if="captchaImg"
              :src="captchaImg"
              class="captcha-img"
              alt="点击刷新验证码"
              title="点击刷新"
              @click="refreshCaptcha"
            >
          </div>
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
  color: #1d2a2e;
  text-align: center;
  margin-bottom: 4px;
}

/* "AI" 二字 violet-600 点睛（DESIGN §2.2） */
.login-title .brand-ai {
  color: #7b6cf0;
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

.captcha-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}

.captcha-input {
  flex: 1;
}

.captcha-img {
  height: 40px;
  width: 120px;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  cursor: pointer;
  object-fit: cover;
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
