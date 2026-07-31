<script setup lang="ts">
/**
 * NetdiskDialog — 书的网盘链接管理（所有书型通用）。
 *
 * 一本书可挂 N 条网盘分享（百度/夸克/阿里/其他），多行编辑 + 整体保存（全量覆盖式）。
 * 数据在 biz_shelf_book.style_meta_json.netdisks；分页行通常已带 styleMeta.netdisks，
 * 只给了 netdiskCount（无明细）时打开弹窗现 GET 书详情拉全量。
 *
 * 「复制」= 一键拿到可直接粘给家长/学生的「链接 提取码：xxx」文本。
 */
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import {
  getBook,
  saveBookNetdisks,
  readBookNetdisks,
  NETDISK_PROVIDER_LABEL,
  type BookNetdisk,
  type NetdiskProvider,
  type ShelfBookVO,
} from '@/api/shelf'

const props = defineProps<{ visible: boolean; book: ShelfBookVO | null }>()
const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  /** 保存成功：把最新明细回抛给书架页，就地更新卡片小标不整页重拉 */
  (e: 'saved', payload: { bookId: string; netdisks: BookNetdisk[] }): void
}>()

const dialogVisible = computed({
  get: () => props.visible,
  set: (v: boolean) => emit('update:visible', v),
})

const providerOptions = Object.entries(NETDISK_PROVIDER_LABEL) as [NetdiskProvider, string][]

/** 编辑行（明细字段全部收敛成 string，保存时再剔空） */
type Row = { provider: NetdiskProvider | string; url: string; code: string; note: string }

const rows = ref<Row[]>([])
const loading = ref(false)
const saving = ref(false)

function toRow(n: BookNetdisk): Row {
  return {
    provider: n.provider || 'baidu',
    url: n.url ?? '',
    code: n.code ?? '',
    note: n.note ?? '',
  }
}

function addRow() {
  rows.value.push({ provider: 'baidu', url: '', code: '', note: '' })
}

function removeRow(i: number) {
  rows.value.splice(i, 1)
}

/** 打开时装载明细：行里有 netdisks 直接用；只有 netdiskCount（无明细）→ GET 书详情拉全量。 */
async function loadRows() {
  const b = props.book
  rows.value = []
  if (!b) return
  const inline = readBookNetdisks(b)
  if (inline) {
    rows.value = inline.map(toRow)
    if (!rows.value.length) addRow()
    return
  }
  loading.value = true
  try {
    const detail = await getBook(b.id)
    rows.value = (readBookNetdisks(detail) ?? []).map(toRow)
  } catch (e) {
    console.warn('[shelf][netdisk] 拉书详情失败:', e)
  } finally {
    loading.value = false
    if (!rows.value.length) addRow()
  }
}

watch(
  () => props.visible,
  (open) => {
    if (open) void loadRows()
  },
)

/** 复制文本：有提取码 → 「链接 提取码：xxx」；无提取码 → 只给链接。 */
function copyTextOf(r: Row): string {
  const url = r.url.trim()
  const code = r.code.trim()
  return code ? `${url} 提取码：${code}` : url
}

async function onCopy(r: Row) {
  const text = copyTextOf(r)
  if (!text) {
    ElMessage.warning('这条还没填链接')
    return
  }
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success('已复制到剪贴板')
  } catch {
    // 非安全上下文（http 访问）没有 clipboard API，降级 textarea + execCommand
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
      ElMessage.success('已复制到剪贴板')
    } catch {
      ElMessage.warning('复制失败，请手动选择文本复制')
    }
    document.body.removeChild(ta)
  }
}

async function onSave() {
  const b = props.book
  if (!b) return
  // 整行全空 = 用户加了没填，静默丢弃；填了别的却没链接 = 拦下提示
  const kept = rows.value.filter((r) => r.url.trim() || r.code.trim() || r.note.trim())
  const bad = kept.findIndex((r) => !r.url.trim())
  if (bad >= 0) {
    ElMessage.warning(`第 ${bad + 1} 条缺链接`)
    return
  }
  const payload: BookNetdisk[] = kept.map((r) => ({
    provider: r.provider,
    url: r.url.trim(),
    code: r.code.trim() || undefined,
    note: r.note.trim() || undefined,
  }))
  saving.value = true
  try {
    const res = await saveBookNetdisks(b.id, payload)
    const latest = Array.isArray(res?.netdisks) ? res.netdisks : payload
    ElMessage.success(latest.length ? `已保存 ${latest.length} 条网盘链接` : '已清空网盘链接')
    emit('saved', { bookId: b.id, netdisks: latest })
    dialogVisible.value = false
  } catch (e) {
    console.warn('[shelf][netdisk] 保存失败:', e)
    // 错误 toast 由 http 拦截器统一弹，这里不重复
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <el-dialog
    v-model="dialogVisible"
    :title="book ? `网盘链接 · ${book.title}` : '网盘链接'"
    width="760px"
    style="max-width: 94vw"
    :close-on-click-modal="false"
  >
    <div v-loading="loading" class="nd-body">
      <p class="nd-tip">同一本书可挂多条（正本 / 答案册 / 备份盘）；「复制」直接得到可发出去的「链接 提取码：xxx」。</p>

      <div v-if="rows.length" class="nd-rows">
        <div v-for="(r, i) in rows" :key="i" class="nd-row">
          <el-select v-model="r.provider" class="nd-provider" placeholder="服务商">
            <el-option v-for="[k, l] in providerOptions" :key="k" :label="l" :value="k" />
          </el-select>
          <el-input v-model="r.url" class="nd-url" placeholder="分享链接 https://…" clearable />
          <el-input v-model="r.code" class="nd-code" placeholder="提取码" clearable maxlength="16" />
          <el-input v-model="r.note" class="nd-note" placeholder="备注（选填）" clearable maxlength="40" />
          <el-button size="small" class="nd-copy" @click="onCopy(r)">复制</el-button>
          <el-button size="small" text class="nd-del" @click="removeRow(i)">删除</el-button>
        </div>
      </div>
      <el-empty v-else description="还没有网盘链接" :image-size="60" />

      <el-button text class="nd-add" @click="addRow">＋ 添加一条</el-button>
    </div>

    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="onSave">保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.nd-body {
  min-height: 120px;
}
.nd-tip {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-bottom: 12px;
}
.nd-rows {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.nd-row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.nd-provider {
  width: 118px;
  flex: none;
}
.nd-url {
  flex: 1 1 240px;
  min-width: 180px;
}
.nd-code {
  width: 96px;
  flex: none;
}
.nd-note {
  width: 132px;
  flex: none;
}
.nd-copy {
  flex: none;
}
.nd-del {
  color: var(--el-color-danger);
  flex: none;
}
.nd-add {
  margin-top: 12px;
  color: var(--bk-teal, var(--el-color-primary));
  font-weight: 600;
}
</style>
