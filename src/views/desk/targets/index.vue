<script setup lang="ts">
/**
 * PRD-C-213 学生与班级（/desk/targets）· FP12-15 + FP20。
 * - FP12 对象卡片墙：学生+班级统一列表，seg 切类型 + keyword 搜索 + 归档开关（归档卡置灰）。
 *   建档/编辑弹窗（学生与班级两套字段，班级可设学员）。归档/取消归档在详情面板。
 * - FP13 计划绑定与进度：卡片 + 详情头显示后端聚合字段。
 * - FP14/15/20：点卡片进详情面板（同页），含场次表 / 迷你月历 / 肖像四格。
 *
 * 数据：一次拉全量（pageTargets 大页），类型 tab / 计数在前端切分（对象数为教师量级，几十条内）；
 * keyword + 归档开关走服务端。BE 未起时请求失败 → 优雅空态，不阻塞。
 */
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useUserStore } from '@/store/user'
import { getCurrentUser } from '@/api/user'
import {
  pageTargets,
  getTarget,
  type TargetCardVO,
  type TargetDetailVO,
  type TargetType,
} from '@/api/teacher/schedule'
import TargetCard from './components/TargetCard.vue'
import TargetDetailPanel from './components/TargetDetailPanel.vue'
import TargetEditDialog from './components/TargetEditDialog.vue'

const router = useRouter()
const userStore = useUserStore()

// —— 筛选态 ——
const typeFilter = ref<'' | TargetType>('')
const keyword = ref('')
const includeArchived = ref(false)

// —— 数据 ——
const allCards = ref<TargetCardVO[]>([])
const loading = ref(false)
const loadError = ref(false)

let loadSeq = 0
async function loadCards() {
  const my = ++loadSeq
  loading.value = true
  loadError.value = false
  try {
    const res = await pageTargets({
      keyword: keyword.value.trim() || undefined,
      includeArchived: includeArchived.value,
      pageSize: 200,
    })
    if (my !== loadSeq) return
    allCards.value = res.rows || []
    // 选中卡若已不在列表（如归档后隐藏）→ 收起详情
    if (selectedId.value && !allCards.value.some((c) => c.id === selectedId.value)) {
      selectedId.value = ''
    }
  } catch {
    if (my === loadSeq) {
      allCards.value = []
      loadError.value = true
    }
  } finally {
    if (my === loadSeq) loading.value = false
  }
}

// —— 关键字防抖 ——
let kwTimer: ReturnType<typeof setTimeout> | null = null
watch(keyword, () => {
  if (kwTimer) clearTimeout(kwTimer)
  kwTimer = setTimeout(loadCards, 300)
})
watch(includeArchived, loadCards)

// —— 计数 + 展示列表 ——
const studentCount = computed(() => allCards.value.filter((c) => c.targetType === '0').length)
const classCount = computed(() => allCards.value.filter((c) => c.targetType === '1').length)
const totalCount = computed(() => allCards.value.length)

const displayCards = computed(() => {
  if (!typeFilter.value) return allCards.value
  return allCards.value.filter((c) => c.targetType === typeFilter.value)
})

const studentOptions = computed(() =>
  allCards.value.filter((c) => c.targetType === '0').map((c) => ({ id: c.id, name: c.name })),
)

// —— 选中 / 详情 ——
const selectedId = ref('')
const detailTick = ref(0)
const selectedCard = computed(() => allCards.value.find((c) => c.id === selectedId.value) || null)

function onSelect(id: string) {
  selectedId.value = selectedId.value === id ? '' : id
}

// —— 建档 / 编辑弹窗 ——
const editVisible = ref(false)
const editMode = ref<'create' | 'edit'>('create')
const editType = ref<TargetType>('0')
const editDetail = ref<TargetDetailVO | null>(null)

function openCreate(t: TargetType) {
  editMode.value = 'create'
  editType.value = t
  editDetail.value = null
  editVisible.value = true
}

async function openEdit(id: string) {
  const card = allCards.value.find((c) => c.id === id)
  editType.value = card?.targetType ?? '0'
  editMode.value = 'edit'
  editDetail.value = null
  try {
    editDetail.value = await getTarget(id)
  } catch {
    ElMessage.error('无法加载对象详情')
    return
  }
  editVisible.value = true
}

async function onSaved(id: string) {
  await loadCards()
  // 若编辑的是当前选中对象 → 触发详情面板重载
  if (selectedId.value === id) detailTick.value++
}

function onRefreshCards() {
  loadCards()
  detailTick.value++
}

function openPrep(sessionId: string) {
  // BUG-008/BUG-009：补 targetId（供身份行拼装）+ from（供返回按钮溯源）
  const query: Record<string, string> = { sessionId, from: 'targets' }
  if (selectedId.value) query.targetId = selectedId.value
  router.push({ path: '/desk/prep', query })
}

onMounted(async () => {
  // userInfo onMounted 兜底（刷新后不丢角色）
  if (!userStore.userInfo) {
    try {
      const info = await getCurrentUser()
      if (info) userStore.setUserInfo(info)
    } catch (e) {
      console.warn('[desk-targets] getCurrentUser 兜底失败', e)
    }
  }
  await loadCards()
})
</script>

<template>
  <div class="tg-page">
    <!-- 头部 -->
    <div class="tg-head">
      <div class="tg-title-box">
        <h1 class="tg-title">学生与班级</h1>
        <p class="tg-sub">排课对象两类：一对一学生 / 班课 · 每个对象一份课表 + 绑定一份课程计划</p>
      </div>
      <span class="spacer" />
      <div class="seg" role="group" aria-label="对象类型">
        <button :class="{ on: typeFilter === '' }" @click="typeFilter = ''">全部 {{ totalCount }}</button>
        <button :class="{ on: typeFilter === '0' }" @click="typeFilter = '0'">学生 {{ studentCount }}</button>
        <button :class="{ on: typeFilter === '1' }" @click="typeFilter = '1'">班级 {{ classCount }}</button>
      </div>
      <el-input
        v-model="keyword"
        placeholder="搜索姓名"
        clearable
        size="default"
        class="tg-search"
      />
      <el-checkbox v-model="includeArchived" class="tg-arch">含归档</el-checkbox>
      <el-button @click="openCreate('1')">新建班级</el-button>
      <el-button type="primary" @click="openCreate('0')">
        <span class="plus">＋</span>新建学生
      </el-button>
    </div>

    <!-- 卡片墙 -->
    <div v-loading="loading" class="tg-cards-wrap">
      <div v-if="displayCards.length" class="tg-cards">
        <TargetCard
          v-for="c in displayCards"
          :key="c.id"
          :card="c"
          :selected="c.id === selectedId"
          @select="onSelect"
          @edit="openEdit"
        />
      </div>
      <div v-else-if="!loading" class="tg-empty">
        <p v-if="loadError">加载失败 · 后端可能未启动，请稍后重试</p>
        <p v-else-if="keyword">未找到匹配「{{ keyword }}」的对象</p>
        <p v-else>还没有学生或班级，点右上角「新建学生 / 新建班级」建档</p>
      </div>
    </div>

    <!-- 详情面板 -->
    <TargetDetailPanel
      v-if="selectedCard"
      :key="selectedId + '-' + detailTick"
      :card="selectedCard"
      class="tg-detail"
      @refresh-cards="onRefreshCards"
      @edit="openEdit"
      @open-prep="openPrep"
      @close="selectedId = ''"
    />

    <!-- 建档 / 编辑弹窗 -->
    <TargetEditDialog
      v-model="editVisible"
      :mode="editMode"
      :target-type="editType"
      :detail="editDetail"
      :student-options="studentOptions"
      @saved="onSaved"
    />
  </div>
</template>

<style scoped>
.tg-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.tg-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.tg-title-box {
  min-width: 0;
}
.tg-title {
  font-size: 19px;
  font-weight: 800;
  color: var(--bk-ink);
  margin: 0;
}
.tg-sub {
  font-size: 13px;
  color: #5f716d;
  margin: 2px 0 0;
}
.spacer {
  flex: 1;
}
.seg {
  display: flex;
  background: #fff;
  border: 1px solid var(--bk-line);
  border-radius: 9px;
  padding: 2px;
}
.seg button {
  padding: 5px 14px;
  border-radius: 7px;
  color: #5f716d;
  font-weight: 600;
  font-size: 13px;
  border: none;
  background: none;
  cursor: pointer;
}
.seg button.on {
  background: var(--bk-teal-soft);
  color: var(--bk-teal-deep);
}
.tg-search {
  width: 160px;
}
.tg-arch {
  margin: 0 2px;
}
.plus {
  margin-right: 4px;
  font-weight: 700;
}
.tg-cards-wrap {
  min-height: 120px;
}
.tg-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 14px;
}
.tg-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 160px;
  color: #8ba09a;
  font-size: 13px;
  background: #fff;
  border: 1px dashed var(--bk-line);
  border-radius: 12px;
}
.tg-detail {
  margin-top: 2px;
}
</style>
