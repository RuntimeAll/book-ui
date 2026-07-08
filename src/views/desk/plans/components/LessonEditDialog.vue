<script setup lang="ts">
/**
 * PRD-C-213 FP17/FP18/FP19 — 课次编辑弹窗（新增 / 编辑单课次）。
 * 字段：标题 / 课次类型 / 吃透课等标签 / 素材源 / 思维动作 / 层数目标 / 家长版口语文案(parent_copy)
 *      / KG 锚点(kg_node_ids 多选) / 三段式 seg_template（空则继承计划默认）。
 * 大纲态课次（无题目 / 只定主题）完全合法，除标题外均可空，不逼填。
 * 保存走 upsertLessons（id 空=新增）。契约：批0 §三 POST plan/{id}/lessons。
 */
import { ref, reactive, watch, computed } from 'vue'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import {
  upsertLessons,
  LESSON_TYPE_LABEL,
  type PlanLessonVO,
  type PlanLessonBo,
  type LessonType,
  type PaperSlot,
} from '@/api/teacher/schedule'
import type { SubjectNode } from '@/api/question/index'
import PaperSlotsEditor from './PaperSlotsEditor.vue'
import KgAnchorSelect from './KgAnchorSelect.vue'

const props = defineProps<{
  modelValue: boolean
  planId: string
  /** null = 新增课次；非空 = 编辑该课次 */
  lesson: PlanLessonVO | null
  /** 计划默认卷位模板（新增课次时 seed） */
  defaultPaperSlots?: PaperSlot[]
  /** KG 章节树（父页统一加载注入） */
  kgTree?: SubjectNode[]
  kgLoading?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'saved'): void
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})

const isEdit = computed(() => !!props.lesson)
const title = computed(() => (isEdit.value ? '编辑课次' : '添加课次'))

const formRef = ref<FormInstance>()
const submitting = ref(false)

interface FormState {
  title: string
  lessonType: LessonType
  tag: string
  sourceRef: string
  thinkingAction: string
  layerTarget: string
  parentCopy: string
  kgNodeIds: string[]
  paperSlots: PaperSlot[]
}

const form = reactive<FormState>({
  title: '',
  lessonType: '0',
  tag: '',
  sourceRef: '',
  thinkingAction: '',
  layerTarget: '',
  parentCopy: '',
  kgNodeIds: [],
  paperSlots: [],
})

const rules: FormRules<FormState> = {
  title: [{ required: true, message: '请填写课次标题', trigger: 'blur' }],
}

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    formRef.value?.clearValidate()
    const l = props.lesson
    if (l) {
      form.title = l.title
      form.lessonType = l.lessonType || '0'
      form.tag = l.tag || ''
      form.sourceRef = l.sourceRef || ''
      form.thinkingAction = l.thinkingAction || ''
      form.layerTarget = l.layerTarget || ''
      form.parentCopy = l.parentCopy || ''
      form.kgNodeIds = (l.kgNodeIds || []).map(String)
      // 编辑态：课次自有卷位为准；若继承计划模板（inherited）则以模板 seed（编辑保存即物化为自有）
      form.paperSlots = (l.paperSlots || []).map((s) => ({ ...s }))
    } else {
      form.title = ''
      form.lessonType = '0'
      form.tag = ''
      form.sourceRef = ''
      form.thinkingAction = ''
      form.layerTarget = ''
      form.parentCopy = ''
      form.kgNodeIds = []
      // 新增课次继承计划默认卷位模板
      form.paperSlots = (props.defaultPaperSlots || []).map((s) => ({ ...s }))
    }
  },
)

async function submit() {
  const ok = await formRef.value?.validate().catch(() => false)
  if (!ok) return
  const bo: PlanLessonBo = {
    id: props.lesson?.id,
    title: form.title.trim(),
    lessonType: form.lessonType,
    tag: form.tag.trim() || undefined,
    sourceRef: form.sourceRef.trim() || undefined,
    thinkingAction: form.thinkingAction.trim() || undefined,
    layerTarget: form.layerTarget.trim() || undefined,
    parentCopy: form.parentCopy.trim() || undefined,
    kgNodeIds: form.kgNodeIds.length ? form.kgNodeIds : undefined,
    paperSlots: form.paperSlots.length ? form.paperSlots : undefined,
  }
  // 编辑态保留原 lessonSeq，新增态不传由服务端追加
  if (props.lesson) bo.lessonSeq = props.lesson.lessonSeq
  submitting.value = true
  try {
    await upsertLessons(props.planId, [bo])
    ElMessage.success(isEdit.value ? '课次已保存' : '课次已添加')
    emit('saved')
    visible.value = false
  } catch {
    // 拦截器已弹错误
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-dialog v-model="visible" :title="title" width="680px" append-to-body :close-on-click-modal="false">
    <el-form ref="formRef" :model="form" :rules="rules" label-width="92px">
      <el-form-item label="课次标题" prop="title">
        <el-input v-model="form.title" maxlength="100" placeholder="如：第1次 · 统筹与最值" />
      </el-form-item>

      <div class="row-2">
        <el-form-item label="课次类型">
          <el-radio-group v-model="form.lessonType">
            <el-radio-button value="0">{{ LESSON_TYPE_LABEL['0'] }}</el-radio-button>
            <el-radio-button value="1">🧪 {{ LESSON_TYPE_LABEL['1'] }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="标签">
          <el-input v-model="form.tag" maxlength="50" placeholder="如：吃透课（可空）" />
        </el-form-item>
      </div>

      <el-form-item label="素材源">
        <el-input v-model="form.sourceRef" maxlength="200" placeholder="如：书第 10+11 周合并挑核心" />
      </el-form-item>

      <div class="row-2">
        <el-form-item label="思维动作">
          <el-input v-model="form.thinkingAction" maxlength="100" placeholder="如：全局比较 + 极端思考" />
        </el-form-item>
        <el-form-item label="层数目标">
          <el-input v-model="form.layerTarget" maxlength="20" placeholder="如：2→3" />
        </el-form-item>
      </div>

      <el-form-item label="课内锚点">
        <KgAnchorSelect v-model="form.kgNodeIds" :data="kgTree" :loading="kgLoading" />
      </el-form-item>

      <el-form-item label="家长版文案">
        <el-input
          v-model="form.parentCopy"
          type="textarea"
          :rows="2"
          maxlength="200"
          show-word-limit
          placeholder="口语化描述，导家长版课表时用（如：怎么安排最省时间、拿到最多最少）"
        />
      </el-form-item>

      <el-form-item label="专项卷位">
        <div class="seg-wrap">
          <div class="seg-tip">留空则继承计划默认卷位模板；此处配置覆盖计划默认（绑定字段不在此编辑，绑卷走课次行）</div>
          <PaperSlotsEditor v-model="form.paperSlots" />
        </div>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="submit">保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.row-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 16px;
}
@media (max-width: 720px) {
  .row-2 { grid-template-columns: 1fr; }
}
.seg-wrap {
  width: 100%;
}
.seg-tip {
  font-size: 12px;
  color: #8ba09a;
  margin-bottom: 8px;
}
</style>
