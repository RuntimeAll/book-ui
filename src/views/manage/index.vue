<script setup lang="ts">
/**
 * 管理中心（PRD-C-207 V9）—— superadmin / org_admin 专属：成员 + 讲义内容 + 邀请码（占位）。
 * 权限模型正本 = only-one/权限与内容归属模型-定版.md §6。
 *
 * - 成员管理：只读列表（BE 按角色缩范围：superadmin=全部 / org_admin=本部门 / 其余 403）。
 *   账号/角色/部门本身的增删改走数据库（若依 sys_user/sys_role/sys_dept），本页不做 CRUD。
 * - 内容管理：讲义清单（owner×课时聚合），可删除某人某课时的全部讲义片段（官方=owner 1 仅超管本人可操作，
 *   BE 会拦，前端双保险 disabled）。
 * - 邀请码：占位卡，设计见权限模型 §5，暂未开放。
 *
 * 403（BE 判定当前角色不可访问）→ 整页居中空态，不展示三张卡片骨架。
 */
import { ref, onMounted } from 'vue'
import axios from 'axios'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Lock } from '@element-plus/icons-vue'
import { getCurrentUser } from '@/api/user'
import { useUserStore } from '@/store/user'
import {
  getManageMembers, getManageLectures, removeLectureFrags,
  type ManageMember, type ManageLecture,
} from '@/api/kg/lecture'

const userStore = useUserStore()

const membersLoading = ref(false)
const lecturesLoading = ref(false)
const members = ref<ManageMember[]>([])
const lectures = ref<ManageLecture[]>([])
/** 任一管理接口 403 → 判定当前账号无权访问本页，整页让位空态 */
const accessDenied = ref(false)
/** 删除进行中的行 key（owner:bookId:lessonId），防连点重复提交 */
const removingKey = ref<string | null>(null)

function isForbidden(e: unknown): boolean {
  return axios.isAxiosError(e) && e.response?.status === 403
}

interface RoleTag { key: string; label: string; cls: string }
/** roleKeys 逗号串 → 展示用标签（superadmin 红 / org_admin 紫 / teacher 青 / 其余灰） */
function parseRoles(roleKeys: string | null): RoleTag[] {
  if (!roleKeys) return []
  return roleKeys.split(',').map((k) => k.trim()).filter(Boolean).map((key) => {
    if (key === 'superadmin') return { key, label: '超管', cls: 'role-super' }
    if (key === 'org_admin') return { key, label: '机构管理员', cls: 'role-org' }
    if (key === 'teacher') return { key, label: '老师', cls: 'role-teacher' }
    return { key, label: key, cls: 'role-other' }
  })
}

async function fetchMembers() {
  membersLoading.value = true
  try {
    members.value = (await getManageMembers()) ?? []
  } catch (e) {
    console.warn('[manage] getManageMembers 失败', e)
    if (isForbidden(e)) accessDenied.value = true
    members.value = []
  } finally {
    membersLoading.value = false
  }
}

async function fetchLectures() {
  lecturesLoading.value = true
  try {
    lectures.value = (await getManageLectures()) ?? []
  } catch (e) {
    console.warn('[manage] getManageLectures 失败', e)
    if (isForbidden(e)) accessDenied.value = true
    lectures.value = []
  } finally {
    lecturesLoading.value = false
  }
}

function rowKey(row: ManageLecture): string {
  return `${row.owner}:${row.bookId}:${row.lessonId}`
}

async function handleRemove(row: ManageLecture) {
  if (row.owner === 1) return // 官方讲义按钮已 disabled，双保险，BE 也会拦
  const key = rowKey(row)
  if (removingKey.value === key) return
  try {
    await ElMessageBox.confirm(
      `将删除该作者此课时的全部讲义片段，不可恢复（《${row.lessonName}》· ${row.ownerName}）`,
      '删除确认',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning', confirmButtonClass: 'el-button--danger' },
    )
  } catch {
    return // 取消
  }
  removingKey.value = key
  try {
    const res = await removeLectureFrags(row.bookId, row.owner, row.lessonId)
    ElMessage.success(`已删除 ${res.removed} 个片段`)
    await fetchLectures()
  } catch (e) {
    console.warn('[manage] removeLectureFrags 失败', e)
    ElMessage.error('删除失败，请重试')
  } finally {
    removingKey.value = null
  }
}

function fmtTime(t: string | null): string {
  return t ?? '—'
}

onMounted(async () => {
  // userInfo 内存态不持久化，刷新后兜底拉一次（[[feedback_fe_user_info_onmount_fallback]]）
  if (!userStore.userInfo) {
    try {
      const info = await getCurrentUser()
      if (info) userStore.setUserInfo(info)
    } catch (e) {
      console.warn('[manage] getCurrentUser 兜底失败', e)
    }
  }
  await Promise.all([fetchMembers(), fetchLectures()])
})
</script>

<template>
  <div class="mng-page">
    <!-- 403：整页居中空态，不展示卡片骨架 -->
    <div v-if="accessDenied" class="mng-denied">
      <el-icon class="ic"><Lock /></el-icon>
      <p>仅超管 / 机构管理员可访问</p>
    </div>

    <template v-else>
      <!-- 成员管理 -->
      <section class="mng-card">
        <div class="mng-head">
          <div class="t"><span class="bar" /><b>成员管理</b></div>
          <span class="n">{{ members.length }} 人</span>
        </div>
        <p class="mng-hint">账号 / 角色 / 部门维护走数据库（若依 sys_user / sys_role / sys_dept）</p>
        <div class="mng-body">
          <el-table v-loading="membersLoading" :data="members" size="default" empty-text="暂无成员">
            <el-table-column prop="nickName" label="昵称" min-width="120">
              <template #default="{ row }">
                {{ (row as ManageMember).nickName || (row as ManageMember).userName || '—' }}
              </template>
            </el-table-column>
            <el-table-column prop="userName" label="用户名" min-width="120" />
            <el-table-column prop="deptName" label="部门" min-width="140">
              <template #default="{ row }">
                {{ (row as ManageMember).deptName || '—' }}
              </template>
            </el-table-column>
            <el-table-column label="角色" min-width="180">
              <template #default="{ row }">
                <template v-if="parseRoles((row as ManageMember).roleKeys).length">
                  <el-tag
                    v-for="r in parseRoles((row as ManageMember).roleKeys)"
                    :key="r.key"
                    size="small"
                    :class="r.cls"
                    class="role-tag"
                  >
                    {{ r.label }}
                  </el-tag>
                </template>
                <span v-else class="mng-empty-cell">—</span>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </section>

      <!-- 内容管理（讲义） -->
      <section class="mng-card">
        <div class="mng-head">
          <div class="t"><span class="bar bar-lecture" /><b>内容管理</b></div>
          <span class="n">{{ lectures.length }} 份</span>
        </div>
        <div class="mng-body">
          <el-table v-loading="lecturesLoading" :data="lectures" size="default" empty-text="暂无讲义">
            <el-table-column prop="lessonName" label="课时" min-width="200" />
            <el-table-column label="作者" min-width="160">
              <template #default="{ row }">
                {{ (row as ManageLecture).ownerName }}
                <el-tag v-if="(row as ManageLecture).owner === 1" size="small" class="role-tag role-official">官方</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="fragCount" label="片段数" width="100" align="center" />
            <el-table-column label="更新时间" min-width="160">
              <template #default="{ row }">
                {{ fmtTime((row as ManageLecture).updatedAt) }}
              </template>
            </el-table-column>
            <el-table-column label="操作" width="110" align="center">
              <template #default="{ row }">
                <el-tooltip
                  v-if="(row as ManageLecture).owner === 1"
                  content="官方讲义仅超管账号本人可操作"
                  placement="top"
                >
                  <span>
                    <el-button size="small" type="danger" link disabled>删除</el-button>
                  </span>
                </el-tooltip>
                <el-button
                  v-else
                  size="small"
                  type="danger"
                  link
                  :loading="removingKey === rowKey(row as ManageLecture)"
                  @click="handleRemove(row as ManageLecture)"
                >
                  删除
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </section>

      <!-- 邀请码（占位） -->
      <section class="mng-card">
        <div class="mng-head">
          <div class="t"><span class="bar bar-invite" /><b>邀请码</b></div>
        </div>
        <div class="mng-body mng-invite-body">
          <p class="mng-hint">通过邀请码加入机构 —— 即将开放</p>
          <el-button disabled>生成邀请码</el-button>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.mng-page {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px 20px 28px;
  max-width: 1080px;
  margin: 0 auto;
}

.mng-card {
  background: #fff;
  border: 1px solid #eef1f1;
  border-radius: 10px;
  box-shadow: 0 1px 3px rgba(22, 36, 42, 0.05);
  overflow: hidden;
}

.mng-head {
  padding: 13px 16px;
  border-bottom: 1px solid #eef2f2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.mng-head .t { display: flex; align-items: center; gap: 8px; }
.mng-head .bar { width: 3px; height: 15px; border-radius: 2px; background: #1e8a8a; }
.mng-head .bar-lecture { background: #7b6cf0; }
.mng-head .bar-invite { background: #c9962f; }
.mng-head b { font-size: 14px; font-weight: 700; color: #16242a; }
.mng-head .n { font-size: 10.5px; color: #a8b2b6; }

.mng-hint { margin: 10px 16px 0; font-size: 12px; color: #7c8a90; }

.mng-body { padding: 12px 16px 16px; }
.mng-invite-body { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.mng-empty-cell { color: #a8b2b6; }

/* 角色 / 归属标签（超管红 / 机构管理员紫 / 老师青 / 官方紫，其余灰） */
.role-tag { border: 1px solid transparent; margin-right: 4px; font-weight: 600; }
.role-tag.role-super { background: #fdeaea; color: #c0392b; border-color: #f6c9c9; }
.role-tag.role-org { background: #f4f2fe; color: #6357d6; border-color: #d9d5f6; }
.role-tag.role-teacher { background: #e6f2f2; color: #176e6e; border-color: #bfe0e0; }
.role-tag.role-other { background: #f1f3f4; color: #7c8a90; border-color: #e3e9e9; }
.role-tag.role-official { background: #f4f2fe; color: #6357d6; border-color: #d9d5f6; margin-left: 6px; }

/* 403 空态 */
.mng-denied {
  flex: 1;
  min-height: 60vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: #a8b2b6;
}
.mng-denied .ic { font-size: 42px; color: #cdd6d6; }
.mng-denied p { font-size: 14px; }
</style>
