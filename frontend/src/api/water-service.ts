import { listRows, listWaterLedger, markWaterExports, saveRows } from '@/data/local-store'
import {
  WATER_CATEGORIES,
  WATER_LINES,
  WEEKDAY_LABELS,
  checkConclusion,
  checkMicrobial,
  inspectorOf,
  isStructuredMetric,
  isoWeekInfo,
  microbialSampleNo,
  nextScheduledSampling,
  parseMetric,
  scheduledSlot,
  waterLine,
} from '@/data/water-lines'
import type { ActionResult, EntryRow } from '@/data/types'

const MODULE_KEY = 'watermonitor'
const CLEANROOM_KEY = 'cleanroom'
const LINK_PREFIX = 'watermonitor#'

// 结论写入洁净区环境监测清单时挂的联动键，重复结论按它 upsert，不产生重复清单行。
export function cleanroomLinkKey(recordId: number): string {
  return `${LINK_PREFIX}${recordId}`
}

export type WaterRegisterInput = {
  category: string
  point: string
  sampleDate: string
  conductivity: string
  toc: string
}

function fail(message: string): ActionResult {
  return { ok: false, message }
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function currentRows(): EntryRow[] {
  return listRows(MODULE_KEY)
}

function validateDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())
}

// 登记一条水系统取样记录：水系统按类别分线取样，取样日期必须与该线排期班次对齐，
// 检验人按周自动轮值，不允许手工指定。
export function registerWaterEntry(input: WaterRegisterInput): ActionResult {
  const { category, point, sampleDate } = input
  if (!WATER_CATEGORIES.includes(category)) {
    return fail('请选择已登记的水系统类别（饮用水/纯化水/注射用水/灭菌注射用水）')
  }
  const line = waterLine(category)
  if (!line.points.includes(point)) {
    return fail(`「${category}」分线的取样点不包含 ${point}，请从该线取样点中选择`)
  }
  if (!validateDate(sampleDate)) {
    return fail('取样日期格式应为 YYYY-MM-DD')
  }
  const slot = scheduledSlot(category, sampleDate)
  if (!slot) {
    const weekdays = line.schedule
      .map((item) => WEEKDAY_LABELS[item.weekday - 1])
      .join('、')
    return fail(`「${category}」分线只在${weekdays}按班次取样，${sampleDate} 不在排期内，取样日期须与班次对齐`)
  }
  const rows = currentRows()
  const duplicated = rows.some(
    (row) =>
      String(row['水系统类别']) === category &&
      String(row['取样点']) === point &&
      String(row['取样日期']) === sampleDate,
  )
  if (duplicated) {
    return fail(`${category} ${point} 在 ${sampleDate} 已登记取样，不能重复登记`)
  }
  const conductivity = input.conductivity.trim()
  if (conductivity !== '' && !isStructuredMetric(conductivity)) {
    return fail('电导率需按数值口径填报（如 1.8 μS/cm）；历史原值请保留在旧记录里，不要混入新登记')
  }
  const toc = input.toc.trim()
  if (line.standard.tocMax !== null && toc !== '' && !isStructuredMetric(toc)) {
    return fail('总有机碳需按数值口径填报（如 0.32 mg/L）')
  }

  const { year, week } = isoWeekInfo(sampleDate)
  const inspector = inspectorOf(sampleDate)
  const record: EntryRow = {
    id: nextId(rows),
    status: '待取样',
    pending: true,
    abnormal: false,
    dataVersion: 'v2',
    取样点: point,
    水系统类别: category,
    电导率: conductivity,
    总有机碳: line.standard.tocMax === null && toc === '' ? '不考核' : toc,
    微生物限度: '',
    取样日期: sampleDate,
    检验人: inspector,
    班次: slot.shift,
    微生物样品编号: microbialSampleNo(category, sampleDate),
    水质状态: '待取样',
  }
  saveRows(MODULE_KEY, [...rows, record])
  return {
    ok: true,
    message: `已登记 ${category} ${point}，${sampleDate}（${year}年第${week}周，${slot.shift}），当周检验人 ${inspector}`,
  }
}

function formatMicrobial(value: number, unit: string): string {
  return value <= 0 ? `未检出（<1 ${unit}）` : `${value} ${unit}`
}

// 微生物限度各入口取回来的属同一份：同类别同日期共享微生物样品编号，
// 任一口填报结果都会写回该样品全部取样点。
export function microbialSiblings(rows: EntryRow[], sampleNo: string): EntryRow[] {
  return rows.filter((row) => String(row['微生物样品编号'] ?? '') === sampleNo)
}

// 越界打回重填：同一份微生物样品涉及的所有入口一并退回待取样，清空微生物结果，
// 此前已反映到洁净区清单的联动结论同步撤回。
export function reworkMicrobialSample(sampleNo: string, reason: string): EntryRow[] {
  const rows = currentRows()
  const siblings = microbialSiblings(rows, sampleNo)
  const affectedIds = new Set(siblings.map((row) => Number(row.id)))
  const next = rows.map((row) =>
    affectedIds.has(Number(row.id))
      ? {
          ...row,
          status: '待取样',
          pending: true,
          abnormal: true,
          微生物限度: '',
          水质状态: '待取样',
          打回原因: reason,
        }
      : row,
  )
  saveRows(MODULE_KEY, next)
  withdrawCleanroomLinks([...affectedIds])
  return siblings
}

// 填报微生物限度结果。越界即打回重填（整份样品），不允许把超限值存成结论。
export function fillMicrobialResult(id: number, rawValue: string): ActionResult {
  const valueText = rawValue.trim()
  if (valueText === '') {
    return fail('请填写微生物限度结果')
  }
  const rows = currentRows()
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    return fail(`没有找到编号为 ${id} 的水质监测记录`)
  }
  if (String(row.status) !== '检测中') {
    return fail(`记录当前为「${row.status}」，请先提交检测进入「检测中」后再填报微生物限度`)
  }
  const line = waterLine(String(row['水系统类别']))
  const value = parseMetric(valueText)
  if (value === null) {
    return fail(`微生物限度需为可计数结果（如 5 ${line.standard.microbialUnit} 或“未检出”）`)
  }
  if (value < 0) {
    return fail('微生物限度不能为负数')
  }

  const sampleNo = String(row['微生物样品编号'] ?? '')
  if (value > line.standard.microbialMax) {
    const siblings = reworkMicrobialSample(
      sampleNo,
      `微生物限度 ${valueText} 超过限度 ≤${line.standard.microbialMax} ${line.standard.microbialUnit}，打回重填`,
    )
    return fail(
      `微生物限度 ${value} ${line.standard.microbialUnit} 越界（限度 ≤${line.standard.microbialMax} ${line.standard.microbialUnit}），` +
        `样品 ${sampleNo} 下 ${siblings.length} 个入口已打回「待取样」重填`,
    )
  }

  const formatted = formatMicrobial(value, line.standard.microbialUnit)
  const sampleRows = microbialSiblings(rows, sampleNo)
  const ids = new Set(sampleRows.map((item) => Number(item.id)))
  saveRows(
    MODULE_KEY,
    rows.map((item) =>
      ids.has(Number(item.id))
        ? { ...item, 微生物限度: formatted, 打回原因: '' }
        : item,
    ),
  )
  return {
    ok: true,
    message: `样品 ${sampleNo} 的微生物限度 ${formatted} 已同步到同一份样品的 ${ids.size} 个取样入口`,
  }
}

// 判定合格前在服务侧逐项卡限值；微生物越界直接打回重填，其余越界/缺项只挡回操作。
export function validateBeforeQualify(row: EntryRow): ActionResult {
  const checks = checkConclusion(row)
  const microbial = checkMicrobial(row)
  for (const check of checks) {
    if (check.kind === 'empty') {
      return fail(`${check.label}结果未齐，不能判定合格；请先补齐检测数据`)
    }
    if (check.kind === 'exceed' && check.label !== '微生物限度') {
      return fail(`${check.label} ${check.value} 越界（限度 ${check.limit}），不能判定合格，请走「标记不合格」`)
    }
  }
  if (microbial.kind === 'exceed') {
    const sampleNo = String(row['微生物样品编号'] ?? '')
    const siblings = reworkMicrobialSample(
      sampleNo,
      `微生物限度 ${microbial.value} 超过限度 ${microbial.limit}，打回重填`,
    )
    return fail(
      `微生物限度 ${microbial.value} 越界（限度 ${microbial.limit}），样品 ${sampleNo} 下 ${siblings.length} 个入口已打回「待取样」重填`,
    )
  }
  return { ok: true, message: '' }
}

// 结论反映到洁净区环境监测清单：已合格→已达标，不合格→超标预警；按联动键 upsert。
export function syncCleanroomConclusion(row: EntryRow): void {
  const category = String(row['水系统类别'] ?? '')
  const line = waterLine(category)
  const targetStatus = row.status === '已合格' ? '已达标' : '超标预警'
  const linkKey = cleanroomLinkKey(Number(row.id))
  const cleanrows = listRows(CLEANROOM_KEY)
  const index = cleanrows.findIndex((item) => String(item['联动来源'] ?? '') === linkKey)
  const synced: EntryRow = {
    ...(index >= 0 ? cleanrows[index] : { id: nextId(cleanrows) }),
    status: targetStatus,
    pending: false,
    abnormal: targetStatus === '超标预警',
    监测点位: `${category} ${String(row['取样点'] ?? '')}`,
    洁净级别: line.grade,
    悬浮粒子数: '不适用（水系统联动）',
    沉降菌数: String(row['微生物限度'] ?? '—'),
    温度读数: '—',
    相对湿度: '—',
    监测日期: String(row['取样日期'] ?? ''),
    监测状态: targetStatus,
    联动来源: linkKey,
    联动样品编号: String(row['微生物样品编号'] ?? ''),
    联动检验人: String(row['检验人'] ?? ''),
  }
  const next =
    index >= 0
      ? cleanrows.map((item, at) => (at === index ? synced : item))
      : [...cleanrows, synced]
  saveRows(CLEANROOM_KEY, next)
}

// 启动回填：历史/种子里已合格与不合格的水系统结论，按联动键幂等反映到洁净区清单；
// 已存在联动行时只刷新结果快照，不覆盖清单上的后续处理。
export function backfillCleanroomConclusions(): void {
  const cleanrows = listRows(CLEANROOM_KEY)
  const linked = new Set(
    cleanrows
      .map((item) => String(item['联动来源'] ?? ''))
      .filter((key) => key.startsWith(LINK_PREFIX)),
  )
  const waterrows = currentRows().filter((row) => row.status === '已合格' || row.status === '不合格')
  const missing = waterrows.filter((row) => !linked.has(cleanroomLinkKey(Number(row.id))))
  if (missing.length === 0) {
    return
  }
  let next = [...cleanrows]
  for (const row of missing) {
    const category = String(row['水系统类别'] ?? '')
    if (!WATER_CATEGORIES.includes(category)) {
      continue
    }
    const line = waterLine(category)
    const targetStatus = row.status === '已合格' ? '已达标' : '超标预警'
    const linkKey = cleanroomLinkKey(Number(row.id))
    next.push({
      id: nextId(next),
      status: targetStatus,
      pending: false,
      abnormal: targetStatus === '超标预警',
      监测点位: `${category} ${String(row['取样点'] ?? '')}`,
      洁净级别: line.grade,
      悬浮粒子数: '不适用（水系统联动）',
      沉降菌数: String(row['微生物限度'] ?? '—'),
      温度读数: '—',
      相对湿度: '—',
      监测日期: String(row['取样日期'] ?? ''),
      监测状态: targetStatus,
      联动来源: linkKey,
      联动样品编号: String(row['微生物样品编号'] ?? ''),
      联动检验人: String(row['检验人'] ?? ''),
    })
  }
  saveRows(CLEANROOM_KEY, next)
}

// 打回重填时撤回此前反映到洁净区清单的联动结论。
export function withdrawCleanroomLinks(recordIds: number[]): void {
  const keys = new Set(recordIds.map(cleanroomLinkKey))
  const cleanrows = listRows(CLEANROOM_KEY)
  const next = cleanrows.filter((item) => !keys.has(String(item['联动来源'] ?? '')))
  if (next.length !== cleanrows.length) {
    saveRows(CLEANROOM_KEY, next)
  }
}

// —— 分册导出 ——

export type FascicleGroup = {
  category: string
  sampleDate: string
  records: EntryRow[]
}

export type EmptyCategory = {
  category: string
  next: ReturnType<typeof nextScheduledSampling>
}

export type WaterReportModel = {
  period: string
  generatedAt: string
  groups: FascicleGroup[]
  emptyCategories: EmptyCategory[]
  ledger: ReturnType<typeof markWaterExports>
}

function nowLabel(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function buildWaterReport(
  period: string,
  options: {
    markExport?: boolean
    // 单册导出时只登记指定（类别 + 取样日期）分册的记录，合订导出不限定
    scopeCategory?: string
    scopeDate?: string
    exportedAt?: string
  } = {},
): WaterReportModel {
  if (!/^\d{4}-\d{2}$/.test(period)) {
    throw new Error('月报周期格式应为 YYYY-MM')
  }
  const generatedAt = options.exportedAt ?? nowLabel()
  const rows = currentRows().filter((row) => String(row['取样日期'] ?? '').startsWith(period))
  const byCategory = new Map<string, Map<string, EntryRow[]>>()
  for (const row of rows) {
    const category = String(row['水系统类别'] ?? '')
    if (!WATER_CATEGORIES.includes(category)) {
      continue
    }
    const date = String(row['取样日期'] ?? '')
    if (!byCategory.has(category)) {
      byCategory.set(category, new Map())
    }
    const byDate = byCategory.get(category)!
    byDate.set(date, [...(byDate.get(date) ?? []), row])
  }

  const groups: FascicleGroup[] = []
  for (const line of WATER_LINES) {
    const byDate = byCategory.get(line.category)
    if (!byDate) {
      continue
    }
    const dates = [...byDate.keys()].sort()
    for (const sampleDate of dates) {
      const records = byDate.get(sampleDate)!
      const order = new Map(line.points.map((point, at) => [point, at]))
      records.sort(
        (a, b) =>
          (order.get(String(a['取样点'])) ?? 99) - (order.get(String(b['取样点'])) ?? 99) ||
          Number(a.id) - Number(b.id),
      )
      groups.push({ category: line.category, sampleDate, records })
    }
  }

  const emptyCategories: EmptyCategory[] = WATER_LINES.filter(
    (line) => !byCategory.has(line.category),
  ).map((line) => ({
    category: line.category,
    next: nextScheduledSampling(line.category, `${period}-28`),
  }))

  if (options.markExport) {
    const scopedGroups = groups.filter(
      (group) =>
        (!options.scopeCategory || group.category === options.scopeCategory) &&
        (!options.scopeDate || group.sampleDate === options.scopeDate),
    )
    markWaterExports(
      scopedGroups.flatMap((group) =>
        group.records.map((row) => ({
          id: Number(row.id),
          category: group.category,
          point: String(row['取样点'] ?? ''),
          sampleDate: group.sampleDate,
        })),
      ),
      generatedAt,
    )
  }
  // 组册规划本身不登记外发；台账始终读最新快照，预览不会制造外发记录。
  const ledger = listWaterLedger()

  return { period, generatedAt, groups, emptyCategories, ledger }
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function standardText(category: string): string {
  const s = waterLine(category).standard
  const parts = [
    s.conductivityMax === null ? '电导率：按国标口径' : `电导率 ≤ ${s.conductivityMax} μS/cm`,
    s.tocMax === null ? '总有机碳：不考核' : `总有机碳 ≤ ${s.tocMax} mg/L`,
    `微生物限度 ≤ ${s.microbialMax} ${s.microbialUnit}`,
  ]
  return parts.join('；')
}

function groupConclusion(group: FascicleGroup): { label: string; tone: string } {
  const failed = group.records.some((row) => row.status === '不合格')
  const pending = group.records.some((row) => row.pending)
  if (failed) {
    return { label: '存在不合格，已联动洁净区清单「超标预警」', tone: 'bad' }
  }
  if (pending) {
    return { label: '检验进行中，结论待定', tone: 'pending' }
  }
  return { label: '全部合格，已联动洁净区清单「已达标」', tone: 'good' }
}

function renderFascicleSection(group: FascicleGroup): string {
  const conclusion = groupConclusion(group)
  const sampleNo = microbialSampleNo(group.category, group.sampleDate)
  const shifts = [...new Set(group.records.map((row) => String(row['班次'] ?? '—')))].join('、')
  const inspectors = [...new Set(group.records.map((row) => String(row['检验人'] ?? '—')))].join('、')
  const rowsHtml = group.records
    .map((row, index) => {
      const legacy = String(row.dataVersion ?? '') === 'v1'
      return `
        <tr>
          <td>${index + 1}</td>
          <td>${escapeHtml(row['取样点'])}</td>
          <td>${escapeHtml(row['电导率'])}${
        legacy ? '<div class="hint">历史口径原样保留</div>' : ''
      }</td>
          <td>${escapeHtml(row['总有机碳'])}</td>
          <td>${escapeHtml(row['微生物限度'] || '结果待回报')}</td>
          <td><span class="state ${row.abnormal ? 'bad' : row.pending ? 'pending' : 'good'}">${escapeHtml(
        row.status,
      )}</span></td>
        </tr>`
    })
    .join('')
  return `
  <section class="fascicle">
    <h2>水系统监测分册 ·《${escapeHtml(group.category)}》</h2>
    <p class="sub">册名：水系统监测分册-《${escapeHtml(group.category)}》-${escapeHtml(group.sampleDate)} ｜ 取样日期：${escapeHtml(
    group.sampleDate,
  )}</p>
    <table class="meta-table">
      <tr><th>水系统类别</th><td>${escapeHtml(group.category)}</td><th>取样班次</th><td>${escapeHtml(shifts)}</td></tr>
      <tr><th>当周检验人</th><td>${escapeHtml(inspectors)}</td><th>微生物样品编号</th><td>${escapeHtml(sampleNo)}</td></tr>
      <tr><th>判定口径</th><td colspan="3">${escapeHtml(standardText(group.category))}（各入口微生物结果同属一份样品）</td></tr>
      <tr><th>本期结论</th><td colspan="3"><span class="conclusion ${conclusion.tone}">${escapeHtml(conclusion.label)}</span></td></tr>
    </table>
    <table class="data-table">
      <thead>
        <tr><th style="width:40px">序号</th><th>取样点</th><th>电导率</th><th>总有机碳</th><th>微生物限度</th><th>结论</th></tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  </section>`
}

function renderEmptySection(item: EmptyCategory, period: string): string {
  return `
  <section class="fascicle empty-page">
    <h2>水系统监测分册 ·《${escapeHtml(item.category)}》（当期无取样记录）</h2>
    <p class="sub">册名：水系统监测分册-《${escapeHtml(item.category)}》-${escapeHtml(period)}（当期无取样）</p>
    <div class="notice">
      <p>本页为说明页：经核对，<strong>${escapeHtml(period)}</strong> 周期内《${escapeHtml(
    item.category,
  )}》分线无取样、无检验数据，故本册不附检验明细，不出具空壳报表。</p>
      <p>该分线下一次计划取样：<strong>${escapeHtml(item.next.date)}（${escapeHtml(
    item.next.weekday,
  )}，${escapeHtml(item.next.shift)}）</strong>，当周轮换检验人：<strong>${escapeHtml(item.next.inspector)}</strong>。</p>
      <p>如当期实际已取样，请联系水质监测岗核对分线排期后补登记，再重新导出本分册。</p>
    </div>
  </section>`
}

function renderLedger(model: WaterReportModel, recordIds?: Set<number>): string {
  const entries =
    recordIds === undefined
      ? model.ledger
      : model.ledger.filter((entry) => recordIds.has(Number(entry.recordId)))
  if (entries.length === 0) {
    return '<p class="hint">本册无外发台账记录。</p>'
  }
  const rowsHtml = entries
    .map(
      (entry) => `
      <tr>
        <td>${entry.recordId}</td>
        <td>${escapeHtml(entry.category)}</td>
        <td>${escapeHtml(entry.point)}</td>
        <td>${escapeHtml(entry.sampleDate)}</td>
        <td>${escapeHtml(entry.firstExportAt)}</td>
        <td>${entry.exportCount}</td>
      </tr>`,
    )
    .join('')
  return `
  <section class="fascicle ledger">
    <h2>附：外发台账（同一取样记录重复导出只计一次）</h2>
    <table class="data-table">
      <thead><tr><th>记录编号</th><th>水系统类别</th><th>取样点</th><th>取样日期</th><th>首次外发时间</th><th>累计外发次数</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <p class="hint">外发按取样记录编号去重：首次导出登记外发时间，再次导出仅累加次数，不重复计册。</p>
  </section>`
}

const REPORT_STYLE = `
  body { font-family: 'PingFang SC','Microsoft YaHei',sans-serif; color:#1f2937; margin:0; background:#fff; }
  .cover { padding: 56px 48px 32px; border-bottom: 3px solid #1f6feb; }
  .cover h1 { font-size: 26px; margin: 0 0 8px; }
  .cover .sub { color:#475569; font-size: 14px; margin: 4px 0; }
  .toc { padding: 24px 48px; }
  .toc h2 { font-size: 17px; }
  .toc table, .meta-table, .data-table { width:100%; border-collapse: collapse; }
  .toc th, .toc td, .meta-table th, .meta-table td, .data-table th, .data-table td { border:1px solid #94a3b8; padding:7px 9px; font-size:12.5px; text-align:left; vertical-align: top; }
  .toc th, .data-table th { background:#eef4ff; }
  .meta-table th { background:#f8fafc; width: 18%; white-space: nowrap; }
  .fascicle { padding: 28px 48px; page-break-after: always; }
  .fascicle h2 { font-size: 18px; margin: 0 0 6px; color:#0f172a; }
  .sub { color:#475569; font-size:12.5px; margin: 0 0 14px; }
  .hint { color:#64748b; font-size:11.5px; margin: 4px 0 0; }
  .state { display:inline-block; padding:1px 9px; border-radius: 999px; font-size:11.5px; }
  .state.good, .conclusion.good { background:#e7f6ec; color:#1a7f37; }
  .state.pending, .conclusion.pending { background:#fff4e0; color:#9a6700; }
  .state.bad, .conclusion.bad { background:#fdeaea; color:#b42318; }
  .conclusion { display:inline-block; padding:2px 10px; border-radius: 999px; font-size:12px; }
  .empty-page .notice { margin-top: 18px; border:1px dashed #94a3b8; background:#f8fafc; padding:16px 20px; border-radius:8px; line-height:1.9; font-size:13px; }
  .ledger h2 { font-size:15px; }
  .sign { margin-top: 26px; font-size:12.5px; color:#475569; display:flex; justify-content:space-between; }
  @media print { .fascicle { page-break-after: always; } body { font-size: 12px; } }
`

function reportShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${REPORT_STYLE}</style>
</head>
<body>${body}</body>
</html>`
}

function renderCover(model: WaterReportModel): string {
  const tocRows = model.groups
    .map((group, index) => {
      const conclusion = groupConclusion(group)
      return `<tr><td>${index + 1}</td><td>${escapeHtml(
        `水系统监测分册-《${group.category}》-${group.sampleDate}`,
      )}</td><td>${group.records.length}</td><td>${escapeHtml(conclusion.label)}</td></tr>`
    })
    .join('')
  const emptyRows = model.emptyCategories
    .map(
      (item) =>
        `<tr><td>${escapeHtml(
          `水系统监测分册-《${item.category}》-${model.period}（当期无取样）`,
        )}</td><td>0</td><td>当期无取样，附说明页（不交空壳文件）</td></tr>`,
    )
    .join('')
  return `
  <section class="cover">
    <h1>工艺用水监测月报分册合订</h1>
    <p class="sub">报告周期：${escapeHtml(model.period)}</p>
    <p class="sub">生成时间：${escapeHtml(model.generatedAt)}</p>
    <p class="sub">编制依据：水系统按类别分线取样；检验人每周轮换；取样日期与班次对齐。本册为外发版本，历史电导率按原样保留。</p>
  </section>
  <section class="toc">
    <h2>分册目录</h2>
    <table>
      <thead><tr><th style="width:40px">序号</th><th>册名（水系统类别 + 取样日期）</th><th style="width:70px">记录条数</th><th>分册结论</th></tr></thead>
      <tbody>${tocRows}${emptyRows}</tbody>
    </table>
  </section>`
}

export function exportWaterReport(period: string): { filename: string; content: string; model: WaterReportModel } {
  const model = buildWaterReport(period, { markExport: true })
  const body =
    renderCover(model) +
    model.groups.map(renderFascicleSection).join('') +
    model.emptyCategories.map((item) => renderEmptySection(item, period)).join('') +
    renderLedger(model)
  return {
    filename: `水系统监测月报分册合订-${period}.html`,
    content: reportShell(`水系统监测月报分册合订 ${period}`, body),
    model,
  }
}

export function exportWaterFascicle(
  category: string,
  sampleDate: string,
): { filename: string; content: string } | ActionResult {
  const period = sampleDate.slice(0, 7)
  const model = buildWaterReport(period, {
    markExport: true,
    scopeCategory: category,
    scopeDate: sampleDate,
  })
  const group = model.groups.find(
    (item) => item.category === category && item.sampleDate === sampleDate,
  )
  if (!group) {
    return fail(`没有找到《${category}》在 ${sampleDate} 的取样分册`)
  }
  const ids = new Set(group.records.map((row) => Number(row.id)))
  const body =
    renderFascicleSection(group) +
    renderLedger(model, ids) +
    `<div class="fascicle"><div class="sign"><span>编制（当周检验人）：${escapeHtml(
      [...new Set(group.records.map((row) => String(row['检验人'] ?? '')))].join('、'),
    )}</span><span>生成时间：${escapeHtml(model.generatedAt)}</span></div></div>`
  const filename = `水系统监测分册-《${category}》-${sampleDate}.html`
  return { filename, content: reportShell(filename.replace(/\.html$/, ''), body) }
}

export function exportWaterEmptyPage(category: string, period: string): { filename: string; content: string } {
  const model = buildWaterReport(period)
  const item = model.emptyCategories.find((entry) => entry.category === category)
  const empty: EmptyCategory =
    item ?? { category, next: nextScheduledSampling(category, `${period}-28`) }
  const body = renderEmptySection(empty, period)
  const filename = `水系统监测分册-《${category}》-${period}-当期无取样说明页.html`
  return { filename, content: reportShell(filename.replace(/\.html$/, ''), body) }
}

export function downloadHtmlFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
