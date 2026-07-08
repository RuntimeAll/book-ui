<script setup lang="ts">
/**
 * PRD-B-101 D7 兜底 · 挂已有卷弹层。
 * 列本人（mine 口径）卷，选一张 → emit picked(paperId)，由父页调 bindPaperSlot 绑到目标卷位。
 * 不区分卷型（普通卷/备课卷都可挂）；BE bind 校验卷归属本人。
 */
import { ref, watch } from 'vue'
import { getPaperPage, type PaperListItem } from '@/api/paper/index'

const props = defineProps<{
  modelValue: boolean
  /** 目标卷位描述（如「第1次课 · 概念辨析」），仅展示 */
  slotLabel?: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'picked', paperId: string): void
}>()

const papers = ref<PaperListItem[]>([])
const total = ref(0)
const loading = ref(false)
const keyword = ref('')
const pageIndex = ref(1)
const pageSize = 8

async function load() {
  loading.value = true
  try {
    const res = await getPaperPage({
      name: keyword.value.trim(),
      subjectId: '',
      pageIndex: pageIndex.value,
      pageSize,
      scope: 'mine',
    })
    papers.value = res?.list ?? []
    total.value = res?.total ?? 0
  } catch {
    papers.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      keyword.value = ''
      pageIndex.value = 1
      void load()
    }
  },
)

function onSearch() {
  pageIndex.value = 1
  void load()
}
function onPage(p: number) {
  pageIndex.value = p
  void load()
}

const picking = ref('')
function pick(item: PaperListItem) {
  picking.value = item.id
  emit('picked', item.id)
}

function close() {
  emit('update:modelValue', false)
}
// 供父页失败时复位
defineExpose({ resetPicking: () => (picking.value = '') })
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="挂已有卷到卷位"
    width="560px"
    append-to-body
    :close-on-click-modal="false"
    @update:model-value="close"
  >
    <p v-if="slotLabel" class="pk-target">挂到：<b>{{ slotLabel }}</b></p>
    <div class="pk-search">
      <el-input v-model="keyword" placeholder="搜卷名" clearable size="small" @keyup.enter="onSearch" @clear="onSearch" />
      <el-button size="small" @click="onSearch">查询</el-button>
    </div>
    <div v-loading="loading" class="pk-list">
      <div v-for="p in papers" :key="p.id" class="pk-row">
        <div class="pk-info">
          <b class="pk-name">{{ p.name }}</b>
          <span class="pk-meta">{{ p.questionCount }} 题 · {{ p.createTime }}</span>
        </div>
        <el-button size="small" type="primary" :loading="picking === p.id" @click="pick(p)">挂这张</el-button>
      </div>
      <el-empty v-if="!loading && papers.length === 0" description="没有可挂的卷（先去组卷）" :image-size="60" />
    </div>
    <div v-if="total > pageSize" class="pk-pager">
      <el-pagination
        background
        layout="prev, pager, next"
        :total="total"
        :current-page="pageIndex"
        :page-size="pageSize"
        @current-change="onPage"
      />
    </div>
    <template #footer>
      <el-button @click="close">取消</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.pk-target { font-size: 13px; color: #5f716d; margin: 0 0 10px; }
.pk-target b { color: var(--bk-ink); }
.pk-search { display: flex; gap: 8px; margin-bottom: 10px; }
.pk-list { min-height: 120px; display: flex; flex-direction: column; }
.pk-row { display: flex; align-items: center; gap: 10px; padding: 9px 4px; border-top: 1px solid #eef3f1; }
.pk-row:first-child { border-top: none; }
.pk-info { flex: 1; min-width: 0; }
.pk-name { font-size: 13px; color: var(--bk-ink); display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pk-meta { font-size: 11.5px; color: #8ba09a; }
.pk-pager { display: flex; justify-content: center; margin-top: 10px; }
</style>
