<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { FormInstance, FormRules } from 'element-plus'
import { ElMessage } from 'element-plus'
import { registerTeacher } from '@/api/user'

// U 卡 段⑧ — 老师注册页
//
// 极简表单：用户名 + 密码 + 确认密码 + 真名（可选）
// 提交 → BE /teacher/user/register 自动绑 teacher 角色
// 成功 → ElMessage 提示 + 自动跳 /login 并传 username 预填

const router = useRouter()

const formRef = ref<FormInstance | null>(null)

const form = reactive({
  userName: '',
  password: '',
  passwordConfirm: '',
  nickName: '',
})

const validatePasswordConfirm = (
  _rule: unknown,
  value: string,
  callback: (error?: Error) => void,
) => {
  if (value !== form.password) {
    callback(new Error('两次密码输入不一致'))
  } else {
    callback()
  }
}

const rules: FormRules = {
  userName: [
    { required: true, message: '请输入用户名', trigger: 'blur' },
    { min: 4, max: 20, message: '用户名长度需 4-20 字符', trigger: 'blur' },
    {
      pattern: /^[a-zA-Z0-9_-]+$/,
      message: '用户名只能含字母 / 数字 / 下划线 / 横杠',
      trigger: 'blur',
    },
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { min: 6, max: 20, message: '密码长度需 6-20 字符', trigger: 'blur' },
  ],
  passwordConfirm: [
    { required: true, message: '请再次输入密码', trigger: 'blur' },
    { validator: validatePasswordConfirm, trigger: 'blur' },
  ],
  nickName: [
    { max: 30, message: '真名不超过 30 字符', trigger: 'blur' },
  ],
}

const loading = ref(false)

async function onSubmit() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return

  loading.value = true
  try {
    const result = await registerTeacher({
      userName: form.userName.trim(),
      password: form.password,
      nickName: form.nickName.trim() || undefined,
    })
    ElMessage.success(`注册成功！欢迎 ${result.userName}，请登录`)
    // 注册后跳登录页 — query 传 username 让 login 页预填
    await router.push({ path: '/login', query: { u: result.userName } })
  } catch {
    // 拦截器已 ElMessage.error（用户名重复 / 校验失败）
  } finally {
    loading.value = false
  }
}

function goLogin() {
  router.push('/login')
}
</script>

<template>
  <div class="register-page">
    <el-card class="register-card" shadow="always">
      <div class="register-title">老师注册</div>
      <div class="register-subtitle">misikt 教师端复刻 · 加入教师社区</div>

      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-position="top"
        class="register-form"
        @submit.prevent="onSubmit"
      >
        <el-form-item label="用户名" prop="userName">
          <el-input
            v-model="form.userName"
            placeholder="4-20 字符（字母 / 数字 / 下划线 / 横杠）"
            autocomplete="username"
            clearable
          />
        </el-form-item>

        <el-form-item label="密码" prop="password">
          <el-input
            v-model="form.password"
            type="password"
            placeholder="6-20 字符"
            autocomplete="new-password"
            show-password
          />
        </el-form-item>

        <el-form-item label="确认密码" prop="passwordConfirm">
          <el-input
            v-model="form.passwordConfirm"
            type="password"
            placeholder="再次输入密码"
            autocomplete="new-password"
            show-password
            @keyup.enter="onSubmit"
          />
        </el-form-item>

        <el-form-item label="真名（可选）" prop="nickName">
          <el-input
            v-model="form.nickName"
            placeholder="便于他人识别（不填则使用用户名）"
            clearable
          />
        </el-form-item>

        <el-button
          type="primary"
          class="register-button"
          :loading="loading"
          @click="onSubmit"
        >
          注册并加入
        </el-button>

        <div class="login-link">
          已有账号？<el-link type="primary" :underline="false" @click="goLogin">立即登录</el-link>
        </div>
      </el-form>
    </el-card>
  </div>
</template>

<style scoped>
.register-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #f5f8ff 0%, #e8f0ff 100%);
}

.register-card {
  width: 420px;
  padding: 8px 16px 16px;
}

.register-title {
  font-size: 22px;
  font-weight: 600;
  color: #303133;
  text-align: center;
  margin-bottom: 4px;
}

.register-subtitle {
  font-size: 13px;
  color: #909399;
  text-align: center;
  margin-bottom: 24px;
}

.register-form {
  margin-top: 8px;
}

.register-button {
  width: 100%;
  margin-top: 12px;
}

.login-link {
  margin-top: 16px;
  text-align: center;
  font-size: 13px;
  color: #606266;
}
</style>
