/**
 * 水系统月报领域配置：分线取样、班次对齐、检验人按周轮换、各线内控限度都在这里。
 * 页面与本地服务只读本文件，业务口径集中维护。
 */

export const WATER_KEY = 'watermonitor'
export const WATER_STATUS = {
  TODO: '待取样',
  TESTING: '检测中',
  PASS: '已合格',
  FAIL: '不合格',
} as const

// 水系统分线：月报按类别分册，每周固定班次取样。
export type WaterLine = {
  category: string
  weekday: number // 0=周日 … 6=周六，取样必须落在该星期
  shift: string
  weekdayLabel: string
  samplePoints: string[]
  limits: {
    conductivityMax: number // µS/cm，内控
    tocMax: number // mg/L(ppm)，内控；不适用记为不适用
    tocApplicable: boolean
    bioburdenMax: number // CFU/ml，内控
  }
  limitNote: string
}

export const WATER_LINES: WaterLine[] = [
  {
    category: '纯化水',
    weekday: 1,
    shift: '早班',
    weekdayLabel: '周一',
    samplePoints: ['PW-总送水口', 'PW-总回水口', 'PW-储罐出口', 'PW-灌装间使用点'],
    limits: { conductivityMax: 2.0, tocMax: 0.50, tocApplicable: true, bioburdenMax: 100 },
    limitNote: '电导率≤2.0µS/cm(20℃)；TOC≤0.50mg/L；微生物限度需氧菌总数≤100CFU/ml（企业内控，引自《中国药典》纯化水项目）',
  },
  {
    category: '注射用水',
    weekday: 3,
    shift: '中班',
    weekdayLabel: '周三',
    samplePoints: ['WFI-蒸馏机出口', 'WFI-总回水口', 'WFI-储罐出口', 'WFI-洗瓶机使用点'],
    limits: { conductivityMax: 1.1, tocMax: 0.50, tocApplicable: true, bioburdenMax: 10 },
    limitNote: '电导率≤1.1µS/cm(20℃)；TOC≤0.50mg/L；微生物限度需氧菌总数≤10CFU/ml（企业内控，引自《中国药典》注射用水项目）',
  },
  {
    category: '灭菌注射用水',
    weekday: 5,
    shift: '早班',
    weekdayLabel: '周五',
    samplePoints: ['SWFI-灭菌柜进水口', 'SWFI-配料罐使用点', 'SWFI-灌装线使用点'],
    limits: { conductivityMax: 1.1, tocMax: 0.50, tocApplicable: true, bioburdenMax: 10 },
    limitNote: '电导率≤1.1µS/cm(20℃)；TOC≤0.50mg/L；微生物限度需氧菌总数≤10CFU/ml（企业内控，按注射用水执行）',
  },
  {
    category: '饮用水',
    weekday: 2,
    shift: '早班',
    weekdayLabel: '周二',
    samplePoints: ['DW-原水入口', 'DW-活性炭过滤后', 'DW-车间总进水'],
    limits: { conductivityMax: 20.0, tocMax: 0, tocApplicable: false, bioburdenMax: 500 },
    limitNote: '电导率≤20µS/cm(企业内控)；TOC不适用；微生物限度需氧菌总数≤500CFU/ml（企业内控，参照GB 5749）',
  },
]

export const WATER_CATEGORIES = WATER_LINES.map((line) => line.category)

// 检验人每周轮换：按 ISO 周序取模，同一条线的所有取样点当周同一检验人。
export const INSPECTOR_ROSTER = ['张敏', '李建华', '王晓东', '陈丽']

export function waterLine(category: string): WaterLine | undefined {
  return WATER_LINES.find((line) => line.category === category)
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

export function isoWeek(dateText: string): number {
  const d = new Date(`${dateText}T00:00:00Z`)
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7))
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  return Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
}

export function weekdayOf(dateText: string): number {
  return new Date(`${dateText}T00:00:00Z`).getUTCDay()
}

/** 某条水线在指定日期当值的检验人（按周轮换）。 */
export function inspectorOn(category: string, dateText: string): string {
  const lineIndex = WATER_LINES.findIndex((line) => line.category === category)
  const offset = (lineIndex >= 0 ? lineIndex : 0) + isoWeek(dateText)
  return INSPECTOR_ROSTER[((offset - 1) % INSPECTOR_ROSTER.length + INSPECTOR_ROSTER.length) % INSPECTOR_ROSTER.length]
}

/** 取样日期必须与该线班次（固定星期）对齐，否则给出原因；对齐返回空串。 */
export function shiftMismatch(category: string, dateText: string): string {
  const line = waterLine(category)
  if (!line) {
    return `未知水系统类别「${category}」`
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) {
    return '取样日期需为 YYYY-MM-DD 格式'
  }
  if (weekdayOf(dateText) !== line.weekday) {
    return `${line.category}固定${line.weekdayLabel}${line.shift}取样，${dateText} 不是${line.weekdayLabel}，日期与班次对不上`
  }
  return ''
}

export function monthOf(dateText: string): string {
  return dateText.slice(0, 7)
}

export function periodLabel(month: string): string {
  const [year, mm] = month.split('-')
  return `${year}年${Number(mm)}月`
}

export function currentMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`
}

/** 从「≤100 CFU/ml」「85 cfu/ml（入口）」之类写法里取首个数字；历史原样文本取不到返回 null。 */
export function numericValue(text: string | number | boolean | undefined | null): number | null {
  if (text === undefined || text === null || String(text).trim() === '') {
    return null
  }
  const matched = String(text).match(/-?\d+(?:\.\d+)?/)
  return matched ? Number(matched[0]) : null
}

export function conductivityOk(category: string, text: string | number | boolean | undefined | null): boolean {
  const line = waterLine(category)
  const value = numericValue(text)
  if (!line || value === null) {
    return true // 历史记录电导率按原样保留，纯文本旧值不参与越界判定
  }
  return value <= line.limits.conductivityMax
}

export function tocOk(category: string, text: string | number | boolean | undefined | null): boolean {
  const line = waterLine(category)
  if (!line || !line.limits.tocApplicable) {
    return true
  }
  const value = numericValue(text)
  if (value === null) {
    return true
  }
  return value <= line.limits.tocMax
}

export function bioburdenOk(category: string, text: string | number | boolean | undefined | null): boolean {
  const line = waterLine(category)
  const value = numericValue(text)
  if (!line || value === null) {
    return true
  }
  return value <= line.limits.bioburdenMax
}

export function formatConductivity(value: number): string {
  return `${value} µS/cm`
}

export function formatToc(value: number): string {
  return `${value.toFixed(2)} mg/L`
}

export function formatBioburden(value: number): string {
  return `${value} CFU/ml`
}
