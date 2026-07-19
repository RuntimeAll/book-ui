<script setup lang="ts">
/**
 * 计算出题（自选出题页）—— 参考「数学计算生成器」交互，底座换成系统出题器。
 * 左·设置栏：题型库（按年级折叠，勾选/题数/形态）→ 组卷篮 → 卷面与样式配置 → 预设/历史。
 * 右·预览区：生成后内嵌 PDF 预览（/oss 同源代理）+ 下载/导图片/新窗口。
 * 题目由 BE 确定性生成（约束内置：进退位/整除/非负/约分），同 seed 复现同一份卷。
 * 🔴 卷面规范（记忆有案）：默认无题号、组标只印「一、二」、口算默认不出答案卷。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  listCalcTypes, exportCalcPaper,
  type CalcTypeInfo, type CalcMode, type CalcExportBo, type CalcExportVo,
} from '@/api/teacher/oralcalc'

// ───────────────────────── 题型库 ─────────────────────────

const GRADE_NAMES = ['', '一年级', '二年级', '三年级', '四年级', '五年级', '六年级']
const MODE_NAMES: Record<CalcMode, string> = { oral: '口算', vertical: '竖式', tuoshi: '脱式' }

interface TypeRow extends CalcTypeInfo {
  checked: boolean
  count: number
  mode: CalcMode
}

const allTypes = ref<TypeRow[]>([])
const typesByGrade = computed(() => {
  const m = new Map<number, TypeRow[]>()
  for (const t of allTypes.value) {
    if (!m.has(t.grade)) m.set(t.grade, [])
    m.get(t.grade)!.push(t)
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0])
})
const openGrades = ref<string[]>(['1'])

async function loadTypes() {
  const list = await listCalcTypes()
  allTypes.value = (list || []).map(t => ({ ...t, checked: false, count: 12, mode: 'oral' as CalcMode }))
}

// ───────────────────────── 组卷篮 ─────────────────────────

interface BasketGroup {
  type: string
  name: string
  count: number
  mode: CalcMode
}

const basket = ref<BasketGroup[]>([])
const basketTotal = computed(() => basket.value.reduce((s, g) => s + g.count, 0))

function addType(t: TypeRow) {
  if (t.count < 1) return
  basket.value.push({ type: t.code, name: t.name, count: t.count, mode: t.mode })
}
function addChecked() {
  const picked = allTypes.value.filter(t => t.checked)
  if (!picked.length) {
    ElMessage.warning('先在题型库里勾选题型')
    return
  }
  picked.forEach(addType)
  ElMessage.success(`已添加 ${picked.length} 组`)
}
function removeGroup(i: number) { basket.value.splice(i, 1) }
function moveGroup(i: number, d: number) {
  const j = i + d
  if (j < 0 || j >= basket.value.length) return
  const arr = basket.value
  ;[arr[i], arr[j]] = [arr[j], arr[i]]
}
function undoLast() {
  if (basket.value.length) basket.value.pop()
}
function clearBasket() { basket.value = [] }

// ───────────────────────── 卷面与样式 ─────────────────────────

const cfg = reactive({
  title: '口算训练',
  seed: '',
  withAnswer: false,           // 🔴 口算默认不出答案卷（2026-07-17 拍板）
  groupLabel: true,            // 组标（卷面只印「一、二」序号）
  numbered: false,             // 🔴 默认无题号（2026-07-18 拍板）
  frame: true,
  footer: '每天 10 分钟 · 又快又准',
  hideTitle: false,
  hideMeta: false,
  metaFields: ['日期', '姓名', '用时', '做对'] as string[],
  colsAuto: true,
  cols: 3,
  fontAuto: true,              // 字号/行高自动填页
  fontSizePt: 16,
  rowHeightMm: 14,
  fontFamily: 'songti' as 'songti' | 'heiti' | 'kaiti' | 'yahei',
  inkColor: '',
  verticalRowMm: 36,
  tuoshiRowMm: 30,
})

const newMetaField = ref('')
function addMetaField() {
  const v = newMetaField.value.trim()
  if (v && !cfg.metaFields.includes(v)) cfg.metaFields.push(v)
  newMetaField.value = ''
}
function removeMetaField(f: string) {
  cfg.metaFields = cfg.metaFields.filter(x => x !== f)
}

function buildBody(): CalcExportBo {
  const layout: NonNullable<CalcExportBo['layout']> = {}
  if (!cfg.colsAuto) layout.cols = cfg.cols
  if (!cfg.fontAuto) {
    layout.fontSizePt = cfg.fontSizePt
    layout.rowHeightMm = cfg.rowHeightMm
  }
  if (cfg.numbered) layout.numbered = true
  if (!cfg.frame) layout.frame = false
  if (cfg.footer !== '每天 10 分钟 · 又快又准') layout.footer = cfg.footer
  if (cfg.hideTitle) layout.hideTitle = true
  if (cfg.hideMeta) layout.hideMeta = true
  const defMeta = ['日期', '姓名', '用时', '做对']
  if (cfg.metaFields.join() !== defMeta.join()) layout.metaFields = [...cfg.metaFields]
  if (cfg.fontFamily !== 'songti') layout.fontFamily = cfg.fontFamily
  if (cfg.inkColor) layout.inkColor = cfg.inkColor
  if (cfg.verticalRowMm !== 36) layout.verticalRowMm = cfg.verticalRowMm
  if (cfg.tuoshiRowMm !== 30) layout.tuoshiRowMm = cfg.tuoshiRowMm
  return {
    title: cfg.title || '口算训练',
    ...(cfg.seed.trim() ? { seed: cfg.seed.trim() } : {}),
    withGroupLabel: cfg.groupLabel,
    papers: cfg.withAnswer ? ['question', 'answer'] : ['question'],
    groups: basket.value.map(g => ({
      type: g.type, count: g.count,
      ...(g.mode !== 'oral' ? { mode: g.mode } : {}),
      label: g.name,   // 只作分组开关；卷面按规范只印「一、二」序号
    })),
    ...(Object.keys(layout).length ? { layout } : {}),
  }
}

// ───────────────────────── 生成与预览 ─────────────────────────

const generating = ref(false)
const result = ref<CalcExportVo | null>(null)
const activePaper = ref<'question' | 'answer'>('question')

/** OSS → /oss 同源代理（桶无 CORS 头；iframe 预览与 pdfjs 取字节都走这条）。 */
function ossProxy(url: string) {
  return url.replace(/^https?:\/\/[^/]*aliyuncs\.com/, '/oss')
}
const previewUrl = computed(() => {
  if (!result.value) return ''
  const u = activePaper.value === 'answer' ? result.value.answerUrl : result.value.questionUrl
  return u ? ossProxy(u) + '#toolbar=0&view=FitH' : ''
})

async function generate() {
  if (!basket.value.length) {
    ElMessage.warning('组卷篮是空的：先从题型库添加题型')
    return
  }
  generating.value = true
  try {
    const body = buildBody()
    const vo = await exportCalcPaper(body)
    result.value = vo
    activePaper.value = 'question'
    pushHistory(body, vo)
    ElMessage.success(`已生成 ${vo.total} 题（seed=${vo.seed}）`)
  } finally {
    generating.value = false
  }
}

function openUrl(u?: string) {
  if (u) window.open(u, '_blank')
}
function openCurrent() {
  if (!result.value) return
  openUrl(activePaper.value === 'answer' ? result.value.answerUrl : result.value.questionUrl)
}

/** 导出图片：pdfjs 渲染每页 → PNG 下载（走 /oss 同源代理取字节）。 */
const exportingImg = ref(false)
async function exportImages() {
  if (!result.value) return
  const u = activePaper.value === 'answer' ? result.value.answerUrl : result.value.questionUrl
  if (!u) return
  exportingImg.value = true
  try {
    const pdfjs = await import('pdfjs-dist')
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url,
    ).toString()
    const doc = await pdfjs.getDocument({ url: ossProxy(u) }).promise
    const stem = (cfg.title || '口算训练') + (activePaper.value === 'answer' ? '-答案卷' : '')
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p)
      const viewport = page.getViewport({ scale: 2 })
      const canvas = document.createElement('canvas')
      canvas.width = viewport.width
      canvas.height = viewport.height
      await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise
      const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/png'))
      if (blob) {
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = doc.numPages > 1 ? `${stem}-${p}.png` : `${stem}.png`
        a.click()
        URL.revokeObjectURL(a.href)
      }
    }
    ElMessage.success(`已导出 ${doc.numPages} 张图片`)
  } catch (e) {
    console.error(e)
    ElMessage.error('导出图片失败，可先下载 PDF')
  } finally {
    exportingImg.value = false
  }
}

// ───────────────────────── 预设与历史（localStorage） ─────────────────────────

const PRESET_KEY = 'calcgen.presets.v1'
const HISTORY_KEY = 'calcgen.history.v1'

interface Preset { name: string; body: CalcExportBo }
interface HistoryItem { time: string; body: CalcExportBo; vo: CalcExportVo }

const presets = ref<Preset[]>(loadLS<Preset[]>(PRESET_KEY, []))
const history = ref<HistoryItem[]>(loadLS<HistoryItem[]>(HISTORY_KEY, []))
const historyOpen = ref(false)

function loadLS<T>(k: string, def: T): T {
  try { return JSON.parse(localStorage.getItem(k) || '') as T } catch { return def }
}
function saveLS(k: string, v: unknown) { localStorage.setItem(k, JSON.stringify(v)) }

async function savePreset() {
  if (!basket.value.length) {
    ElMessage.warning('组卷篮是空的，没有可保存的设置')
    return
  }
  const { value } = await ElMessageBox.prompt('给这套出题设置起个名字（如"好好口算日常"）', '保存预设', {
    inputValue: cfg.title, confirmButtonText: '保存', cancelButtonText: '取消',
  })
  const name = (value || '').trim()
  if (!name) return
  presets.value = [{ name, body: buildBody() }, ...presets.value.filter(p => p.name !== name)].slice(0, 30)
  saveLS(PRESET_KEY, presets.value)
  ElMessage.success(`预设「${name}」已保存`)
}
function applyPreset(p: Preset) {
  restoreBody(p.body)
  ElMessage.success(`已载入预设「${p.name}」`)
}
function deletePreset(p: Preset) {
  presets.value = presets.value.filter(x => x.name !== p.name)
  saveLS(PRESET_KEY, presets.value)
}

function pushHistory(body: CalcExportBo, vo: CalcExportVo) {
  history.value = [{ time: new Date().toLocaleString('zh-CN', { hour12: false }), body, vo },
    ...history.value].slice(0, 20)
  saveLS(HISTORY_KEY, history.value)
}
function applyHistory(h: HistoryItem) {
  restoreBody(h.body)
  result.value = h.vo
  activePaper.value = 'question'
  historyOpen.value = false
}

/** 把一份出卷参数还原回界面状态（预设/历史通用）。 */
function restoreBody(body: CalcExportBo) {
  const nameOf = (code: string) => allTypes.value.find(t => t.code === code)?.name || code
  basket.value = (body.groups || []).map(g => ({
    type: g.type, name: g.label || nameOf(g.type), count: g.count, mode: (g.mode || 'oral') as CalcMode,
  }))
  cfg.title = body.title || '口算训练'
  cfg.seed = body.seed || ''
  cfg.withAnswer = !!body.papers?.includes('answer')
  cfg.groupLabel = body.withGroupLabel !== false
  const l = body.layout || {}
  cfg.numbered = l.numbered === true
  cfg.frame = l.frame !== false
  cfg.footer = l.footer != null ? l.footer : '每天 10 分钟 · 又快又准'
  cfg.hideTitle = l.hideTitle === true
  cfg.hideMeta = l.hideMeta === true
  cfg.metaFields = l.metaFields?.length ? [...l.metaFields] : ['日期', '姓名', '用时', '做对']
  cfg.colsAuto = l.cols == null
  if (l.cols != null) cfg.cols = l.cols
  cfg.fontAuto = l.fontSizePt == null && l.rowHeightMm == null
  if (l.fontSizePt != null) cfg.fontSizePt = l.fontSizePt
  if (l.rowHeightMm != null) cfg.rowHeightMm = l.rowHeightMm
  cfg.fontFamily = l.fontFamily || 'songti'
  cfg.inkColor = l.inkColor || ''
  cfg.verticalRowMm = l.verticalRowMm ?? 36
  cfg.tuoshiRowMm = l.tuoshiRowMm ?? 30
}

async function resetAll() {
  await ElMessageBox.confirm('清空组卷篮并恢复默认配置？', '重置', { type: 'warning' })
  basket.value = []
  restoreBody({ groups: [] })
  result.value = null
  cfg.seed = ''
}

function reuseSeed() {
  if (result.value) {
    cfg.seed = result.value.seed
    ElMessage.success('seed 已填回，同参数再生成即复现同一份卷')
  }
}

onMounted(loadTypes)
</script>

<template>
  <div class="cg-page">
    <!-- ═══ 左·设置栏 ═══ -->
    <aside class="cg-side">
      <!-- 组卷篮 -->
      <section class="cg-card">
        <div class="cg-card-head">
          <span>组卷篮</span>
          <span v-if="basket.length" class="cg-sub">{{ basket.length }} 组 · 共 {{ basketTotal }} 题</span>
          <div class="cg-head-btns">
            <el-button v-if="basket.length" size="small" text @click="undoLast">撤销</el-button>
            <el-button v-if="basket.length" size="small" text type="danger" @click="clearBasket">清空</el-button>
          </div>
        </div>
        <div v-if="!basket.length" class="cg-empty">从下方题型库勾选或点「添加」</div>
        <div v-for="(g, i) in basket" :key="i" class="cg-basket-row">
          <span class="cg-ord">{{ '一二三四五六七八九十'[i] || i + 1 }}、</span>
          <span class="cg-basket-name">{{ g.name }}</span>
          <el-tag v-if="g.mode !== 'oral'" size="small" type="warning">{{ MODE_NAMES[g.mode] }}</el-tag>
          <el-input-number v-model="g.count" :min="1" :max="100" size="small" class="cg-count" />
          <span class="cg-mini-btns">
            <el-button size="small" text :disabled="i === 0" @click="moveGroup(i, -1)">↑</el-button>
            <el-button size="small" text :disabled="i === basket.length - 1" @click="moveGroup(i, 1)">↓</el-button>
            <el-button size="small" text type="danger" @click="removeGroup(i)">✕</el-button>
          </span>
        </div>
        <el-button type="primary" class="cg-gen" size="large" :loading="generating" @click="generate">
          生成试卷{{ basketTotal ? `（${basketTotal} 题）` : '' }}
        </el-button>
      </section>

      <!-- 题型库 -->
      <section class="cg-card">
        <div class="cg-card-head">
          <span>题型库</span>
          <div class="cg-head-btns">
            <el-button size="small" type="primary" plain @click="addChecked">添加选中</el-button>
          </div>
        </div>
        <el-collapse v-model="openGrades">
          <el-collapse-item v-for="[grade, list] in typesByGrade" :key="grade" :name="String(grade)">
            <template #title>
              <b class="cg-grade">{{ GRADE_NAMES[grade] }}</b>
              <span class="cg-sub">{{ list.length }} 类</span>
            </template>
            <div v-for="t in list" :key="t.code" class="cg-type-row">
              <el-checkbox v-model="t.checked" class="cg-type-name">
                {{ t.name }}<span class="cg-term">{{ t.term === 1 ? '上' : '下' }}</span>
              </el-checkbox>
              <el-select v-model="t.mode" size="small" class="cg-mode">
                <el-option label="口算" value="oral" />
                <el-option label="竖式" value="vertical" />
                <el-option label="脱式" value="tuoshi" />
              </el-select>
              <el-input-number v-model="t.count" :min="1" :max="100" size="small" class="cg-count" />
              <el-button size="small" @click="addType(t)">添加</el-button>
            </div>
          </el-collapse-item>
        </el-collapse>
      </section>

      <!-- 卷面设置 -->
      <section class="cg-card">
        <div class="cg-card-head"><span>卷面设置</span></div>
        <div class="cg-form">
          <div class="cg-field"><label>卷名</label><el-input v-model="cfg.title" placeholder="口算训练" /></div>
          <div class="cg-field">
            <label>seed</label>
            <el-input v-model="cfg.seed" placeholder="留空随机；填数字可复现同一份卷" />
          </div>
          <div class="cg-switches">
            <el-checkbox v-model="cfg.withAnswer">附教师答案卷</el-checkbox>
            <el-checkbox v-model="cfg.groupLabel">组标（一、二）</el-checkbox>
            <el-checkbox v-model="cfg.numbered">小题号</el-checkbox>
            <el-checkbox v-model="cfg.frame">卷面边框</el-checkbox>
            <el-checkbox v-model="cfg.hideTitle">隐藏标题</el-checkbox>
            <el-checkbox v-model="cfg.hideMeta">隐藏表头</el-checkbox>
          </div>
          <div v-if="!cfg.hideMeta" class="cg-field">
            <label>表头字段</label>
            <div class="cg-tags">
              <el-tag v-for="f in cfg.metaFields" :key="f" closable size="small" @close="removeMetaField(f)">
                {{ f }}{{ f === '做对' ? '／总题量' : '' }}
              </el-tag>
              <el-input
                v-model="newMetaField" size="small" class="cg-tag-input"
                placeholder="+字段" @keyup.enter="addMetaField" @blur="addMetaField"
              />
            </div>
          </div>
          <div class="cg-field"><label>页脚语</label><el-input v-model="cfg.footer" placeholder="留空不印" /></div>
        </div>
      </section>

      <!-- 样式设置 -->
      <section class="cg-card">
        <div class="cg-card-head"><span>样式设置</span></div>
        <div class="cg-form">
          <div class="cg-field">
            <label>每行题数</label>
            <div class="cg-inline">
              <el-checkbox v-model="cfg.colsAuto">按题型自动</el-checkbox>
              <el-slider v-if="!cfg.colsAuto" v-model="cfg.cols" :min="1" :max="6" show-input :show-input-controls="false" size="small" class="cg-slider" />
            </div>
          </div>
          <div class="cg-field">
            <label>字号 / 行距</label>
            <div class="cg-inline">
              <el-checkbox v-model="cfg.fontAuto">自动填满整页</el-checkbox>
            </div>
            <template v-if="!cfg.fontAuto">
              <div class="cg-inline"><span class="cg-sub">字号(pt)</span>
                <el-slider v-model="cfg.fontSizePt" :min="12" :max="24" show-input :show-input-controls="false" size="small" class="cg-slider" /></div>
              <div class="cg-inline"><span class="cg-sub">行高(mm)</span>
                <el-slider v-model="cfg.rowHeightMm" :min="8" :max="40" show-input :show-input-controls="false" size="small" class="cg-slider" /></div>
            </template>
          </div>
          <div class="cg-field-row">
            <div class="cg-field">
              <label>字体</label>
              <el-select v-model="cfg.fontFamily" size="small">
                <el-option label="宋体" value="songti" />
                <el-option label="黑体" value="heiti" />
                <el-option label="楷体" value="kaiti" />
                <el-option label="微软雅黑" value="yahei" />
              </el-select>
            </div>
            <div class="cg-field">
              <label>字色</label>
              <el-color-picker v-model="cfg.inkColor" size="small" />
            </div>
          </div>
          <div class="cg-field-row">
            <div class="cg-field"><label>竖式留白(mm)</label>
              <el-input-number v-model="cfg.verticalRowMm" :min="20" :max="60" size="small" /></div>
            <div class="cg-field"><label>脱式留白(mm)</label>
              <el-input-number v-model="cfg.tuoshiRowMm" :min="16" :max="60" size="small" /></div>
          </div>
        </div>
      </section>

      <!-- 预设 / 历史 / 重置 -->
      <section class="cg-card">
        <div class="cg-actions">
          <el-button @click="savePreset">保存预设</el-button>
          <el-button @click="historyOpen = true">历史记录</el-button>
          <el-button type="danger" plain @click="resetAll">重置</el-button>
        </div>
        <div v-if="presets.length" class="cg-presets">
          <div v-for="p in presets" :key="p.name" class="cg-preset-row">
            <a class="cg-link" @click="applyPreset(p)">{{ p.name }}</a>
            <span class="cg-sub">{{ p.body.groups.length }} 组</span>
            <el-button size="small" text type="danger" @click="deletePreset(p)">✕</el-button>
          </div>
        </div>
      </section>
    </aside>

    <!-- ═══ 右·预览区 ═══ -->
    <section class="cg-main">
      <div class="cg-toolbar">
        <div class="cg-toolbar-left">
          <b>预览</b>
          <template v-if="result">
            <el-radio-group v-if="result.answerUrl" v-model="activePaper" size="small">
              <el-radio-button value="question">题目卷</el-radio-button>
              <el-radio-button value="answer">答案卷</el-radio-button>
            </el-radio-group>
            <span class="cg-sub">共 {{ result.total }} 题 · seed
              <a class="cg-link" title="填回 seed，可复现同一份卷" @click="reuseSeed">{{ result.seed }}</a>
            </span>
          </template>
        </div>
        <div v-if="result" class="cg-toolbar-right">
          <el-button size="small" @click="openCurrent">新窗口打开</el-button>
          <el-button size="small" :loading="exportingImg" @click="exportImages">导出图片</el-button>
          <el-button size="small" type="primary" @click="openCurrent">下载 PDF</el-button>
        </div>
      </div>
      <div class="cg-preview">
        <iframe v-if="previewUrl" :src="previewUrl" class="cg-frame" title="试卷预览" />
        <div v-else class="cg-placeholder">
          <p>① 左侧题型库按年级勾选题型（可选口算 / 竖式 / 脱式形态）</p>
          <p>② 组卷篮里调顺序与题数 → 点「生成试卷」</p>
          <p>③ 这里出 PDF 预览，可下载打印 / 导出图片</p>
          <p class="cg-sub">题目为程序确定性生成：进退位可控、除法整除、结果非负、自动约分，答案 100% 可靠</p>
        </div>
      </div>
    </section>

    <!-- 历史记录抽屉 -->
    <el-drawer v-model="historyOpen" title="出卷历史（本机最近 20 次）" size="420px">
      <div v-if="!history.length" class="cg-empty">还没有出过卷</div>
      <div v-for="(h, i) in history" :key="i" class="cg-history-row">
        <div class="cg-history-head">
          <b>{{ h.body.title || '口算训练' }}</b>
          <span class="cg-sub">{{ h.time }}</span>
        </div>
        <div class="cg-sub">
          {{ h.body.groups.length }} 组 · {{ h.vo.total }} 题 · seed={{ h.vo.seed }}
        </div>
        <div class="cg-history-btns">
          <el-button size="small" @click="applyHistory(h)">载入参数与预览</el-button>
          <el-button size="small" text @click="openUrl(h.vo.questionUrl)">打开 PDF</el-button>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.cg-page { display: flex; gap: 12px; align-items: stretch; min-height: calc(100vh - 90px); }
.cg-side { width: 420px; flex-shrink: 0; display: flex; flex-direction: column; gap: 10px; }
.cg-card { background: #fff; border: 1px solid var(--bk-line, #e3e8ea); border-radius: 10px; padding: 12px 14px; }
.cg-card-head { display: flex; align-items: center; gap: 8px; font-weight: 700; color: #2c3e46; margin-bottom: 8px; }
.cg-head-btns { margin-left: auto; display: flex; gap: 4px; }
.cg-sub { font-size: 12px; color: #8a979e; font-weight: 400; }
.cg-empty { color: #a5b1b7; font-size: 13px; padding: 8px 2px; }

.cg-basket-row { display: flex; align-items: center; gap: 6px; padding: 4px 0; border-bottom: 1px dashed #eef2f3; }
.cg-ord { color: var(--bk-teal, #1a7f74); font-weight: 700; width: 26px; flex: none; }
.cg-basket-name { flex: 1; min-width: 0; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cg-count { width: 86px; flex: none; }
.cg-mini-btns { display: flex; flex: none; }
.cg-mini-btns .el-button { padding: 4px; }
.cg-gen { width: 100%; margin-top: 10px; }

.cg-grade { font-size: 13px; margin-right: 6px; }
.cg-type-row { display: flex; align-items: center; gap: 6px; padding: 3px 0; }
.cg-type-name { flex: 1; min-width: 0; }
.cg-type-name :deep(.el-checkbox__label) { font-size: 13px; padding-left: 5px; }
.cg-term { font-size: 11px; color: #a5b1b7; margin-left: 2px; }
.cg-mode { width: 74px; flex: none; }

.cg-form { display: flex; flex-direction: column; gap: 10px; }
.cg-field { display: flex; flex-direction: column; gap: 4px; }
.cg-field > label { font-size: 12px; color: #67757c; }
.cg-field-row { display: flex; gap: 16px; }
.cg-field-row .el-select { width: 110px; }
.cg-switches { display: flex; flex-wrap: wrap; gap: 2px 14px; }
.cg-inline { display: flex; align-items: center; gap: 10px; }
.cg-slider { flex: 1; max-width: 240px; }
.cg-tags { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.cg-tag-input { width: 72px; }

.cg-actions { display: flex; gap: 8px; }
.cg-presets { margin-top: 10px; display: flex; flex-direction: column; gap: 4px; }
.cg-preset-row { display: flex; align-items: center; gap: 8px; }
.cg-link { color: var(--bk-teal, #1a7f74); cursor: pointer; }
.cg-link:hover { text-decoration: underline; }

.cg-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.cg-toolbar { background: #fff; border: 1px solid var(--bk-line, #e3e8ea); border-radius: 10px; padding: 10px 14px; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.cg-toolbar-left { display: flex; align-items: center; gap: 12px; }
.cg-toolbar-right { display: flex; gap: 8px; }
.cg-preview { flex: 1; background: #fff; border: 1px solid var(--bk-line, #e3e8ea); border-radius: 10px; overflow: hidden; min-height: 640px; display: flex; }
.cg-frame { width: 100%; height: 100%; border: 0; min-height: 640px; }
.cg-placeholder { margin: auto; text-align: center; color: #67757c; font-size: 14px; line-height: 2.1; }

.cg-history-row { border-bottom: 1px solid #eef2f3; padding: 10px 0; display: flex; flex-direction: column; gap: 4px; }
.cg-history-head { display: flex; justify-content: space-between; align-items: center; }
.cg-history-btns { display: flex; gap: 6px; margin-top: 4px; }
</style>
