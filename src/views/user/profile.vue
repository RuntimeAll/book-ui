<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { useUserStore } from '@/store/user'
import {
  getCurrentUser,
  updateProfile,
  type UpdateProfilePayload,
} from '@/api/user'
import AiMemorySection from './AiMemorySection.vue'

// PRD-002 段③ — 教师个人资料页（登录态内页）。
//
// 字段：
//   - 账号 userName       只读（登录账号，不可改）
//   - 手机号 phone        只读（登录账号；改需联系管理员）
//   - 真实姓名 realName    必填 input  → 落 sys_user.nick_name
//   - 性别 sex            radio 0 男 / 1 女
//   - 任教年级 grade       必填 select → 落 sys_user.grade
//   - 学校 school         input        → 落 sys_user.school
//
// 设计原则（记忆铁则）：
//   - userInfo 内存态不持久化，刷新后丢失 → onMounted 必须兜底拉 getCurrentUser 回填。
//   - 必填前端校验（姓名 / 年级 空）拦住，不发 update 请求。
//   - userId 不传 body，BE 从登录态取（防越权改他人）。

const userStore = useUserStore()

// PRD-C-100 B6：tab 切换（个人资料 / AI 记忆）
const activeTab = ref<'profile' | 'memory'>('profile')

const formRef = ref<FormInstance>()
const loading = ref(false)
const saving = ref(false)

// 只读账号信息（登录账号，不进 update body）
const account = reactive({
  userName: '',
  phone: '',
})

// 可编辑表单
const form = reactive<UpdateProfilePayload>({
  realName: '',
  sex: null,
  grade: '',
  school: '',
})

// 任教年级下拉选项（按 misikt 硬编码）
const gradeOptions = [
  '小学一年级',
  '小学二年级',
  '小学三年级',
  '小学四年级',
  '小学五年级',
  '小学六年级',
  '初中一年级',
  '初中二年级',
  '初中三年级',
  '高中一年级',
  '高中二年级',
  '高中三年级',
]

const rules: FormRules = {
  realName: [{ required: true, message: '请输入真实姓名', trigger: 'blur' }],
  grade: [{ required: true, message: '请选择任教年级', trigger: 'change' }],
}

/** 用 current 响应回填表单 + 只读账号信息 */
function fillFromUserInfo(info: {
  userName?: string
  phone?: string
  realName?: string
  sex?: number | null
  grade?: string | null
  school?: string | null
}) {
  account.userName = info.userName ?? ''
  account.phone = info.phone ?? ''
  form.realName = info.realName ?? ''
  form.sex = info.sex ?? null
  form.grade = info.grade ?? ''
  form.school = info.school ?? ''
}

async function loadProfile() {
  loading.value = true
  try {
    // 记忆铁则：userInfo 内存态刷新丢失 → 进页必须兜底拉 current（不依赖 store 缓存）
    const info = await getCurrentUser()
    if (info) {
      userStore.setUserInfo(info)
      fillFromUserInfo(info)
    }
  } catch (e) {
    console.warn('[profile] getCurrentUser 回填失败', e)
    ElMessage.error('个人资料加载失败，请刷新重试')
  } finally {
    loading.value = false
  }
}

async function handleSave() {
  if (!formRef.value) {
    return
  }
  // 必填前端校验：姓名 / 年级 空 → 拦住，不发 update
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) {
    return
  }

  saving.value = true
  try {
    await updateProfile({
      realName: form.realName.trim(),
      sex: form.sex,
      grade: form.grade,
      school: form.school?.trim() || null,
    })
    ElMessage.success('保存成功')
    // 保存后重拉 current 同步最新态（含 store，供其他页用）
    await loadProfile()
  } catch (e) {
    console.warn('[profile] updateProfile 失败', e)
    // request.ts 拦截器已对 BE 错误做 ElMessage.error，这里不重复弹
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  loadProfile()
})
</script>

<template>
  <div class="profile-page">
    <header class="profile-header">
      <h1 class="title">个人中心</h1>
      <p class="subtitle">完善你的资料，并维护 AI 命题 / 组卷的个性化记忆</p>
    </header>

    <el-tabs v-model="activeTab" class="profile-tabs">
      <el-tab-pane label="个人资料" name="profile">
        <div v-loading="loading" class="profile-card">
          <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-width="100px"
        class="profile-form"
      >
        <!-- 账号（只读，登录账号） -->
        <el-form-item label="账号">
          <el-input
            v-model="account.userName"
            readonly
            disabled
            placeholder="登录账号"
          />
        </el-form-item>

        <!-- 手机号（只读 + 提示文案） -->
        <el-form-item label="手机号">
          <el-input
            v-model="account.phone"
            readonly
            disabled
            placeholder="未绑定手机号"
          />
          <div class="field-tip">手机号是登录账号，如需修改请联系管理员</div>
        </el-form-item>

        <!-- 真实姓名（必填） -->
        <el-form-item label="真实姓名" prop="realName">
          <el-input v-model="form.realName" placeholder="请输入真实姓名" />
        </el-form-item>

        <!-- 性别 0 男 / 1 女 -->
        <el-form-item label="性别">
          <el-radio-group v-model="form.sex">
            <el-radio :value="0">男</el-radio>
            <el-radio :value="1">女</el-radio>
          </el-radio-group>
        </el-form-item>

        <!-- 任教年级（必填，单选 select） -->
        <el-form-item label="任教年级" prop="grade">
          <el-select
            v-model="form.grade"
            placeholder="请选择任教年级"
            class="full-width"
          >
            <el-option
              v-for="g in gradeOptions"
              :key="g"
              :label="g"
              :value="g"
            />
          </el-select>
        </el-form-item>

        <!-- 学校 -->
        <el-form-item label="学校">
          <el-input v-model="form.school" placeholder="请输入学校" />
        </el-form-item>

        <el-form-item>
          <el-button type="primary" :loading="saving" @click="handleSave">
            保存
          </el-button>
        </el-form-item>
          </el-form>
        </div>
      </el-tab-pane>

      <el-tab-pane label="AI 记忆" name="memory">
        <div class="profile-card">
          <AiMemorySection />
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<style scoped>
.profile-page {
  padding: 24px 32px;
  max-width: 860px;
  margin: 0 auto;
}

.profile-tabs {
  margin-top: 4px;
}

.profile-header {
  margin-bottom: 24px;
}

.profile-header .title {
  font-size: 22px;
  font-weight: 600;
  color: #1d2129;
  margin: 0 0 8px;
}

.profile-header .subtitle {
  font-size: 13px;
  color: #4e5969;
  margin: 0;
}

.profile-card {
  background: #fff;
  border-radius: 10px;
  padding: 28px 32px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
}

.profile-form {
  max-width: 480px;
}

.full-width {
  width: 100%;
}

.field-tip {
  font-size: 12px;
  color: #86909c;
  line-height: 1.6;
  margin-top: 2px;
}
</style>
