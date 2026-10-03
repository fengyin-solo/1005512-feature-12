<template>
  <section class="page" data-module="watermonitor">
    <header class="page-head">
      <div>
        <h2>工艺用水监测管理</h2>
        <p class="page-desc">
          水系统按类别分线取样（纯化水/注射用水/灭菌注射用水/饮用水），检验人按周轮换、取样日期与班次对齐；
          每月按类别分册导出月报，空类别补说明页。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openRegister">登记取样</button>
        <button class="btn" type="button" @click="showExport = true">导出月报分册</button>
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
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>水系统类别</span>
        <select v-model="filters['水系统类别']">
          <option value="">全部</option>
          <option v-for="cat in WATER_CATEGORIES" :key="cat" :value="cat">{{ cat }}</option>
        </select>
      </label>
      <label class="filter-item">
        <span>取样点</span>
        <input v-model="filters['取样点']" placeholder="按取样点检索" />
      </label>
      <label class="filter-item">
        <span>取样月份</span>
        <input v-model="filters['月份']" type="month" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
      <button class="btn ghost" type="button" @click="showLedger = !showLedger">
        {{ showLedger ? '收起导出台账' : '查看导出台账' }}
      </button>
    </form>

    <div v-if="showLedger" class="ledger-box">
      <h4>导出台账（同一条取样记录重复导出只算一次）</h4>
      <table v-if="ledger.length" class="data-table">
        <thead>
          <tr><th>记录编号</th><th>水系统类别</th><th>所属月份</th><th>首次导出时间</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in ledger" :key="`${item.id}-${item.month}`">
            <td>#{{ item.id }}</td>
            <td>{{ item.category }}</td>
            <td>{{ item.month }}</td>
            <td>{{ item.exportedAt }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state">还没有导出记录</p>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th>编号</th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td>#{{ row.id }}</td>
          <td v-for="column in columns" :key="column">{{ row[column] === '' || row[column] === undefined ? '—' : row[column] }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in availableActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="onAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">当前条件下没有水质监测记录，可先登记取样</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条水质监测记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="okMessage" class="ok-text">{{ okMessage }}</span>
    </footer>

    <!-- 登记取样 -->
    <div v-if="registerOpen" class="modal-mask" @click.self="registerOpen = false">
      <div class="modal">
        <h3>登记取样</h3>
        <div class="form-grid">
          <label>
            <span>水系统类别（分线）</span>
            <select v-model="registerForm.category" @change="onCategoryChange">
              <option value="" disabled>请选择水系统类别</option>
              <option v-for="cat in WATER_CATEGORIES" :key="cat" :value="cat">{{ cat }}</option>
            </select>
          </label>
          <label>
            <span>取样点</span>
            <select v-model="registerForm.samplePoint" :disabled="!registerForm.category">
              <option value="" disabled>请选择取样点</option>
              <option v-for="point in activePoints" :key="point" :value="point">{{ point }}</option>
            </select>
          </label>
          <label>
            <span>取样日期（须与班次对齐）</span>
            <input v-model="registerForm.date" type="date" @change="previewAssignment" />
          </label>
          <label>
            <span>班次</span>
            <input :value="activeLine ? `${activeLine.weekdayLabel} ${activeLine.shift}` : '选择类别后显示'" disabled />
          </label>
          <label class="span-2">
            <span>检验人（按周轮换自动派工）</span>
            <input :value="registerPreview || '选定类别与日期后自动带出'" disabled />
          </label>
        </div>
        <p v-if="registerHint" class="error-text">{{ registerHint }}</p>
        <p v-else-if="activeLine" class="hint-text">{{ activeLine.category }}固定{{ activeLine.weekdayLabel }}{{ activeLine.shift }}取样，请选择对应{{ activeLine.weekdayLabel }}的日期。</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="registerOpen = false">取消</button>
          <button class="btn primary" type="button" @click="submitRegister">确认登记</button>
        </div>
      </div>
    </div>

    <!-- 录入结果 -->
    <div v-if="resultTarget" class="modal-mask" @click.self="resultTarget = null">
      <div class="modal">
        <h3>录入检测结果 · #{{ resultTarget.id }} {{ resultTarget['取样点'] }}</h3>
        <div class="form-grid">
          <label>
            <span>电导率 µS/cm（限度 {{ activeLine?.limits.conductivityMax }}）</span>
            <input v-model="resultForm.conductivity" placeholder="如 1.2" />
          </label>
          <label>
            <span>总有机碳 mg/L（限度 {{ activeLine?.limits.tocApplicable ? activeLine.limits.tocMax : '不适用' }}）</span>
            <input v-model="resultForm.toc" :disabled="activeLine?.limits.tocApplicable === false" placeholder="如 0.20" />
          </label>
          <label class="span-2">
            <span>微生物限度 CFU/ml（限度 {{ activeLine?.limits.bioburdenMax }}；各入口同一份）</span>
            <input v-model="resultForm.microbial" placeholder="如 32" />
          </label>
        </div>
        <p class="hint-text">同一水系统类别、同一取样日期各入口取同一份微生物样品，结果将自动一致。</p>
        <p v-if="resultError" class="error-text">{{ resultError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="resultTarget = null">取消</button>
          <button class="btn primary" type="button" @click="submitResults">保存结果</button>
        </div>
      </div>
    </div>

    <!-- 打回重填原因 -->
    <div v-if="rejectTarget" class="modal-mask" @click.self="rejectTarget = null">
      <div class="modal">
        <h3>{{ rejectMicrobial ? '微生物限度越界 · 打回重填' : '不合格记录 · 打回重填' }}</h3>
        <p class="hint-text">
          #{{ rejectTarget.id }} {{ rejectTarget['取样点'] }}
          <template v-if="rejectMicrobial">
            微生物限度「{{ rejectTarget['微生物限度'] }}」超出
            {{ activeLineOf(rejectTarget)?.limits.bioburdenMax }} CFU/ml 内控限，
          </template>
          <template v-else>
            已判定为不合格（电导率/总有机碳越界），
          </template>
          按口径退回待取样并清空检测项重检。
        </p>
        <label class="full-field">
          <span>打回原因</span>
          <textarea v-model="rejectReason" rows="3" placeholder="如：微生物限度初测越界，重新取样复检"></textarea>
        </label>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="rejectTarget = null">取消</button>
          <button class="btn primary" type="button" @click="confirmReject">确认打回重填</button>
        </div>
      </div>
    </div>

    <!-- 导出月报分册 -->
    <div v-if="showExport" class="modal-mask" @click.self="showExport = false">
      <div class="modal">
        <h3>导出水系统月报分册</h3>
        <div class="form-grid">
          <label>
            <span>报告月份</span>
            <input v-model="exportMonth" type="month" />
          </label>
          <label class="check-line">
            <input v-model="includeExported" type="checkbox" />
            <span>连同已导出记录重新出全量册（不计入新增）</span>
          </label>
        </div>
        <ul v-if="exportPreview.length" class="export-preview">
          <li v-for="item in exportPreview" :key="item.category">
            <strong>{{ item.category }}分册</strong>：
            <template v-if="item.empty">本期无记录，将出具一页正式说明页（非空壳）</template>
            <template v-else>
              取样日期 {{ item.dates.join('、') }}；记录 {{ item.total }} 条，
              本次新增 {{ item.fresh }} 条<span v-if="item.alreadyExported">，已导出过 {{ item.alreadyExported }} 条不重复计数</span>
            </template>
          </li>
        </ul>
        <p class="hint-text">册名与页眉标注水系统类别和取样日期；一个 Excel 工作簿内含封面、四册与导出台账，可直接外发。</p>
        <p v-if="exportError" class="error-text">{{ exportError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="showExport = false">取消</button>
          <button class="btn primary" type="button" @click="confirmExport">导出分册</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { listEntries } from '@/api/local-service'
import {
  WATER_CATEGORIES,
  WATER_LINES,
  availableActions,
  downloadWaterFascicles,
  enterWaterResults,
  inspectorOn,
  registerWaterSample,
  runWaterAction,
  syncConclusionsToCleanroom,
  waterExportLedger,
} from '@/api/water-service'
import type { EntryRow } from '@/data/types'
import { currentMonth, monthOf, waterLine, type WaterLine } from '@/data/water-config'

const columns = ['取样点', '水系统类别', '班次', '电导率', '总有机碳', '微生物限度', '取样日期', '检验人', '备注']
const statuses = ['待取样', '检测中', '已合格', '不合格']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const okMessage = ref('')
const filters = ref<Record<string, string>>({ '水系统类别': '', '取样点': '', '月份': '' })

const stats = computed(() => [
  { label: '待取样点位', value: rows.value.filter((r) => r.status === '待取样').length },
  { label: '检测中样品', value: rows.value.filter((r) => r.status === '检测中').length },
  { label: '不合格点位数', value: rows.value.filter((r) => r.status === '不合格').length },
])
const statusSummary = computed(() =>
  statuses.map((status) => ({ status, count: rows.value.filter((row) => row.status === status).length })),
)

function flash(message: string, ok = false) {
  errorMessage.value = ok ? '' : message
  okMessage.value = ok ? message : ''
}

function resetFilters() {
  filters.value = { '水系统类别': '', '取样点': '', '月份': '' }
  reload()
}

function reload() {
  errorMessage.value = ''
  okMessage.value = ''
  const { '月份': month, ...rest } = filters.value
  const payload = listEntries('watermonitor', rest)
  rows.value = payload.items
    .filter((row) => !month || monthOf(String(row['取样日期'])) === month)
    .sort((a, b) => String(b['取样日期']).localeCompare(String(a['取样日期'])) || Number(a.id) - Number(b.id))
  total.value = rows.value.length
  ledger.value = waterExportLedger()
}

// —— 登记取样 ——
const registerOpen = ref(false)
const registerForm = ref({ category: '', samplePoint: '', date: '' })
const registerHint = ref('')
const registerPreview = ref('')

const activeLine = computed<WaterLine | undefined>(() => waterLine(registerForm.value.category))
const activePoints = computed(() => activeLine.value?.samplePoints ?? [])

function openRegister() {
  registerForm.value = { category: '', samplePoint: '', date: '' }
  registerHint.value = ''
  registerPreview.value = ''
  registerOpen.value = true
}
function onCategoryChange() {
  registerForm.value.samplePoint = ''
  previewAssignment()
}
function previewAssignment() {
  registerHint.value = ''
  registerPreview.value = ''
  const { category, date } = registerForm.value
  if (!category || !date) {
    return
  }
  const line = waterLine(category)
  const isRightWeekday = line && new Date(`${date}T00:00:00Z`).getUTCDay() === line.weekday
  if (!isRightWeekday) {
    registerHint.value = `${line?.category}固定${line?.weekdayLabel}${line?.shift}取样，该日期不是${line?.weekdayLabel}，请更换日期`
    return
  }
  registerPreview.value = `${inspectorOn(category, date)}（当周轮值，${line?.weekdayLabel}${line?.shift}）`
}
function submitRegister() {
  const result = registerWaterSample({
    category: registerForm.value.category,
    samplePoint: registerForm.value.samplePoint,
    date: registerForm.value.date,
  })
  if (!result.ok) {
    registerHint.value = result.message
    return
  }
  registerOpen.value = false
  reload()
  flash(result.message, true)
}

// —— 录入结果 ——
const resultTarget = ref<EntryRow | null>(null)
const resultForm = ref({ conductivity: '', toc: '', microbial: '' })
const resultError = ref('')

function activeLineOf(row: EntryRow | null): WaterLine | undefined {
  return row ? waterLine(String(row['水系统类别'])) : undefined
}

function openResults(row: EntryRow) {
  resultTarget.value = row
  resultForm.value = {
    conductivity: String(row['电导率'] ?? ''),
    toc: String(row['总有机碳'] ?? ''),
    microbial: String(row['微生物限度'] ?? ''),
  }
  resultError.value = ''
}
function submitResults() {
  if (!resultTarget.value) {
    return
  }
  const result = enterWaterResults(Number(resultTarget.value.id), { ...resultForm.value })
  if (!result.ok) {
    resultError.value = result.message
    return
  }
  resultTarget.value = null
  reload()
  flash(result.message, true)
}

// —— 打回重填 ——
const rejectTarget = ref<EntryRow | null>(null)
const rejectReason = ref('')
const rejectMicrobial = computed(() =>
  rejectTarget.value ? String(rejectTarget.value.status) === '检测中' : false,
)

function confirmReject() {
  if (!rejectTarget.value) {
    return
  }
  const result = runWaterAction(Number(rejectTarget.value.id), '打回重填', { reason: rejectReason.value })
  rejectTarget.value = null
  if (!result.ok) {
    flash(result.message)
    return
  }
  reload()
  flash(result.message, true)
}

function onAction(action: string, row: EntryRow) {
  if (action === '录入结果') {
    openResults(row)
    return
  }
  if (action === '打回重填') {
    rejectTarget.value = row
    rejectReason.value = row.status === '检测中' ? '微生物限度初测越界，重新取样复检' : '水质判定不合格，重新取样复检'
    return
  }
  const result = runWaterAction(Number(row.id), action)
  if (!result.ok) {
    flash(result.message)
    return
  }
  reload()
  flash(result.message, true)
}

// —— 导出分册 ——
const showExport = ref(false)
const exportMonth = ref(currentMonth())
const includeExported = ref(false)
const exportError = ref('')
const showLedger = ref(false)
const ledger = ref(waterExportLedger())

const exportPreview = computed(() => {
  if (!/^\d{4}-\d{2}$/.test(exportMonth.value)) {
    return []
  }
  // 轻量预演：直接用 buildWaterFascicles 不下载？此处只做计数，避免提前记账；下面手工统计。
  const month = exportMonth.value
  const ledgerSet = new Set(
    ledger.value.filter((entry) => entry.month === month).map((entry) => entry.id),
  )
  return WATER_LINES.map((line) => {
    const scoped = rows.value.filter(
      (row) => String(row['水系统类别']) === line.category && monthOf(String(row['取样日期'])) === month,
    )
    const dates = [...new Set(scoped.map((row) => String(row['取样日期'])))].sort()
    return {
      category: line.category,
      dates,
      total: scoped.length,
      fresh: includeExported.value ? scoped.length : scoped.filter((row) => !ledgerSet.has(Number(row.id))).length,
      alreadyExported: includeExported.value ? 0 : scoped.filter((row) => ledgerSet.has(Number(row.id))).length,
      empty: scoped.length === 0,
    }
  })
})

function confirmExport() {
  if (!/^\d{4}-\d{2}$/.test(exportMonth.value)) {
    exportError.value = '请选择报告月份'
    return
  }
  exportError.value = ''
  downloadWaterFascicles(exportMonth.value, { includeExported: includeExported.value })
  showExport.value = false
  reload()
  flash(`${exportMonth.value} 水系统月报分册已导出（空类别已补说明页）`, true)
}

onMounted(() => {
  // 首次进入（或重置数据后）把已判定的水系统结论反映到洁净区环境监测清单。
  syncConclusionsToCleanroom()
  reload()
})
</script>
