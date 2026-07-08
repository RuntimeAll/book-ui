<script setup lang="ts">
/**
 * PRD-B-101 D7 兜底 · 把一张已有卷挂到某课次卷位（卷库侧入口）。
 * 选计划 → 课次 → 空卷位 → bindPaperSlot(lessonId, slotSeq, paperId)。
 * 继承计划模板的课次先物化自有卷位（upsertLessons）再绑，否则绑定端点定位不到卷位。
 */
import { ref, watch, computed } from 'vue'
import { ElMessage } from 'element-plus'
import {
  pagePlans,
  getPlan,
  upsertLessons,
  bindPaperSlot,
  type PlanVO,
  type PlanLessonVO,
  type PaperSlot,
} from '@/api/teacher/schedule'

const props = defineProps<{
  modelValue: boolean
  paperId: string
  paperName?: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'attached'): void
}>()

const plans = ref<PlanVO[]>([])
const plansLoading = ref(false)
const planId = ref('')
const planDetail = ref<PlanVO | null>(null)
const detailLoading = ref(false)
const lessonId = ref('')
const binding = ref(false)

async function loadPlans() {
  plansLoading.value = true
  try {
    const res = await pagePlans({ pageNum: 1, pageSize: 200 })
    plans.value = res?.rows ?? []
  } catch {
    plans.value = []
  } finally {
    plansLoading.value = false
  }
}

async function onPlanChange(id: string) {
  lessonId.value = ''
  planDetail.value = null
  if (!id) return
  detailLoading.value = true
  try {
    planDetail.value = await getPlan(id)
  } catch {
    planDetail.value = null
  } finally {
    detailLoading.value = false
  }
}

const lessons = computed<PlanLessonVO[]>(() =>
  [...(planDetail.value?.lessons ?? [])].sort((a, b) => (a.lessonSeq ?? 0) - (b.lessonSeq ?? 0)),
)
const currentLesson = computed<PlanLessonVO | null>(
  () => lessons.value.find((l) => l.id === lessonId.value) ?? null,
)
const slots = computed<PaperSlot[]>(() => currentLesson.value?.paperSlots ?? [])

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      planId.value = ''
      planDetail.value = null
      lessonId.value = ''
      void loadPlans()
    }
  },
)

async function bindTo(slot: PaperSlot) {
  const lesson = currentLesson.value
  if (!lesson) return
  binding.value = true
  try {
    // 继承模板课次先物化自有卷位
    if (lesson.paperSlotsInherited) {
      await upsertLessons(planId.value, [
        {
          id: lesson.id,
          title: lesson.title,
          lessonSeq: lesson.lessonSeq,
          lessonType: lesson.lessonType,
          tag: lesson.tag,
          sourceRef: lesson.sourceRef,
          thinkingAction: lesson.thinkingAction,
          layerTarget: lesson.layerTarget,
          parentCopy: lesson.parentCopy,
          kgNodeIds: lesson.kgNodeIds,
          paperSlots: (lesson.paperSlots ?? []).map((s) => ({ ...s })),
        },
      ])
    }
    await bindPaperSlot(lesson.id, slot.slot_seq, props.paperId)
    ElMessage.success(`已挂到「${lesson.title} · ${slot.name}」`)
    emit('attached')
    emit('update:modelValue', false)
  } catch {
    /* 拦截器已弹错 */
  } finally {
    binding.value = false
  }
}

function close() {
  emit('update:modelValue', false)
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="挂到课次卷位"
    width="560px"
    append-to-body
    :close-on-click-modal="false"
    @update:model-value="close"
  >
    <p v-if="paperName" class="at-paper">卷：<b>{{ paperName }}</b></p>
    <div class="at-form">
      <el-select
        v-model="planId"
        placeholder="选课程计划"
        filterable
        :loading="plansLoading"
        style="width: 100%"
        @change="onPlanChange"
      >
        <el-option v-for="p in plans" :key="p.id" :value="p.id" :label="p.name" />
      </el-select>
      <el-select
        v-if="planId"
        v-model="lessonId"
        placeholder="选课次"
        filterable
        :loading="detailLoading"
        style="width: 100%"
      >
        <el-option
          v-for="l in lessons"
          :key="l.id"
          :value="l.id"
          :label="`第${l.lessonSeq}次 · ${l.title}`"
        />
      </el-select>
    </div>

    <div v-if="currentLesson" class="at-slots">
      <div v-if="slots.length" class="at-slot-list">
        <div v-for="slot in slots" :key="slot.slot_seq" class="at-slot">
          <div class="at-slot-info">
            <b>{{ slot.name }}</b>
            <span v-if="slot.paper_id" class="at-bound">已绑（挂新卷会覆盖）</span>
            <span v-else class="at-free">空位</span>
          </div>
          <el-button size="small" type="primary" :loading="binding" @click="bindTo(slot)">挂这位</el-button>
        </div>
      </div>
      <el-empty v-else description="该课次还没有卷位，先去课程计划页加卷位" :image-size="60" />
    </div>

    <template #footer>
      <el-button @click="close">取消</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.at-paper { font-size: 13px; color: #5f716d; margin: 0 0 10px; }
.at-paper b { color: var(--bk-ink); }
.at-form { display: flex; flex-direction: column; gap: 10px; }
.at-slots { margin-top: 14px; }
.at-slot-list { display: flex; flex-direction: column; gap: 6px; }
.at-slot { display: flex; align-items: center; gap: 10px; padding: 8px 4px; border-top: 1px solid #eef3f1; }
.at-slot:first-child { border-top: none; }
.at-slot-info { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; }
.at-slot-info b { font-size: 13px; color: var(--bk-ink); }
.at-bound { font-size: 11px; color: #b45309; }
.at-free { font-size: 11px; color: var(--bk-teal-deep); }
</style>
