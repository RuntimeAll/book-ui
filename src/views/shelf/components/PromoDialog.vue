<script setup lang="ts">
/**
 * PromoDialog — 书的宣发文案（所有书型通用）。
 *
 * 存发小红书/朋友圈的现成话术：标题 + 描述，跟着书走不散落。
 * 数据在 biz_shelf_book.style_meta_json.promo；分页行通常已带 styleMeta.promo，
 * 行里没有时打开弹窗现 GET 书详情拉全量（同 NetdiskDialog 范式）。
 *
 * 「复制全文」= 一键拿到「标题 + 空行 + 描述」，直接粘进小红书发布框。
 */
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { getBook, saveBookPromo, readBookPromo, type BookPromo, type ShelfBookVO } from '@/api/shelf'

const props = defineProps<{ visible: boolean; book: ShelfBookVO | null }>()
const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  /** 保存成功：把最新文案回抛给书架页，就地更新卡片小标不整页重拉 */
  (e: 'saved', payload: { bookId: string; promo: BookPromo | null }): void
}>()

const dialogVisible = computed({
  get: () => props.visible,
  set: (v: boolean) => emit('update:visible', v),
})

const title = ref('')
const desc = ref('')
const loading = ref(false)
const saving = ref(false)

function fill(p?: BookPromo) {
  title.value = p?.title ?? ''
  desc.value = p?.desc ?? ''
}

/** 打开时装载：行里有 promo 直接用；没有 → GET 书详情拉全量。 */
async function loadPromo() {
  const b = props.book
  fill(undefined)
  if (!b) return
  const inline = readBookPromo(b)
  if (inline) {
    fill(inline)
    return
  }
  loading.value = true
  try {
    fill(readBookPromo(await getBook(b.id)))
  } catch (e) {
    console.warn('[shelf][promo] 拉书详情失败:', e)
  } finally {
    loading.value = false
  }
}

watch(
  () => props.visible,
  (open) => {
    if (open) void loadPromo()
  },
)

const fullText = computed(() => [title.value.trim(), desc.value.trim()].filter(Boolean).join('\n\n'))

async function onCopy() {
  const text = fullText.value
  if (!text) {
    ElMessage.warning('还没有文案可复制')
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
  const payload: BookPromo = { title: title.value.trim(), desc: desc.value.trim() }
  saving.value = true
  try {
    const res = await saveBookPromo(b.id, payload)
    const latest = res?.promo ?? (payload.title || payload.desc ? payload : null)
    ElMessage.success(latest ? '宣发文案已保存' : '已清空宣发文案')
    emit('saved', { bookId: b.id, promo: latest })
    dialogVisible.value = false
  } catch (e) {
    console.warn('[shelf][promo] 保存失败:', e)
    // 错误 toast 由 http 拦截器统一弹，这里不重复
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <el-dialog
    v-model="dialogVisible"
    :title="book ? `宣发文案 · ${book.title}` : '宣发文案'"
    width="720px"
    style="max-width: 94vw"
    :close-on-click-modal="false"
  >
    <div v-loading="loading" class="pm-body">
      <p class="pm-tip">存这本书发小红书/朋友圈的现成话术；「复制全文」直接得到「标题 + 描述」可粘贴文本。</p>

      <div class="pm-field">
        <label class="pm-label">标题</label>
        <el-input v-model="title" placeholder="如：📐七上实数计算每日打卡｜10天200题" clearable maxlength="100" show-word-limit />
      </div>

      <div class="pm-field">
        <label class="pm-label">描述</label>
        <el-input
          v-model="desc"
          type="textarea"
          :rows="10"
          placeholder="正文话术（可多行，含 emoji / 标签）"
          maxlength="3000"
          show-word-limit
          resize="vertical"
        />
      </div>
    </div>

    <template #footer>
      <el-button class="pm-copy" @click="onCopy">复制全文</el-button>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="onSave">保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.pm-body {
  min-height: 120px;
}
.pm-tip {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-bottom: 12px;
}
.pm-field + .pm-field {
  margin-top: 14px;
}
.pm-label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 6px;
  color: var(--el-text-color-regular);
}
.pm-copy {
  float: left;
}
</style>
