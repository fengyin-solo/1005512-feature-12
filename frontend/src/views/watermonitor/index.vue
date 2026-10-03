<template>
  <section class="page" data-module="watermonitor">
    <header class="page-head">
      <div>
        <h2>工艺用水监测管理</h2>
        <p class="page-desc">水系统按类别分线取样，检验人每周轮换、取样日期与班次对齐；可按水系统类别与取样日期导出外发监测分册。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记取样记录</button>
        <button class="btn" type="button" @click="openExport">导出月报分册</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item">检验人周轮换：{{ roster.join(' → ') }}</span>
    </p>

    <ul class="line-legend">
      <li v-for="line in lines" :key="line.category">
        <strong>{{ line.category }}</strong>（{{ line.grade }}）：取样日
        {{ line.schedule.map((slot) => `${weekdayLabels[slot.weekday - 1]}·${slot.shift.replace(/ .*$/, '')}`).join('、') }}
        ；限值 {{ standardText(line) }}
      </li>
    </ul>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>水系统类别</span>
        <select v-model="filters['水系统类别']">
          <option value="">全部类别</option>
          <option v-for="category in categories" :key="category" :value="category">{{ category }}</option>
        </select>
      </label>
      <label class="filter-item">
        <span>取样日期</span>
        <input v-model="filters['取样日期']" placeholder="YYYY-MM-DD" />
      </label>
      <label class="filter-item">
        <span>取样点</span>
        <input v-model="filters['取样点']" placeholder="按取样点检索" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>外发</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-abnormal': row.abnormal }">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            {{ row.status }}
            <div v-if="row['打回原因']" class="hint error-text">{{ row['打回原因'] }}</div>
          </td>
          <td>
            <span v-if="ledgerMap.get(String(row.id))" class="state-badge good">
              已外发 ×{{ ledgerMap.get(String(row.id))?.exportCount }}
            </span>
            <span v-else class="state-badge muted">未外发</span>
          </td>
          <td class="row-actions">
            <template v-for="action in rowActions(row)" :key="action">
              <button v-if="action !== '填报微生物限度'" class="link" type="button" @click="runAction(action, row)">
                {{ action }}
              </button>
              <button v-else class="link" type="button" @click="openMicrobial(row)">填报微生物限度</button>
            </template>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无符合条件的工艺用水监测记录，可先登记取样记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条水质监测记录（历史电导率按原样保留，不做迁移）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="successMessage" class="success-text">{{ successMessage }}</span>
    </footer>

    <!-- 登记取样记录 -->
    <div v-if="createOpen" class="modal-mask" @click.self="createOpen = false">
      <div class="modal">
        <h3>登记水系统取样记录</h3>
        <p class="modal-tip">水系统按类别分线取样，检验人按周轮换、取样日期须与该线班次对齐，由系统自动核对。</p>
        <div class="form-grid">
          <label class="field">
            <span>水系统类别 *</span>
            <select v-model="createForm.category" @change="onCategoryChange">
              <option value="">请选择类别</option>
              <option v-for="category in categories" :key="category" :value="category">{{ category }}</option>
            </select>
          </label>
          <label class="field">
            <span>取样点 *</span>
            <select v-model="createForm.point" :disabled="!createForm.category">
              <option value="">请选择取样点</option>
              <option v-for="point in pointOptions" :key="point" :value="point">{{ point }}</option>
            </select>
          </label>
          <label class="field">
            <span>取样日期 *</span>
            <input v-model="createForm.sampleDate" placeholder="YYYY-MM-DD" />
          </label>
          <div class="field readonly">
            <span>当周检验人 / 班次</span>
            <strong>{{ scheduleHint }}</strong>
          </div>
          <label class="field">
            <span>电导率</span>
            <input v-model="createForm.conductivity" placeholder="如 1.8 μS/cm" />
          </label>
          <label class="field">
            <span>总有机碳</span>
            <input v-model="createForm.toc" placeholder="如 0.32 mg/L" />
          </label>
          <div class="field readonly wide">
            <span>微生物样品编号（各入口同一份）</span>
            <strong>{{ microbialNoPreview }}</strong>
          </div>
        </div>
        <p v-if="createError" class="error-text">{{ createError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="createOpen = false">取消</button>
          <button class="btn primary" type="button" @click="submitCreate">提交登记</button>
        </div>
      </div>
    </div>

    <!-- 填报微生物限度 -->
    <div v-if="microbialOpen" class="modal-mask" @click.self="microbialOpen = false">
      <div class="modal">
        <h3>填报微生物限度</h3>
        <p class="modal-tip">
          微生物样品编号 <strong>{{ microbialForm.sampleNo }}</strong>：各取样入口取回来的属同一份，
          结果会写回本样品全部入口；超过限度将整份打回「待取样」重填。
        </p>
        <div class="form-grid">
          <label class="field wide">
            <span>微生物限度结果（限度 {{ microbialForm.limit }}）</span>
            <input v-model="microbialForm.value" :placeholder="`如 5 ${microbialForm.unit}，未检出填 0 或 未检出`" />
          </label>
        </div>
        <p v-if="microbialError" class="error-text">{{ microbialError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="microbialOpen = false">取消</button>
          <button class="btn primary" type="button" @click="submitMicrobial">确认填报</button>
        </div>
      </div>
    </div>

    <!-- 月报分册导出 -->
    <div v-if="exportOpen" class="modal-mask wide" @click.self="exportOpen = false">
      <div class="modal">
        <h3>导出水系统监测月报分册</h3>
        <div class="filter-bar">
          <label class="filter-item">
            <span>报告周期</span>
            <input v-model="exportPeriod" placeholder="YYYY-MM" />
          </label>
          <button class="btn" type="button" @click="previewReport">预览分册</button>
          <button class="btn primary" type="button" @click="exportCombined">导出合订（外发 HTML）</button>
        </div>

        <p v-if="exportError" class="error-text">{{ exportError }}</p>

        <table v-if="reportModel" class="data-table report-table">
          <thead>
            <tr><th>册名（水系统类别 + 取样日期）</th><th>取样点</th><th>结论</th><th>外发台账</th><th>操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="group in reportModel.groups" :key="group.category + group.sampleDate">
              <td>水系统监测分册-《{{ group.category }}》-{{ group.sampleDate }}</td>
              <td>
                <span v-for="record in group.records" :key="String(record.id)" class="point-chip">
                  {{ record['取样点'] }}
                </span>
              </td>
              <td>{{ groupConclusionText(group) }}</td>
              <td>{{ ledgerSummary(group) }}</td>
              <td>
                <button class="link" type="button" @click="downloadFascicle(group)">下载本分册</button>
              </td>
            </tr>
            <tr v-for="item in reportModel.emptyCategories" :key="item.category" class="empty-row">
              <td>水系统监测分册-《{{ item.category }}》-{{ exportPeriod }}（当期无取样）</td>
              <td colspan="2">
                当期无取样记录，附说明页（非空壳）；最近排期 {{ item.next.date }} {{ item.next.weekday }}
                {{ item.next.shift }}，检验人 {{ item.next.inspector }}
              </td>
              <td>—</td>
              <td>
                <button class="link" type="button" @click="downloadEmpty(item.category)">下载说明页</button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="modal-tip">选择周期后点击「预览分册」，按水系统类别 × 取样日期组册；某类别当期无记录时自动补说明页。</p>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadHtmlFile,
  exportWaterEmptyPage,
  exportWaterFascicle,
  exportWaterReport,
  buildWaterReport,
  fillMicrobialResult,
  registerWaterEntry,
  type FascicleGroup,
  type WaterReportModel,
} from '@/api/water-service'
import { filterRows, moduleMeta, runAction as applyAction } from '@/api/local-service'
import { listRows, listWaterLedger } from '@/data/local-store'
import {
  INSPECTOR_ROSTER,
  WATER_CATEGORIES,
  WATER_LINES,
  WEEKDAY_LABELS,
  inspectorOf,
  isoWeekInfo,
  microbialSampleNo,
  scheduledSlot,
  waterLine,
  type WaterLine,
} from '@/data/water-lines'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('watermonitor')
const columns = meta.fields
const categories = WATER_CATEGORIES
const lines = WATER_LINES
const roster = INSPECTOR_ROSTER
const weekdayLabels = WEEKDAY_LABELS

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const successMessage = ref('')
const filters = ref<Record<string, string>>({
  水系统类别: '',
  取样日期: '',
  取样点: '',
})
const statuses = ['待取样', '检测中', '已合格', '不合格']

function currentPeriod(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: allRecords.value.filter((row) => String(row.status) === status).length,
  })),
)

const allRecords = ref<EntryRow[]>([])

const stats = computed(() => {
  const period = currentPeriod()
  return [
    { label: '待取样点位', value: allRecords.value.filter((row) => row.status === '待取样').length },
    { label: '检测中样品', value: allRecords.value.filter((row) => row.status === '检测中').length },
    { label: '不合格点位数', value: allRecords.value.filter((row) => row.status === '不合格').length },
    {
      label: `${period} 监测点位数`,
      value: allRecords.value.filter((row) => String(row['取样日期'] ?? '').startsWith(period)).length,
    },
  ]
})

const ledgerMap = computed(() => new Map(listWaterLedger().map((entry) => [String(entry.recordId), entry])))

function standardText(line: WaterLine): string {
  const s = line.standard
  return [
    s.conductivityMax === null ? '电导率按国标' : `电导率≤${s.conductivityMax}μS/cm`,
    s.tocMax === null ? 'TOC不考核' : `TOC≤${s.tocMax}mg/L`,
    `微生物≤${s.microbialMax}${s.microbialUnit}`,
  ].join('，')
}

function rowActions(row: EntryRow): string[] {
  switch (String(row.status)) {
    case '待取样':
      return ['提交检测']
    case '检测中':
      return ['填报微生物限度', '判定合格', '标记不合格']
    default:
      return []
  }
}

function flash(ok: boolean, message: string) {
  errorMessage.value = ok ? '' : message
  successMessage.value = ok ? message : ''
}

function resetFilters() {
  filters.value = { 水系统类别: '', 取样日期: '', 取样点: '' }
  reload()
}

function runAction(action: string, row: EntryRow) {
  const result = applyAction(meta.key, Number(row.id), action)
  flash(result.ok, result.message)
  reload()
}

function reload() {
  try {
    allRecords.value = listRows(meta.key)
    const active = Object.fromEntries(Object.entries(filters.value).filter(([, value]) => value.trim() !== ''))
    rows.value = filterRows(allRecords.value, active)
    total.value = rows.value.length
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '工艺用水监测列表读取失败'
  }
}

// —— 登记弹窗 ——
const createOpen = ref(false)
const createError = ref('')
const createForm = ref({ category: '', point: '', sampleDate: '', conductivity: '', toc: '' })

const pointOptions = computed(() => (createForm.value.category ? waterLine(createForm.value.category).points : []))

const scheduleHint = computed(() => {
  const { category, sampleDate } = createForm.value
  if (!category || !/^\d{4}-\d{2}-\d{2}$/.test(sampleDate)) {
    return '选择类别与日期后显示'
  }
  const slot = scheduledSlot(category, sampleDate)
  if (!slot) {
    return '该日期不在分线排期内，不能取样'
  }
  const info = isoWeekInfo(sampleDate)
  return `${inspectorOf(sampleDate)}（${info.year}年第${info.week}周） · ${slot.shift}`
})

const microbialNoPreview = computed(() => {
  const { category, sampleDate } = createForm.value
  if (!category || !/^\d{4}-\d{2}-\d{2}$/.test(sampleDate)) {
    return '选择类别与日期后生成'
  }
  return microbialSampleNo(category, sampleDate)
})

function openCreate() {
  createForm.value = { category: '', point: '', sampleDate: '', conductivity: '', toc: '' }
  createError.value = ''
  createOpen.value = true
}

function onCategoryChange() {
  createForm.value.point = ''
}

function submitCreate() {
  const result = registerWaterEntry({ ...createForm.value })
  if (!result.ok) {
    createError.value = result.message
    return
  }
  createOpen.value = false
  flash(true, result.message)
  reload()
}

// —— 微生物填报弹窗 ——
const microbialOpen = ref(false)
const microbialError = ref('')
const microbialForm = ref({ id: 0, sampleNo: '', value: '', unit: '', limit: '' })

function openMicrobial(row: EntryRow) {
  const line = waterLine(String(row['水系统类别']))
  microbialForm.value = {
    id: Number(row.id),
    sampleNo: String(row['微生物样品编号'] ?? ''),
    value: '',
    unit: line.standard.microbialUnit,
    limit: `≤${line.standard.microbialMax} ${line.standard.microbialUnit}`,
  }
  microbialError.value = ''
  microbialOpen.value = true
}

function submitMicrobial() {
  const result = fillMicrobialResult(microbialForm.value.id, microbialForm.value.value)
  if (!result.ok) {
    microbialError.value = result.message
    microbialOpen.value = false
    flash(false, result.message)
    reload()
    return
  }
  microbialOpen.value = false
  flash(true, result.message)
  reload()
}

// —— 月报分册导出 ——
const exportOpen = ref(false)
const exportPeriod = ref(currentPeriod())
const exportError = ref('')
const reportModel = ref<WaterReportModel | null>(null)

function openExport() {
  exportError.value = ''
  exportOpen.value = true
  previewReport()
}

function previewReport() {
  try {
    reportModel.value = buildWaterReport(exportPeriod.value.trim())
    exportError.value = ''
    reload()
  } catch (error) {
    reportModel.value = null
    exportError.value = error instanceof Error ? error.message : '分册预览失败'
  }
}

function groupConclusionText(group: FascicleGroup): string {
  if (group.records.some((row) => row.status === '不合格')) {
    return '存在不合格（已联动洁净区清单「超标预警」）'
  }
  if (group.records.some((row) => row.pending)) {
    return '检验进行中，结论待定'
  }
  return '全部合格（已联动洁净区清单「已达标」）'
}

function ledgerSummary(group: FascicleGroup): string {
  const sent = group.records.filter((row) => ledgerMap.value.has(String(row.id))).length
  return `${sent}/${group.records.length} 已外发（重复导出不重复计数）`
}

function exportCombined() {
  try {
    const { filename, content } = exportWaterReport(exportPeriod.value.trim())
    downloadHtmlFile(filename, content)
    reportModel.value = buildWaterReport(exportPeriod.value.trim())
    flash(true, `合订已导出：${filename}`)
    reload()
  } catch (error) {
    exportError.value = error instanceof Error ? error.message : '合订导出失败'
  }
}

function downloadFascicle(group: FascicleGroup) {
  const result = exportWaterFascicle(group.category, group.sampleDate)
  if ('ok' in result) {
    exportError.value = result.message
    return
  }
  downloadHtmlFile(result.filename, result.content)
  reportModel.value = buildWaterReport(exportPeriod.value.trim())
  flash(true, `分册已导出：${result.filename}`)
  reload()
}

function downloadEmpty(category: string) {
  const { filename, content } = exportWaterEmptyPage(category, exportPeriod.value.trim())
  downloadHtmlFile(filename, content)
  flash(true, `说明页已导出：${filename}`)
}

onMounted(reload)
</script>
