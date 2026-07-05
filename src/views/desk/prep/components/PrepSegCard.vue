<script setup lang="ts">
/**
 * PRD-C-213 FP23 段容器 —— 段名 / 风格提示语(style) / rules / note 可编辑；
 * 段内题目列表（题干摘要 + 星级 + 来源 + 移除 + 上下移）+「添加题目」+「AI 变式」占位。
 * seg 是父级 reactive segs 数组元素，字段直接双向绑定；改动 emit('dirty') 让父级标脏。
 */
import { computed } from 'vue'
import type { PackSeg } from '@/api/teacher/schedule'
import QuestionContent from '@/components/business/QuestionContent/index.vue'
import { segKClass, segMark, starText, type SegQMeta } from '../helpers'

const props = defineProps<{
  seg: PackSeg
  index: number
  /** id → 题目摘要元信息 */
  qMeta: Map<string, SegQMeta>
  readonly?: boolean
}>()

const emit = defineEmits<{
  dirty: []
  addQuestion: [index: number]
  removeQuestion: [index: number, id: string]
  moveQuestion: [index: number, id: string, dir: -1 | 1]
  aiVariant: [index: number]
}>()

const ids = computed<string[]>(() => props.seg.question_ids ?? [])
function meta(id: string): SegQMeta | undefined {
  return props.qMeta.get(String(id))
}
function markDirty() {
  emit('dirty')
}
</script>

<template>
  <div class="pb-seg">
    <div class="pb-seg-h">
      <span class="t-k" :class="segKClass(index)">{{ segMark(index) }}</span>
      <el-input
        v-model="seg.name"
        size="small"
        placeholder="段名"
        class="seg-name-inp"
        :disabled="readonly"
        @change="markDirty"
      />
      <el-input
        v-model="seg.style"
        size="small"
        placeholder="风格提示语（如：开场 1 道 · 单点突破）"
        class="seg-style-inp"
        :disabled="readonly"
        @change="markDirty"
      />
      <span class="seg-qn">{{ ids.length }} 题</span>
    </div>

    <div class="pb-seg-b">
      <!-- 题目列表 -->
      <div v-if="ids.length === 0" class="seg-empty">尚未装题 · 点下方「添加题目」从题库 / 私有题池挑选</div>
      <div
        v-for="(id, qi) in ids"
        :key="id"
        class="q-item"
      >
        <span v-if="starText(meta(id)?.starLevel)" class="star">{{ starText(meta(id)?.starLevel) }}</span>
        <div class="q-txt">
          <QuestionContent
            :text="meta(id)?.stem"
            :img-url="meta(id)?.stemImg"
            alt="题干"
            img-max-height="60px"
          />
        </div>
        <span v-if="meta(id)?.sourceRef" class="src">{{ meta(id)?.sourceRef }}</span>
        <span v-else class="src src-id">#{{ id }}</span>
        <div v-if="!readonly" class="q-ops">
          <el-button link size="small" :disabled="qi === 0" @click="emit('moveQuestion', index, id, -1)">↑</el-button>
          <el-button link size="small" :disabled="qi === ids.length - 1" @click="emit('moveQuestion', index, id, 1)">↓</el-button>
          <el-button link size="small" type="danger" @click="emit('removeQuestion', index, id)">移除</el-button>
        </div>
      </div>

      <!-- rules / note -->
      <div class="seg-fields">
        <div class="sf-col">
          <label class="sf-label">分层规则 / 口诀（rules，可空）</label>
          <el-input
            v-model="seg.rules"
            type="textarea"
            :rows="2"
            size="small"
            placeholder="如：第一层 ★ 基础 / 第二层 ★★ 进阶 / 第三层 ★★★ 压轴；专项段核心口诀"
            :disabled="readonly"
            @change="markDirty"
          />
        </div>
        <div class="sf-col">
          <label class="sf-label">备注 / 埋坑（note，可空）</label>
          <el-input
            v-model="seg.note"
            type="textarea"
            :rows="2"
            size="small"
            placeholder="如：主题…；埋坑：倍数基准（呼应学生易错信号）"
            :disabled="readonly"
            @change="markDirty"
          />
        </div>
      </div>

      <!-- 动作 -->
      <div v-if="!readonly" class="pb-acts">
        <el-button size="small" type="primary" plain @click="emit('addQuestion', index)">添加题目</el-button>
        <el-button size="small" @click="emit('aiVariant', index)">AI 变式</el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pb-seg { border: 1px solid var(--bk-line); border-radius: 12px; background: #fff; margin-bottom: 14px; overflow: hidden; }
.pb-seg-h {
  display: flex; align-items: center; gap: 10px; padding: 10px 14px;
  border-bottom: 1px solid #eef3f1; background: var(--bk-teal-soft); flex-wrap: wrap;
}
.t-k {
  flex: none; font-size: 12px; font-weight: 700; border-radius: 5px; padding: 0 8px; line-height: 22px; white-space: nowrap;
}
.t-k.w { color: var(--bk-teal-deep); background: #fff; }
.t-k.m { color: #fff; background: var(--bk-teal); }
.t-k.s { color: #5f716d; background: #eef1f0; }
.seg-name-inp { width: 130px; flex: none; }
.seg-style-inp { flex: 1; min-width: 180px; }
.seg-qn { font-size: 11.5px; color: var(--bk-teal-deep); font-weight: 700; flex: none; }

.pb-seg-b { padding: 12px 14px; }
.seg-empty { font-size: 12.5px; color: #8ba09a; padding: 8px 2px 12px; }
.q-item {
  display: flex; gap: 10px; align-items: flex-start; padding: 8px 11px;
  border: 1px solid #eef3f1; border-radius: 8px; margin-bottom: 6px; font-size: 12.5px;
}
.q-item .star { color: #b45309; font-size: 11px; font-weight: 700; flex: none; padding-top: 2px; }
.q-item .q-txt { flex: 1; min-width: 0; }
.q-item .src { font-size: 11px; color: #8ba09a; flex: none; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.q-item .src-id { color: #c3cecb; }
.q-ops { flex: none; display: flex; align-items: center; gap: 2px; }

.seg-fields { display: flex; gap: 16px; margin-top: 10px; flex-wrap: wrap; }
.sf-col { flex: 1; min-width: 220px; display: flex; flex-direction: column; gap: 4px; }
.sf-label { font-size: 11.5px; color: #8ba09a; font-weight: 600; }

.pb-acts { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; align-items: center; }
</style>
