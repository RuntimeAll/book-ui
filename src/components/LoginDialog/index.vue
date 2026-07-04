<script setup lang="ts">
/**
 * LoginDialog — 页内登录弹窗（PRD-C-212 增量，替代已下线的独立 /login 页）。
 *
 * 表单/提交逻辑迁自原 views/login/index.vue（Y2 卡登录契约 + PRD-A-005 T1 验证码开关）：
 * - 只露 username/password（+ 可选图形验证码），clientId/tenantId/grantType 硬编码兜底；
 * - 登录成功 = setAuth 后**整页 reload**（既有时序契约：仅改 hash 会被守卫在读到新登录态前踢走；
 *   顺带把游客态静默降级的个人化数据全部重拉）——open() 传了 redirect 就刷到目标 hash，否则原地刷。
 * - 弹窗打开时拉验证码开关；登录失败刷新验证码（拦截器已弹错误 toast）。
 */
import { reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { FormInstance, FormRules } from 'element-plus'
import {
  DEFAULT_CLIENT_ID,
  DEFAULT_TENANT_ID,
  GRANT_TYPE_PASSWORD,
  getCaptcha,
  login,
} from '@/api/auth'
import { useUserStore } from '@/store/user'
import { useLoginDialog } from '@/composables/useLoginDialog'

const router = useRouter()
const userStore = useUserStore()
const { visible, afterLoginPath, presetUsername, close } = useLoginDialog()

const formRef = ref<FormInstance | null>(null)
const form = reactive({ username: '', password: '', code: '' })

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
    // 拉验证码失败不阻塞；开关保持 false（降级为不强制验证码）
  }
}

// 弹窗每次打开：预填用户名（注册跳回场景）+ 拉验证码开关 + 清密码
watch(visible, (v) => {
  if (!v) return
  if (presetUsername.value) {
    form.username = presetUsername.value
    presetUsername.value = ''
  }
  form.password = ''
  refreshCaptcha()
})

const rules: FormRules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
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
      ...(captchaEnabled.value ? { code: form.code.trim(), uuid: captchaUuid.value } : {}),
    })
    userStore.setAuth(result)
    // 整页刷（时序契约见文件头）：带 redirect 刷到目标，否则原地刷新当前页
    const target = afterLoginPath.value
    if (target) window.location.hash = `#${target}`
    window.location.reload()
  } catch {
    // 拦截器已 ElMessage.error；失败刷新验证码（多为验证码/密码错，旧码已失效）
    if (captchaEnabled.value) refreshCaptcha()
    loading.value = false
  }
}

function goRegister() {
  close()
  router.push('/register')
}
</script>

<template>
  <el-dialog
    v-model="visible"
    width="400px"
    :show-close="true"
    :close-on-click-modal="true"
    align-center
    class="login-dialog"
  >
    <div class="ld-head">
      <div class="ld-title"><span class="ld-ai">AI</span>·备课帮</div>
      <div class="ld-sub">教培老师的命题外脑 · 请登录后继续</div>
    </div>
    <el-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-position="top"
      @submit.prevent="onSubmit"
    >
      <el-form-item label="用户名" prop="username">
        <el-input v-model="form.username" placeholder="请输入用户名" autocomplete="username" clearable />
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
      <el-form-item v-if="captchaEnabled" label="验证码" prop="code">
        <div class="ld-captcha-row">
          <el-input
            v-model="form.code"
            placeholder="请输入验证码"
            autocomplete="off"
            class="ld-captcha-input"
            @keyup.enter="onSubmit"
          />
          <img
            v-if="captchaImg"
            :src="captchaImg"
            class="ld-captcha-img"
            alt="点击刷新验证码"
            title="点击刷新"
            @click="refreshCaptcha"
          >
        </div>
      </el-form-item>
      <el-button type="primary" class="ld-submit" :loading="loading" @click="onSubmit">登录</el-button>
      <div class="ld-register">
        还没有账号？<el-link type="primary" :underline="false" @click="goRegister">立即注册</el-link>
      </div>
    </el-form>
  </el-dialog>
</template>

<style scoped>
.ld-head { text-align: center; margin-bottom: 18px; }
.ld-title { font-size: 20px; font-weight: 600; color: var(--bk-ink); }
.ld-ai { color: var(--bk-teal); }
.ld-sub { font-size: 13px; color: #909399; margin-top: 2px; }
.ld-captcha-row { display: flex; align-items: center; gap: 8px; width: 100%; }
.ld-captcha-input { flex: 1; }
.ld-captcha-img { height: 40px; width: 120px; border: 1px solid #dcdfe6; border-radius: 4px; cursor: pointer; object-fit: cover; }
.ld-submit { width: 100%; margin-top: 4px; }
.ld-register { margin-top: 14px; text-align: center; font-size: 13px; color: #606266; }
</style>
