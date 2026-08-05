<script setup lang="ts">
/**
 * PRD-018 M6 · 「我的全部账本」列表（账本视角，桌面）。
 *
 * 学生详情里的「课时账户」只看得到<b>这个学生</b>挂着的账本；改绑之后旧账本就从所有学生页面消失了，
 * 可它上面的冲正退款还在。所以这里按 create_by 列出<b>全部</b>账本 —— 含 `bindingCount === 0`
 * 的零绑定孤本，让它永远查得到、转得走，而不是变成谁都看不到又删不掉的孤儿（M6 ①）。
 *
 * 🔴 D4 规则①：`bindingCount > 1` = 共享账本，行上直接列绑定的学生名（台账行同理显学生名）。
 * 🔴 D4 规则②：共享账本每人每节时长不同 → 基准不唯一，余额<b>只按小时不折节</b>
 *    （`dual()` 传 perLesson=null 即走这条）。
 * 🔴 本组件只负责「列 + 派活」：进台账、发起转移都 emit 给父级 AccountPanel 统一处理，
 *    免得转移表单在两处各写一份、口径各漂各的。
 */
import { ref, watch, computed } from 'vue'
import { listMyAccountBooks, type AccountBookVO } from '@/api/teacher/account'
import { useTuitionUnit } from '@/composables/useTuitionUnit'

const props = defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  /** 点进这本账的台账 */
  (e: 'open-ledger', book: AccountBookVO): void
  /** 从这本账转出（换本 / 拆本） */
  (e: 'transfer', book: AccountBookVO): void
}>()

const { unit, d, fmtNum, fmtMoney } = useTuitionUnit()

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})

const books = ref<AccountBookVO[]>([])
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    books.value = (await listMyAccountBooks()) ?? []
  } catch {
    books.value = []
  } finally {
    loading.value = false
  }
}

watch(
  () => props.modelValue,
  (v) => {
    if (v) void load()
  },
)

/** 零绑定孤本单列一段，正常账本在前 —— 别让退款孤本混在正常账里被误认成还在用的账 */
const activeBooks = computed(() => books.value.filter((b) => b.bindingCount > 0))
const orphanBooks = computed(() => books.value.filter((b) => b.bindingCount === 0))

/** 账本显示名：自定义标签 → 绑定学生名拼接 → 兜底 #id（与 BE accountName 同口径） */
function bookLabel(b: AccountBookVO) {
  if (b.name && b.name.trim()) return b.name.trim()
  const names = (b.studentNames || []).filter(Boolean)
  return names.length ? names.join('+') : `账本 #${b.id}`
}

/** 折节基准：共享本（绑定数>1）与零绑定本都拿不到唯一基准 → 只按小时（D4 规则②） */
function perLessonOf(b: AccountBookVO): number | null {
  if (b.bindingCount !== 1) return null
  return b.hoursPerLesson && b.hoursPerLesson > 0 ? b.hoursPerLesson : null
}

defineExpose({ reload: load })
</script>

<template>
  <el-dialog v-model="visible" title="我的全部账本" width="720px" append-to-body top="6vh">
    <div class="bk-wrap" v-loading="loading">
      <p class="bk-lead">
        一本账一个时薪；几个学生记同一本账就是「共享账本」。
        当前单位：<b>{{ unit === 'j' ? '节' : '小时' }}</b>（在课时账户区右上角切换）
      </p>

      <div v-if="activeBooks.length" class="bk-list">
        <div v-for="b in activeBooks" :key="b.id" class="bk-row" :class="{ off: b.status === '1' }">
          <div class="bk-main">
            <span class="bk-name">{{ bookLabel(b) }}</span>
            <span v-if="b.shared" class="tag shared">共享账本 · {{ b.bindingCount }} 人</span>
            <span v-if="b.status === '1'" class="tag off">已停用</span>
            <span class="bk-bal" :class="{ neg: (b.hoursRemain ?? 0) < 0 }">
              剩余 <b>{{ d(b.hoursRemain, perLessonOf(b)).main }}</b>
              <i v-if="d(b.hoursRemain, perLessonOf(b)).sub">（{{ d(b.hoursRemain, perLessonOf(b)).sub }}）</i>
            </span>
            <span class="bk-cell">约 {{ fmtMoney(b.amountRemain) }}</span>
            <span class="bk-cell">时薪 {{ fmtNum(b.pricePerHour) }} 元/小时</span>
            <span class="bk-acts">
              <el-button size="small" text bg @click="emit('open-ledger', b)">记录</el-button>
              <el-button size="small" text bg @click="emit('transfer', b)">转到其他账本</el-button>
            </span>
          </div>
          <!-- 规则①：绑定数>1 才逐个列学生名（单绑本列出来是噪音） -->
          <div class="bk-meta">
            <template v-if="b.shared">
              <span class="ml">记在这本账上的学生</span>
              <span v-for="n in b.studentNames" :key="n" class="chip">{{ n }}</span>
            </template>
            <template v-else-if="b.bindings.length">
              <span class="ml">
                {{ b.bindings[0].studentName || '—' }} ·
                {{ b.bindings[0].subjectLabel || b.bindings[0].subject }} ·
                每节 {{ fmtNum(b.bindings[0].hoursPerLesson) }} 小时
              </span>
            </template>
          </div>
        </div>
      </div>
      <p v-else-if="!loading" class="bk-empty">还没有账本 —— 在学生详情里「开通学科账户」就会开出第一本。</p>

      <!-- 零绑定孤本：改绑之后没有学生指着它了，但退款/冲正还在上面 -->
      <template v-if="orphanBooks.length">
        <div class="bk-sect">
          <span class="bk-sect-t">没有学生绑定的账本</span>
          <span class="bk-sect-d">改绑后旧本的退款仍查得到 —— 记录不会随改绑消失，余额可以转到别的账本上</span>
        </div>
        <div class="bk-list">
          <div v-for="b in orphanBooks" :key="b.id" class="bk-row orphan">
            <div class="bk-main">
              <span class="bk-name">{{ bookLabel(b) }}</span>
              <span class="tag orphan">零绑定</span>
              <span class="bk-bal" :class="{ neg: (b.hoursRemain ?? 0) < 0 }">
                剩余 <b>{{ fmtNum(b.hoursRemain) }} 小时</b>
              </span>
              <span class="bk-cell">约 {{ fmtMoney(b.amountRemain) }}</span>
              <span class="bk-cell">时薪 {{ fmtNum(b.pricePerHour) }} 元/小时</span>
              <span class="bk-acts">
                <el-button size="small" text bg @click="emit('open-ledger', b)">记录</el-button>
                <el-button size="small" text bg @click="emit('transfer', b)">转到其他账本</el-button>
              </span>
            </div>
          </div>
        </div>
      </template>
    </div>
    <template #footer>
      <el-button @click="visible = false">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.bk-lead {
  font-size: 12.5px;
  color: #8ba09a;
  line-height: 1.6;
  margin-bottom: 10px;
}
.bk-lead b {
  color: var(--bk-teal-deep);
}
.bk-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bk-row {
  border: 1px solid var(--bk-line);
  border-radius: 10px;
  padding: 9px 14px;
  background: #fff;
}
.bk-row.off {
  background: #fafcfb;
  border-style: dashed;
}
/* 零绑定孤本：虚线 + 米底，一眼区分于还在用的账 */
.bk-row.orphan {
  border-style: dashed;
  border-color: #dfd3b8;
  background: #fdfaf2;
}
.bk-main {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}
.bk-name {
  font-size: 14px;
  font-weight: 700;
  color: var(--bk-ink);
}
.bk-bal {
  font-size: 12px;
  color: #8ba09a;
  font-variant-numeric: tabular-nums;
}
.bk-bal b {
  font-size: 15px;
  color: var(--bk-ink);
}
.bk-bal i {
  font-style: normal;
  font-size: 11.5px;
  color: #8ba09a;
}
.bk-bal.neg b,
.bk-bal.neg i {
  color: #be123c;
}
.bk-cell {
  font-size: 12px;
  color: #5f716d;
  font-variant-numeric: tabular-nums;
}
.bk-acts {
  margin-left: auto;
  display: flex;
  gap: 6px;
}
.bk-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 7px;
  padding-top: 7px;
  border-top: 1px dashed var(--bk-line);
  font-size: 11.5px;
  color: #8ba09a;
}
.bk-meta .ml {
  color: #8ba09a;
}
.chip {
  font-size: 11px;
  color: var(--bk-teal-deep);
  background: var(--bk-teal-soft);
  border-radius: 99px;
  padding: 1px 9px;
}
.tag {
  font-size: 10.5px;
  border-radius: 99px;
  padding: 1px 8px;
  flex: none;
}
.tag.shared {
  color: var(--bk-teal-deep);
  background: var(--bk-teal-soft);
}
.tag.off {
  color: #a96f14;
  background: #f9f1dd;
}
.tag.orphan {
  color: #a96f14;
  background: #f6ecd6;
}
.bk-sect {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  margin: 18px 0 9px;
  padding-bottom: 7px;
  border-bottom: 1px solid var(--bk-line);
}
.bk-sect-t {
  font-size: 13px;
  font-weight: 700;
  color: var(--bk-ink);
}
.bk-sect-d {
  font-size: 11.5px;
  color: #8ba09a;
}
.bk-empty {
  font-size: 12.5px;
  color: #8ba09a;
}
</style>
