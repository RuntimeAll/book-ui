<script setup lang="ts">
/**
 * PRD-015 批5 · 教务速办登录门（/m/login，D15 简单版 / V25）。
 *
 * 🔴 D15 只做最基础：复用项目既有 sa-token 登录链（api/auth 的 login + store/user 的 setAuth），
 *    不做任何角色 / 权限矩阵界面，数据归属沿 create_by 单老师语义。
 * 🔴「飞书环境·一键免登」本期置灰：免登 = PRD-007 openid→botLogin 免密链，需要飞书管理后台
 *    加开网页应用能力 + JSSDK 接线，归上线段（PRD §9 边界）。
 * 与桌面端 LoginDialog 的差异：桌面登录成功要整页 reload（游客态降级数据重拉），移动四页
 * 全在 onMounted 拉数据、token 由 http/request 请求时现取，直接 router.replace 即可，不刷页。
 */
import { computed, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  DEFAULT_CLIENT_ID,
  DEFAULT_TENANT_ID,
  GRANT_TYPE_PASSWORD,
  getCaptcha,
  login,
} from '@/api/auth'
import { useUserStore } from '@/store/user'
import './mobile.css'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()

const form = reactive({ username: '', password: '', code: '' })
const loading = ref(false)

// 验证码：BE captchaEnabled=false 时不展示、不提交（与桌面端登录同口径）
const captchaEnabled = ref(false)
const captchaImg = ref('')
const captchaUuid = ref('')

const redirect = computed(() => {
  const r = route.query.redirect
  return typeof r === 'string' && r.startsWith('/m/') ? r : '/m/schedule'
})

async function refreshCaptcha() {
  try {
    const res = await getCaptcha()
    captchaEnabled.value = res.captchaEnabled
    captchaImg.value = res.img ? `data:image/gif;base64,${res.img}` : ''
    captchaUuid.value = res.uuid ?? ''
    form.code = ''
  } catch {
    // 拉不到验证码不阻塞登录（降级为不带 code）
  }
}

async function onLogin() {
  if (!form.username.trim() || !form.password) {
    ElMessage.warning('请输入账号和密码')
    return
  }
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
    router.replace(redirect.value)
  } catch {
    // 拦截器已提示具体错因；验证码开着则换一张防旧码重试
    if (captchaEnabled.value) void refreshCaptcha()
  } finally {
    loading.value = false
  }
}

void refreshCaptcha()
</script>

<template>
  <div class="m-app">
    <div class="m-login">
      <div class="box">
        <h2>备课帮 · 教务速办</h2>
        <p class="sub2">飞书内自动免登（上线段接线）；飞书外用系统账号登录。</p>

        <button class="m-btn pri" style="width: 100%" disabled>飞书环境 · 一键免登</button>
        <p class="tip">上线段接线（PRD-007 openid 链）</p>

        <div class="or">或 账号密码登录</div>

        <div class="m-field">
          <label for="m-user">账号</label>
          <input id="m-user" v-model="form.username" autocomplete="username" placeholder="系统账号" />
        </div>
        <div class="m-field">
          <label for="m-pwd">密码</label>
          <input
            id="m-pwd"
            v-model="form.password"
            type="password"
            autocomplete="current-password"
            placeholder="••••••"
            @keyup.enter="onLogin"
          />
        </div>
        <div v-if="captchaEnabled" class="m-field">
          <label for="m-code">验证码</label>
          <div style="display: flex; gap: 8px; align-items: center">
            <input id="m-code" v-model="form.code" autocomplete="off" @keyup.enter="onLogin" />
            <img
              v-if="captchaImg"
              :src="captchaImg"
              alt="点击刷新验证码"
              style="height: 38px; width: 110px; border-radius: 8px; flex: none"
              @click="refreshCaptcha"
            />
          </div>
        </div>

        <button class="m-btn pri" style="width: 100%" :disabled="loading" @click="onLogin">
          {{ loading ? '登录中…' : '登 录' }}
        </button>
      </div>
    </div>
  </div>
</template>
