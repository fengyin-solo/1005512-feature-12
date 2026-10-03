import type { EntryRow } from '@/data/types'

// 水系统按类别分线：取样点、取样排期、洁净级别与各项目限度都集中在这一册配置里。
// 页面与本地服务只读这里，不再各自写死口径。

export type WaterStandard = {
  // 电导率限度（μS/cm，20℃）；null 表示该类别不在线判定（如饮用水不按药典电导率口径）
  conductivityMax: number | null
  // 总有机碳限度（mg/L）；null 表示该类别不考核 TOC
  tocMax: number | null
  // 微生物限度数值与单位（按药典/国标口径）
  microbialMax: number
  microbialUnit: string
}

export type SamplingSlot = {
  weekday: number // 1=周一 … 5=周五
  shift: string
}

export type WaterLine = {
  category: string
  samplePrefix: string
  grade: string // 对应洁净区级别，结论联动洁净区环境监测清单时使用
  standard: WaterStandard
  points: string[]
  schedule: SamplingSlot[]
}

// 班次跟星期对齐：周一至周三白班取样，周四至周五夜班取样。
export function shiftOfWeekday(weekday: number): string {
  return weekday >= 4 ? '夜班 20:00-次日08:00' : '白班 08:00-20:00'
}

// 检验人每周轮换：按 ISO 周序号在四人轮值表里轮转（(周序-1) % 4：1/5/9…王岚，2/6/10…李建国，3/7/11…赵敏，4/8/12…陈立）。
export const INSPECTOR_ROSTER = ['王岚', '李建国', '赵敏', '陈立']

export function isoWeekInfo(date: string): { year: number; week: number; weekday: number } {
  const parsed = new Date(`${date}T00:00:00Z`)
  const weekday = parsed.getUTCDay() === 0 ? 7 : parsed.getUTCDay()
  // 把日期移到本周周四，周四所在的公历年即为 ISO 周年
  parsed.setUTCDate(parsed.getUTCDate() + 4 - weekday)
  const year = parsed.getUTCFullYear()
  const yearStart = new Date(Date.UTC(year, 0, 1))
  const week =
    1 +
    Math.round(
      (((parsed.getTime() - yearStart.getTime()) / 86400000 +
        ((yearStart.getUTCDay() === 0 ? 7 : yearStart.getUTCDay()) - 1)) /
        7),
    )
  return { year, week, weekday }
}

export const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

export function inspectorOf(date: string): string {
  const { week } = isoWeekInfo(date)
  return INSPECTOR_ROSTER[(week - 1) % INSPECTOR_ROSTER.length]
}

export const WATER_LINES: WaterLine[] = [
  {
    category: '饮用水',
    samplePrefix: 'DWS',
    grade: '一般生产区',
    standard: { conductivityMax: 1000, tocMax: null, microbialMax: 100, microbialUnit: 'CFU/mL' },
    points: ['总进水口(RW-01)', '贮罐总水口(RW-02)', '管网远端水口(RW-03)'],
    schedule: [
      { weekday: 2, shift: shiftOfWeekday(2) },
      { weekday: 5, shift: shiftOfWeekday(5) },
    ],
  },
  {
    category: '纯化水',
    samplePrefix: 'PWS',
    grade: 'C级',
    standard: { conductivityMax: 5.1, tocMax: 0.5, microbialMax: 100, microbialUnit: 'CFU/mL' },
    points: ['纯化水贮罐出口(PW-01)', '分配管网中段(PW-02)', '管网最远端使用点(PW-03)'],
    schedule: [
      { weekday: 1, shift: shiftOfWeekday(1) },
      { weekday: 3, shift: shiftOfWeekday(3) },
    ],
  },
  {
    category: '注射用水',
    samplePrefix: 'WFI',
    grade: 'B级',
    standard: { conductivityMax: 1.3, tocMax: 0.5, microbialMax: 10, microbialUnit: 'CFU/100mL' },
    points: ['注射用水贮罐出口(WFI-01)', '灌装间用水点(WFI-02)', '管网最远端回水点(WFI-03)'],
    schedule: [
      { weekday: 1, shift: shiftOfWeekday(1) },
      { weekday: 3, shift: shiftOfWeekday(3) },
      { weekday: 5, shift: shiftOfWeekday(5) },
    ],
  },
  {
    category: '灭菌注射用水',
    samplePrefix: 'SWFI',
    grade: 'A级',
    standard: { conductivityMax: 1.3, tocMax: 0.5, microbialMax: 10, microbialUnit: 'CFU/100mL' },
    points: ['灭菌柜进水点(SWFI-01)', '洗瓶机进水点(SWFI-02)', '最远端使用点(SWFI-03)'],
    schedule: [{ weekday: 2, shift: shiftOfWeekday(2) }],
  },
]

export const WATER_CATEGORIES = WATER_LINES.map((line) => line.category)

const LINE_BY_CATEGORY = new Map(WATER_LINES.map((line) => [line.category, line]))

export function waterLine(category: string): WaterLine {
  const line = LINE_BY_CATEGORY.get(category)
  if (!line) {
    throw new Error(`未登记的水系统类别：${category}`)
  }
  return line
}

export function microbialSampleNo(category: string, date: string): string {
  return `${waterLine(category).samplePrefix}-${date.replace(/-/g, '')}`
}

// 某类别某天是否为排期内取样日，返回对应班次；不在排期返回 null。
export function scheduledSlot(category: string, date: string): SamplingSlot | null {
  const { weekday } = isoWeekInfo(date)
  return waterLine(category).schedule.find((slot) => slot.weekday === weekday) ?? null
}

function shiftDate(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + days)
  return next.toISOString().slice(0, 10)
}

// 空册说明页用：从某日起向后找该类别最近一次取样排期（两周内必有）。
export function nextScheduledSampling(
  category: string,
  fromDate: string,
): { date: string; weekday: string; shift: string; inspector: string } {
  for (let offset = 1; offset <= 14; offset += 1) {
    const date = shiftDate(fromDate, offset)
    const slot = scheduledSlot(category, date)
    if (slot) {
      return {
        date,
        weekday: WEEKDAY_LABELS[isoWeekInfo(date).weekday - 1],
        shift: slot.shift,
        inspector: inspectorOf(date),
      }
    }
  }
  const [first] = waterLine(category).schedule
  const fallback = shiftDate(fromDate, 7)
  return { date: fallback, weekday: WEEKDAY_LABELS[first.weekday - 1], shift: first.shift, inspector: inspectorOf(fallback) }
}

// 从填报值里解析数值：新数据形如 "1.2 μS/cm"、"5 CFU/mL"、"<10 CFU/100mL"；
// 解析不出来（历史口径、"未检出"等文字）返回 null，由调用方按兼容规则处理。
export function parseMetric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value !== 'string') {
    return null
  }
  const text = value.trim()
  if (text === '' || text.includes('未检出')) {
    return text.includes('未检出') ? 0 : null
  }
  const matched = text.match(/-?\d+(?:\.\d+)?/)
  return matched ? Number(matched[0]) : null
}

// 新登记必须按结构化数值口径填报（如 "1.8 μS/cm"、"0.32 mg/L"、"<1 CFU/100mL"）；
// 像"约2(手写)"这类历史自由文本在新登记环节直接拒绝，历史原值仍由 parseMetric 兼容读取。
export function isStructuredMetric(value: string): boolean {
  const text = value.trim()
  if (text === '' || text.includes('未检出')) {
    return true
  }
  return /^[<>≤≥≈]?\s*\d+(?:\.\d+)?\s*[\w/μ°().-]*$/.test(text)
}

export type MetricCheck =
  | { kind: 'pass' }
  | { kind: 'empty'; label: string }
  | { kind: 'exceed'; label: string; value: string; limit: string }
  // 历史电导率等非结构化原值：按原样保留，不参与越界判定
  | { kind: 'legacy'; label: string; value: string }

// 微生物越界判定（历史原样值无法解析时按兼容处理放行数值环节，结论仍由人工判定）。
export function checkMicrobial(row: EntryRow): MetricCheck {
  const line = waterLine(String(row['水系统类别'] ?? ''))
  const raw = String(row['微生物限度'] ?? '').trim()
  if (raw === '') {
    return { kind: 'empty', label: '微生物限度' }
  }
  const value = parseMetric(raw)
  if (value === null) {
    return { kind: 'legacy', label: '微生物限度', value: raw }
  }
  if (value > line.standard.microbialMax) {
    return {
      kind: 'exceed',
      label: '微生物限度',
      value: raw,
      limit: `≤${line.standard.microbialMax} ${line.standard.microbialUnit}`,
    }
  }
  return { kind: 'pass' }
}

// 判定合格前逐项核对电导率/总有机碳/微生物限度。
export function checkConclusion(row: EntryRow): MetricCheck[] {
  const line = waterLine(String(row['水系统类别'] ?? ''))
  const checks: MetricCheck[] = []

  const conductivity = String(row['电导率'] ?? '').trim()
  if (conductivity === '') {
    checks.push({ kind: 'empty', label: '电导率' })
  } else if (line.standard.conductivityMax !== null) {
    const value = parseMetric(conductivity)
    if (value === null) {
      // 历史电导率按原样保留、不迁移、不卡判定
      checks.push({ kind: 'legacy', label: '电导率', value: conductivity })
    } else if (value > line.standard.conductivityMax) {
      checks.push({
        kind: 'exceed',
        label: '电导率',
        value: conductivity,
        limit: `≤${line.standard.conductivityMax} μS/cm`,
      })
    }
  }

  const toc = String(row['总有机碳'] ?? '').trim()
  if (line.standard.tocMax !== null) {
    if (toc === '') {
      checks.push({ kind: 'empty', label: '总有机碳' })
    } else {
      const value = parseMetric(toc)
      if (value === null) {
        checks.push({ kind: 'legacy', label: '总有机碳', value: toc })
      } else if (value > line.standard.tocMax) {
        checks.push({ kind: 'exceed', label: '总有机碳', value: toc, limit: `≤${line.standard.tocMax} mg/L` })
      }
    }
  }

  checks.push(checkMicrobial(row))
  return checks
}
