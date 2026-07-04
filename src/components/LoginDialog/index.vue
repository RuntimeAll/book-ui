<script setup lang="ts">
/**
 * LoginDialog — 页内登录/注册双模式弹窗（PRD-C-212 增量，替代已下线的 /login、/register 页）。
 *
 * 登录（迁自原 views/login，Y2 卡登录契约 + PRD-A-005 T1 验证码开关）：
 * - username/password（+可选图形验证码），clientId/tenantId/grantType 硬编码兜底；
 * - 成功 = setAuth 后**整页 reload**（既有时序契约：仅改 hash 会被守卫在读到新登录态前踢走；
 *   顺带把游客态静默降级的个人化数据全部重拉）——open() 传了 redirect 就刷到目标 hash，否则原地刷。
 * 注册（迁自原 views/register，U 卡段⑧契约）：
 * - userName/password/passwordConfirm/nickName(可选)（+可选验证码），POST /teacher/user/register 自动绑 teacher；
 * - 成功不刷页：切回登录模式并预填用户名。
 * 手动关闭弹窗会清掉残留 redirect（useLoginDialog.close）。
 */
import { reactive, ref, watch } from 'vue'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import {
  DEFAULT_CLIENT_ID,
  DEFAULT_TENANT_ID,
  GRANT_TYPE_PASSWORD,
  getCaptcha,
  login,
} from '@/api/auth'
import { registerTeacher } from '@/api/user'
import { useUserStore } from '@/store/user'
import { useLoginDialog } from '@/composables/useLoginDialog'

const userStore = useUserStore()
const { visible, mode, afterLoginPath, presetUsername, close } = useLoginDialog()

// ── 共享：图形验证码（登录/注册两套 BE 校验共用 captcha 端点）─────────────
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
      loginForm.code = ''
      regForm.code = ''
    }
  } catch {
    // 拉验证码失败不阻塞；开关保持 false（降级为不强制验证码）
  }
}

// 弹窗每次打开：预填用户名 + 拉验证码开关 + 清敏感字段
watch(visible, (v) => {
  if (!v) return
  if (presetUsername.value) {
    loginForm.username = presetUsername.value
    presetUsername.value = ''
  }
  loginForm.password = ''
  regForm.password = ''
  regForm.passwordConfirm = ''
  refreshCaptcha()
})

function switchMode(m: 'login' | 'register') {
  mode.value = m
  refreshCaptcha()
}

// ── 登录 ─────────────────────────────────────────────────────
const loginFormRef = ref<FormInstance | null>(null)
const loginForm = reactive({ username: '', password: '', code: '' })

const loginRules: FormRules = {
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

const loginLoading = ref(false)

async function onLogin() {
  const valid = await loginFormRef.value?.validate().catch(() => false)
  if (!valid) return
  loginLoading.value = true
  try {
    const result = await login({
      username: loginForm.username.trim(),
      password: loginForm.password,
      clientId: DEFAULT_CLIENT_ID,
      tenantId: DEFAULT_TENANT_ID,
      grantType: GRANT_TYPE_PASSWORD,
      ...(captchaEnabled.value ? { code: loginForm.code.trim(), uuid: captchaUuid.value } : {}),
    })
    userStore.setAuth(result)
    // 整页刷（时序契约见文件头）：带 redirect 刷到目标，否则原地刷新当前页
    const target = afterLoginPath.value
    if (target) window.location.hash = `#${target}`
    window.location.reload()
  } catch {
    // 拦截器已 ElMessage.error；失败刷新验证码（多为验证码/密码错，旧码已失效）
    if (captchaEnabled.value) refreshCaptcha()
    loginLoading.value = false
  }
}

// ── 注册 ─────────────────────────────────────────────────────
const regFormRef = ref<FormInstance | null>(null)
const regForm = reactive({ userName: '', password: '', passwordConfirm: '', nickName: '', code: '' })

const validatePasswordConfirm = (_rule: unknown, value: string, callback: (error?: Error) => void) => {
  if (value !== regForm.password) callback(new Error('两次密码输入不一致'))
  else callback()
}

const regRules: FormRules = {
  userName: [
    { required: true, message: '请输入用户名', trigger: 'blur' },
    { min: 4, max: 20, message: '用户名长度需 4-20 字符', trigger: 'blur' },
    { pattern: /^[a-zA-Z0-9_-]+$/, message: '用户名只能含字母 / 数字 / 下划线 / 横杠', trigger: 'blur' },
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { min: 6, max: 20, message: '密码长度需 6-20 字符', trigger: 'blur' },
  ],
  passwordConfirm: [
    { required: true, message: '请再次输入密码', trigger: 'blur' },
    { validator: validatePasswordConfirm, trigger: 'blur' },
  ],
  nickName: [{ max: 30, message: '真名不超过 30 字符', trigger: 'blur' }],
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

const regLoading = ref(false)

async function onRegister() {
  const valid = await regFormRef.value?.validate().catch(() => false)
  if (!valid) return
  regLoading.value = true
  try {
    const result = await registerTeacher({
      userName: regForm.userName.trim(),
      password: regForm.password,
      nickName: regForm.nickName.trim() || undefined,
      ...(captchaEnabled.value ? { code: regForm.code.trim(), uuid: captchaUuid.value } : {}),
    })
    ElMessage.success(`注册成功！欢迎 ${result.userName}，请登录`)
    // 注册成功：切回登录模式、预填用户名（不刷页，弹窗内闭环）
    loginForm.username = result.userName
    loginForm.password = ''
    switchMode('login')
  } catch {
    // 拦截器已 ElMessage.error（用户名重复/校验失败/验证码错）；刷新验证码防旧码重试
    if (captchaEnabled.value) refreshCaptcha()
  } finally {
    regLoading.value = false
  }
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
    @close="close"
  >
    <div class="ld-head">
      <div class="ld-title"><span class="ld-ai">AI</span>·备课帮</div>
      <div class="ld-sub">{{ mode === 'login' ? '教培老师的命题外脑 · 请登录后继续' : '注册教师账号 · 加入教师社区' }}</div>
    </div>

    <!-- 登录 -->
    <el-form
      v-if="mode === 'login'"
      ref="loginFormRef"
      :model="loginForm"
      :rules="loginRules"
      label-position="top"
      @submit.prevent="onLogin"
    >
      <el-form-item label="用户名" prop="username">
        <el-input v-model="loginForm.username" placeholder="请输入用户名" autocomplete="username" clearable />
      </el-form-item>
      <el-form-item label="密码" prop="password">
        <el-input
          v-model="loginForm.password"
          type="password"
          placeholder="请输入密码"
          autocomplete="current-password"
          show-password
          @keyup.enter="onLogin"
        />
      </el-form-item>
      <el-form-item v-if="captchaEnabled" label="验证码" prop="code">
        <div class="ld-captcha-row">
          <el-input v-model="loginForm.code" placeholder="请输入验证码" autocomplete="off" class="ld-captcha-input" @keyup.enter="onLogin" />
          <img v-if="captchaImg" :src="captchaImg" class="ld-captcha-img" alt="点击刷新验证码" title="点击刷新" @click="refreshCaptcha">
        </div>
      </el-form-item>
      <el-button type="primary" class="ld-submit" :loading="loginLoading" @click="onLogin">登录</el-button>
      <div class="ld-switch">
        还没有账号？<el-link type="primary" :underline="false" @click="switchMode('register')">立即注册</el-link>
      </div>
    </el-form>

    <!-- 注册 -->
    <el-form
      v-else
      ref="regFormRef"
      :model="regForm"
      :rules="regRules"
      label-position="top"
      @submit.prevent="onRegister"
    >
      <el-form-item label="用户名" prop="userName">
        <el-input v-model="regForm.userName" placeholder="4-20 位字母 / 数字 / 下划线 / 横杠" autocomplete="username" clearable />
      </el-form-item>
      <el-form-item label="密码" prop="password">
        <el-input v-model="regForm.password" type="password" placeholder="6-20 位" autocomplete="new-password" show-password />
      </el-form-item>
      <el-form-item label="确认密码" prop="passwordConfirm">
        <el-input v-model="regForm.passwordConfirm" type="password" placeholder="再输一遍" autocomplete="new-password" show-password @keyup.enter="onRegister" />
      </el-form-item>
      <el-form-item label="真实姓名（可选）" prop="nickName">
        <el-input v-model="regForm.nickName" placeholder="学生看到的名字，如：王老师" clearable />
      </el-form-item>
      <el-form-item v-if="captchaEnabled" label="验证码" prop="code">
        <div class="ld-captcha-row">
          <el-input v-model="regForm.code" placeholder="请输入验证码" autocomplete="off" class="ld-captcha-input" @keyup.enter="onRegister" />
          <img v-if="captchaImg" :src="captchaImg" class="ld-captcha-img" alt="点击刷新验证码" title="点击刷新" @click="refreshCaptcha">
        </div>
      </el-form-item>
      <el-button type="primary" class="ld-submit" :loading="regLoading" @click="onRegister">注册</el-button>
      <div class="ld-switch">
        已有账号？<el-link type="primary" :underline="false" @click="switchMode('login')">去登录</el-link>
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
.ld-switch { margin-top: 14px; text-align: center; font-size: 13px; color: #606266; }
</style>
