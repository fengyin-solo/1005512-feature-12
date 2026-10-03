import { MODULE_BY_KEY } from '@/data/modules'
import { listRows, readJson, saveRows, writeJson } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'
import {
  WATER_CATEGORIES,
  WATER_KEY,
  WATER_LINES,
  WATER_STATUS,
  bioburdenOk,
  conductivityOk,
  currentMonth,
  formatBioburden,
  inspectorOn,
  monthOf,
  numericValue,
  periodLabel,
  shiftMismatch,
  tocOk,
  waterLine,
} from '@/data/water-config'

// 水系统状态只能顺着流转：键=当前状态，值=允许前往的状态；越级一律挡回。
const WATER_FLOW: Record<string, string[]> = {
  [WATER_STATUS.TODO]: [WATER_STATUS.TESTING],
  [WATER_STATUS.TESTING]: [WATER_STATUS.PASS, WATER_STATUS.FAIL, WATER_STATUS.TODO],
  [WATER_STATUS.PASS]: [],
  [WATER_STATUS.FAIL]: [WATER_STATUS.TODO],
}

const RESULT_FIELDS = ['电导率', '总有机碳', '微生物限度'] as const

// ---------------------------------------------------------------------------
// 列表与动作
// ---------------------------------------------------------------------------

export function waterRows(): EntryRow[] {
  return listRows(WATER_KEY)
}

/** 按状态机与口径算出某条记录当前可执行的动作，越级动作不渲染也调不动。 */
export function availableActions(row: EntryRow): string[] {
  const status = String(row.status)
  if (status === WATER_STATUS.TODO) {
    return ['提交检测']
  }
  if (status === WATER_STATUS.TESTING) {
    // 微生物限度越界：不能判定合格/不合格，只允许打回重填。
    if (!bioburdenOk(String(row['水系统类别']), row['微生物限度'])) {
      return ['打回重填']
    }
    return ['录入结果', '判定合格', '标记不合格']
  }
  if (status === WATER_STATUS.FAIL) {
    return ['打回重填']
  }
  return []
}

function persist(rows: EntryRow[]): void {
  saveRows(WATER_KEY, rows)
  syncConclusionsToCleanroom()
}

/** 水系统专用状态流转：先过状态机，再走各动作的口径校验。 */
export function runWaterAction(
  id: number,
  action: string,
  extra: { reason?: string } = {},
): ActionResult {
  const meta = MODULE_BY_KEY.get(WATER_KEY)
  if (!meta) {
    return { ok: false, message: '水系统模块未登记' }
  }
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = waterRows()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const row = rows[index]
  const current = String(row.status)

  if (current === target && action !== '打回重填') {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const canReach = WATER_FLOW[current]?.includes(target) ?? false
  if (!canReach) {
    return { ok: false, message: `状态只能顺着流转：「${current}」不能越级到「${target}」，已挡回` }
  }

  const category = String(row['水系统类别'])

  if (action === '提交检测') {
    if (String(row['取样点']) === '' || String(row['取样日期']) === '') {
      return { ok: false, message: '取样点、取样日期不齐，不能提交检测' }
    }
  }

  if (action === '判定合格') {
    const missing = RESULT_FIELDS.filter((field) => {
      if (field === '总有机碳' && waterLine(category)?.limits.tocApplicable === false) {
        return false
      }
      return numericValue(row[field]) === null
    })
    if (missing.length) {
      return { ok: false, message: `${missing.join('、')}尚未录入有效数值，不能判定合格` }
    }
    if (!bioburdenOk(category, row['微生物限度'])) {
      const line = waterLine(category)
      return {
        ok: false,
        message: `微生物限度 ${row['微生物限度']} 越界（限度 ${formatBioburden(line?.limits.bioburdenMax ?? 0)}），按口径打回重填，不得判定合格`,
      }
    }
    if (!conductivityOk(category, row['电导率']) || !tocOk(category, row['总有机碳'])) {
      return { ok: false, message: '电导率或总有机碳越界，不能判定合格，请改走「标记不合格」' }
    }
  }

  if (action === '标记不合格') {
    // 微生物限度越界不走不合格终态，必须打回重填。
    if (!bioburdenOk(category, row['微生物限度'])) {
      const line = waterLine(category)
      return {
        ok: false,
        message: `微生物限度 ${row['微生物限度']} 越界（限度 ${formatBioburden(line?.limits.bioburdenMax ?? 0)}），按口径只能打回重填，不得标记不合格`,
      }
    }
    const hasReading = RESULT_FIELDS.some((field) => numericValue(row[field]) !== null)
    if (!hasReading) {
      return { ok: false, message: '尚未录入任何检测结果，不能标记不合格' }
    }
    if (conductivityOk(category, row['电导率']) && tocOk(category, row['总有机碳'])) {
      return { ok: false, message: '电导率、总有机碳与微生物限度均在限度内，不能标记不合格' }
    }
  }

  if (action === '打回重填') {
    const microbialExceed = !bioburdenOk(category, row['微生物限度'])
    if (current === WATER_STATUS.TESTING && !microbialExceed) {
      return { ok: false, message: '只有微生物限度越界的在检样品才能打回重填' }
    }
    const stamp = new Date().toISOString().slice(0, 10)
    const previousNote = String(row['备注'] ?? '')
    const reason = extra.reason?.trim() ||
      (microbialExceed ? '微生物限度越界，重新取样检验' : '水质判定不合格，重新取样检验')
    const cause = microbialExceed
      ? `原微生物限度「${row['微生物限度'] || '未录入'}」`
      : `电导率「${row['电导率'] || '未录入'}」、总有机碳「${row['总有机碳'] || '未录入'}」、微生物限度「${row['微生物限度'] || '未录入'}」`
    const note = `[${stamp} 打回重填] ${cause}；${reason}`
    const next: EntryRow = {
      ...row,
      status: WATER_STATUS.TODO,
      pending: true,
      abnormal: false,
      // 打回后检测项清空重填；电导率/TOC 历史值不直接抹，要求随重检重新录入。
      电导率: '',
      总有机碳: '',
      微生物限度: '',
      备注: previousNote ? `${previousNote}\n${note}` : note,
    }
    const copy = [...rows]
    copy[index] = next
    persist(copy)
    return { ok: true, message: `微生物限度越界，已打回重填：${meta.entity}退回「${WATER_STATUS.TODO}」，检测项清空待重检` }
  }

  const next: EntryRow = {
    ...row,
    status: target,
    pending: target !== WATER_STATUS.FAIL,
    abnormal: target === WATER_STATUS.FAIL,
  }
  const copy = [...rows]
  copy[index] = next
  persist(copy)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// ---------------------------------------------------------------------------
// 取样登记与结果录入
// ---------------------------------------------------------------------------

export type WaterSampleInput = {
  category: string
  samplePoint: string
  date: string
  inspector?: string
}

/** 登记取样：分线取样，日期必须跟班次（固定星期）对齐，检验人按周轮换自动派工。 */
export function registerWaterSample(input: WaterSampleInput): ActionResult {
  const line = waterLine(input.category)
  if (!line) {
    return { ok: false, message: `未知水系统类别「${input.category}」，可登记类别：${WATER_CATEGORIES.join('、')}` }
  }
  if (!line.samplePoints.includes(input.samplePoint)) {
    return { ok: false, message: `取样点「${input.samplePoint}」不属于${line.category}线，该线取样点：${line.samplePoints.join('、')}` }
  }
  const mismatch = shiftMismatch(input.category, input.date)
  if (mismatch) {
    return { ok: false, message: mismatch }
  }
  const inspector = inspectorOn(input.category, input.date)
  if (input.inspector && input.inspector.trim() !== inspector) {
    return { ok: false, message: `检验人每周轮换，${input.date} 当值为「${inspector}」，不能指派他人` }
  }
  const rows = waterRows()
  const duplicate = rows.some(
    (row) =>
      String(row['水系统类别']) === input.category &&
      String(row['取样点']) === input.samplePoint &&
      String(row['取样日期']) === input.date,
  )
  if (duplicate) {
    return { ok: false, message: `${input.category} ${input.samplePoint} 在 ${input.date} 已登记过取样，不能重复登记` }
  }
  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  const record: EntryRow = {
    id: nextId,
    status: WATER_STATUS.TODO,
    pending: true,
    abnormal: false,
    取样点: input.samplePoint,
    水系统类别: input.category,
    班次: line.shift,
    电导率: '',
    总有机碳: line.limits.tocApplicable ? '' : '不适用',
    微生物限度: '',
    取样日期: input.date,
    检验人: inspector,
    备注: '',
    水质状态: '',
  }
  persist([...rows, record])
  return { ok: true, message: `已登记${line.category} ${input.samplePoint} ${input.date}（${line.weekdayLabel}${line.shift}），当值检验人：${inspector}` }
}

export type WaterResultInput = {
  conductivity: string
  toc: string
  microbial: string
}

/**
 * 录入检测结果。微生物限度各入口取回来的属同一份：同一水系统类别、同一取样日期
 * （同一次取样、同一检验人轮班）的各取样点必须共用同一个微生物结果。
 */
export function enterWaterResults(id: number, input: WaterResultInput): ActionResult {
  const rows = waterRows()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的水质监测记录` }
  }
  const row = rows[index]
  if (String(row.status) !== WATER_STATUS.TESTING) {
    return { ok: false, message: `只有「${WATER_STATUS.TESTING}」的样品能录入结果，当前为「${row.status}」` }
  }
  const category = String(row['水系统类别'])
  const date = String(row['取样日期'])
  const line = waterLine(category)
  if (!line) {
    return { ok: false, message: `未知水系统类别「${category}」` }
  }

  const conductivity = input.conductivity.trim()
  const toc = input.toc.trim()
  const microbial = input.microbial.trim()

  if (numericValue(conductivity) === null) {
    return { ok: false, message: '电导率需录入数值（µS/cm），历史手抄文本请走历史记录口径，不在此处登记' }
  }
  if (line.limits.tocApplicable && numericValue(toc) === null) {
    return { ok: false, message: '总有机碳需录入数值（mg/L）' }
  }
  const microbialValue = numericValue(microbial)
  if (microbialValue === null || microbialValue < 0) {
    return { ok: false, message: '微生物限度需录入非负数值（CFU/ml）' }
  }

  // 同一份微生物结果：同类别同日期的兄弟记录要么没录，要么数值必须一致。
  const siblings = rows.filter(
    (item) =>
      Number(item.id) !== id &&
      String(item['水系统类别']) === category &&
      String(item['取样日期']) === date,
  )
  const conflict = siblings.find((item) => {
    const existed = numericValue(item['微生物限度'])
    return existed !== null && Math.abs(existed - microbialValue) > 1e-9
  })
  if (conflict) {
    return {
      ok: false,
      message: `微生物限度各入口取回来的属同一份：${category} ${date} 已录入 ${conflict['微生物限度']}（见编号 ${conflict.id} ${conflict['取样点']}），不能改成 ${microbial}`,
    }
  }

  const sameSample = (item: EntryRow): boolean =>
    String(item['水系统类别']) === category && String(item['取样日期']) === date

  let next = [...rows]
  next[index] = {
    ...row,
    电导率: conductivity,
    总有机碳: line.limits.tocApplicable ? toc : '不适用',
    微生物限度: microbial,
  }
  let propagated = 0
  // 同一次取样的其他入口尚未录微生物：同一份结果自动带过去，保持口径一致。
  next = next.map((item) => {
    if (
      Number(item.id) !== id &&
      sameSample(item) &&
      numericValue(item['微生物限度']) === null
    ) {
      propagated += 1
      return { ...item, 微生物限度: microbial }
    }
    return item
  })
  persist(next)

  const exceed = microbialValue > line.limits.bioburdenMax
  return {
    ok: true,
    message:
      `结果已录入${exceed ? '；微生物限度越界，需打回重填' : ''}` +
      (propagated ? `；同一份微生物结果已同步到另外 ${propagated} 个入口` : ''),
  }
}

// ---------------------------------------------------------------------------
// 结论反映到洁净区环境监测清单
// ---------------------------------------------------------------------------

const CLEANROOM_KEY = 'cleanroom'
const SYNC_PREFIX = '水质监测#'

/** 水系统判定结论（已合格/不合格）反映到洁净区环境监测清单；打回后撤销对应结论。 */
export function syncConclusionsToCleanroom(): { added: number; updated: number; removed: number } {
  const roomRows = listRows(CLEANROOM_KEY)
  const water = waterRows()
  const terminalStatuses: string[] = [WATER_STATUS.PASS, WATER_STATUS.FAIL]
  const conclusionRows = water.filter((row) => terminalStatuses.includes(String(row.status)))
  const liveRefs = new Map(
    conclusionRows.map((row) => [SYNC_PREFIX + String(row.id), row]),
  )

  let added = 0
  let updated = 0
  let removed = 0

  let next = roomRows.filter((row) => {
    const ref = String(row['来源编号'] ?? '')
    if (!ref.startsWith(SYNC_PREFIX)) {
      return true
    }
    if (liveRefs.has(ref)) {
      return true
    }
    removed += 1 // 水系统记录被打回重填，结论不再成立，撤下环境清单里的对应条目
    return false
  })

  for (const [ref, waterRow] of liveRefs) {
    const pass = String(waterRow.status) === WATER_STATUS.PASS
    const patch: EntryRow = {
      id: -1,
      监测点位: `【水点】${waterRow['水系统类别']}-${waterRow['取样点']}`,
      洁净级别: '工艺用水系统',
      悬浮粒子数: '不适用',
      沉降菌数: String(waterRow['微生物限度'] ?? ''),
      温度读数: '—',
      相对湿度: '—',
      监测日期: String(waterRow['取样日期']),
      监测状态: pass ? '已达标（水质合格）' : '超标预警（水质不合格）',
      水系统类别: String(waterRow['水系统类别']),
      检验结论: pass ? '水质合格' : '水质不合格',
      来源编号: ref,
      status: pass ? '已达标' : '超标预警',
      pending: false,
      abnormal: !pass,
    }
    const existingIndex = next.findIndex((row) => String(row['来源编号']) === ref)
    if (existingIndex >= 0) {
      next[existingIndex] = { ...next[existingIndex], ...patch }
      updated += 1
    } else {
      const nextId = next.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
      const created: EntryRow = { ...patch, id: nextId }
      next = [...next, created]
      added += 1
    }
  }

  saveRows(CLEANROOM_KEY, next)
  return { added, updated, removed }
}

// ---------------------------------------------------------------------------
// 月报分册导出
// ---------------------------------------------------------------------------

type LedgerEntry = { id: number; month: string; exportedAt: string; category: string }
const LEDGER_KEY = 'pharma-cleanroom:water-export-ledger'

function readLedger(): LedgerEntry[] {
  return readJson<LedgerEntry[]>(LEDGER_KEY, [])
}

export type FascicleSummary = {
  category: string
  dates: string[]
  total: number
  fresh: number
  alreadyExported: number
  empty: boolean
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function textCell(value: string): string {
  return `<Cell><Data ss:Type="String">${xmlEscape(value)}</Data></Cell>`
}

function sheetXml(name: string, rows: string[][]): string {
  const body = rows
    .map(
      (cells) =>
        `<Row>${cells.map((cell) => textCell(String(cell ?? ''))).join('')}</Row>`,
    )
    .join('')
  const columns = Array.from({ length: 11 }, () => '<Column ss:Width="90"/>').join('')
  return `<Worksheet ss:Name="${xmlEscape(name)}"><Table>${columns}${body}</Table></Worksheet>`
}

const REPORT_COLUMNS = [
  '序号',
  '取样点',
  '取样日期',
  '班次',
  '检验人（按周轮换）',
  '电导率 µS/cm',
  '总有机碳 mg/L',
  '微生物限度 CFU/ml',
  '判定',
  '当前状态',
  '备注',
]

function conclusionOf(row: EntryRow): string {
  switch (String(row.status)) {
    case WATER_STATUS.PASS:
      return '符合规定'
    case WATER_STATUS.FAIL:
      return '不符合规定'
    case WATER_STATUS.TESTING:
      return '检测中，待判定'
    default:
      return '已取样排班，待检测'
  }
}

/**
 * 按月生成水系统月报分册（一个工作簿，每类水系统一张分册表；当期为空的类别
 * 补一页正式说明，不出空壳文件）。同一条取样记录重复导出只算一次：导出台账
 * 记录编号，重出只在台账中追溯，不计入本次册数。
 */
export function buildWaterFascicles(
  month = currentMonth(),
  options: { includeExported?: boolean } = {},
): { filename: string; content: string; summaries: FascicleSummary[]; generatedAt: string } {
  const rows = waterRows()
  const ledger = readLedger()
  const exportedIds = new Set(
    ledger.filter((entry) => entry.month === month).map((entry) => entry.id),
  )
  const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 16)

  const summaries: FascicleSummary[] = []
  const sheets: string[] = []

  for (const line of WATER_LINES) {
    const categoryRows = rows
      .filter(
        (row) =>
          String(row['水系统类别']) === line.category &&
          monthOf(String(row['取样日期'])) === month,
      )
      .sort((a, b) => String(a['取样日期']).localeCompare(String(b['取样日期'])))

    const dates = [...new Set(categoryRows.map((row) => String(row['取样日期'])))].sort()
    const fresh = categoryRows.filter((row) => !exportedIds.has(Number(row.id)))
    const alreadyExported = categoryRows.length - fresh.length
    const sheetName = `${line.category}分册`

    if (categoryRows.length === 0) {
      // 当期为空：补一页正式说明，绝不为空壳。
      const scheduled = lineScheduledDates(line.category, month)
      sheets.push(
        sheetXml(sheetName, [
          [`${line.category}分册（${periodLabel(month)}）`],
          [''],
          ['本期说明'],
          [`本册所属水系统：${line.category}（按类别分线取样，固定${line.weekdayLabel}${line.shift}）。`],
          [`${periodLabel(month)}该水系统无取样、检验记录，本期分册无检验数据可列。`],
          [
            scheduled.length
              ? `本期内排班日期：${scheduled.join('、')}；各排班日未安排取样点，按「当期无记录」出具本说明页。`
              : `${periodLabel(month)}无该线排班日。`,
          ],
          [`检验项目口径：取样点、电导率、总有机碳、微生物限度；限度依据：${line.limitNote}。`],
          ['说明：本页为正式出具的空期说明页，本册非空壳文件；如有补检，将在对应月份分册中补列。'],
          ['编制：质量保证部　　复核：QC 微生物室　　出具日期：' + generatedAt],
        ]),
      )
      summaries.push({ category: line.category, dates: [], total: 0, fresh: 0, alreadyExported: 0, empty: true })
      continue
    }

    const table: string[][] = [
      [`${line.category}分册（${periodLabel(month)}）`],
      [`水系统类别：${line.category}　　取样日期：${dates.join('、')}　　固定班次：${line.weekdayLabel}${line.shift}`],
      [`限度口径：${line.limitNote}`],
      [''],
      REPORT_COLUMNS,
    ]

    const scoped = options.includeExported ? categoryRows : fresh
    scoped.forEach((row, cursor) => {
      table.push([
        String(cursor + 1),
        String(row['取样点']),
        String(row['取样日期']),
        String(row['班次'] ?? line.shift),
        String(row['检验人']),
        String(row['电导率'] ?? '—'),
        line.limits.tocApplicable ? String(row['总有机碳'] ?? '—') : '不适用',
        String(row['微生物限度'] ?? '—'),
        conclusionOf(row),
        String(row.status),
        String(row['备注'] ?? '').replace(/\n/g, '；'),
      ])
    })

    if (!options.includeExported && alreadyExported > 0) {
      const ids = categoryRows
        .filter((row) => exportedIds.has(Number(row.id)))
        .map((row) => `#${row.id}`)
        .join('、')
      table.push([''])
      table.push([
        `注：另有 ${alreadyExported} 条取样记录（编号 ${ids}）已于前期分册导出，按「同一条记录只算一次」口径，本次不重复列示，见导出台账。`,
      ])
    }
    if (!options.includeExported && fresh.length === 0) {
      table.push(['本册本期无新增导出记录，本页为导出说明页，非空壳文件。'])
    }
    table.push([''])
    table.push(['检验依据：《中国药典》通则及企业内控标准；微生物限度各入口取同一份样品检验，结果共用。'])
    table.push(['编制：QC　　复核：QA　　出具日期：' + generatedAt])

    sheets.push(sheetXml(sheetName, table))
    summaries.push({
      category: line.category,
      dates,
      total: categoryRows.length,
      fresh: options.includeExported ? categoryRows.length : fresh.length,
      alreadyExported: options.includeExported ? 0 : alreadyExported,
      empty: false,
    })
  }

  // 导出台账页：每条记录只留一条，重复导出可追溯、不重复计数。
  const monthLedger = ledger.filter((entry) => entry.month === month)
  const ledgerTable: string[][] = [
    [`导出台账（${periodLabel(month)}）`],
    [''],
    ['记录编号', '水系统类别', '所属月份', '首次导出时间', '说明'],
  ]
  if (monthLedger.length === 0) {
    ledgerTable.push(['—', '—', month, '—', '本次为该月份册首次导出'])
  } else {
    monthLedger
      .sort((a, b) => a.exportedAt.localeCompare(b.exportedAt))
      .forEach((entry) => {
        ledgerTable.push([String(entry.id), entry.category, entry.month, entry.exportedAt, '同一条取样记录只算一次，重复导出仅在此追溯'])
      })
  }
  sheets.push(sheetXml('导出台账', ledgerTable))

  // 封面放在第一张表之前：SpreadsheetML 按文档顺序展示。
  const cover = sheetXml('封面', [
    ['水系统月报（分类别分册）'],
    [''],
    [`报告期：${periodLabel(month)}`],
    [`出具日期：${generatedAt}`],
    [''],
    ['分册目录'],
    ...WATER_LINES.map((line, i) => {
      const summary = summaries[i]
      return [
        `${i + 1}. ${line.category}分册${summary.empty ? '（本期无记录，出具说明页）' : `（取样日期：${summary.dates.join('、')}，记录 ${summary.total} 条）`}`,
      ]
    }),
    [''],
    ['各册统一列明：取样点、电导率、总有机碳、微生物限度；检验人按周轮换，取样日期与班次对齐。'],
    ['微生物限度各入口取同一份样品；同一取样记录重复导出只算一次。'],
    ['本工作簿导出后可直接外发。'],
  ])

  const content = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
${[cover, ...sheets].join('\n')}
</Workbook>`

  // 记账：本次新导出的编号写入台账（includeExported 的重出不重复记账）。
  if (!options.includeExported) {
    const stamp = generatedAt
    const existing = new Set(ledger.map((entry) => `${entry.id}@${entry.month}`))
    const additions: LedgerEntry[] = []
    for (const line of WATER_LINES) {
      for (const row of rows) {
        if (
          String(row['水系统类别']) === line.category &&
          monthOf(String(row['取样日期'])) === month &&
          !exportedIds.has(Number(row.id)) &&
          !existing.has(`${Number(row.id)}@${month}`)
        ) {
          additions.push({ id: Number(row.id), month, exportedAt: stamp, category: line.category })
        }
      }
    }
    if (additions.length) {
      writeJson(LEDGER_KEY, [...ledger, ...additions])
    }
  }

  return { filename: `水系统月报分册-${month}.xls`, content, summaries, generatedAt }
}

export function downloadWaterFascicles(
  month: string,
  options: { includeExported?: boolean } = {},
): FascicleSummary[] {
  const { filename, content, summaries } = buildWaterFascicles(month, options)
  const blob = new Blob(['﻿', content], { type: 'application/vnd.ms-excel;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  return summaries
}

export function waterExportLedger(): LedgerEntry[] {
  return readLedger().sort((a, b) => b.exportedAt.localeCompare(a.exportedAt))
}

/** 某月内该线的排班日期（固定星期几），供空期说明页列示。 */
function lineScheduledDates(category: string, month: string): string[] {
  const line = waterLine(category)
  if (!line) {
    return []
  }
  const [year, mm] = month.split('-').map(Number)
  const days = new Date(Date.UTC(year, mm, 0)).getUTCDate()
  const result: string[] = []
  for (let day = 1; day <= days; day += 1) {
    const text = `${month}-${String(day).padStart(2, '0')}`
    const weekday = new Date(`${text}T00:00:00Z`).getUTCDay()
    if (weekday === line.weekday) {
      result.push(text)
    }
  }
  return result
}

// 供页面展示限度口径与轮换派工。
export {
  WATER_CATEGORIES,
  WATER_LINES,
  formatBioburden,
  inspectorOn,
  periodLabel,
}
