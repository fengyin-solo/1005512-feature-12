import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'pharma-cleanroom:entries'
// 水系统分册外发台账：同一条取样记录重复导出只算一次，按记录编号去重。
const WATER_LEDGER_KEY = 'pharma-cleanroom:water-export-ledger'

export type WaterExportLedgerEntry = {
  recordId: number
  category: string
  point: string
  sampleDate: string
  firstExportAt: string
  exportCount: number
}

type WaterExportLedger = Record<string, WaterExportLedgerEntry>

function readLedger(): WaterExportLedger {
  if (typeof window === 'undefined' || !window.localStorage) {
    return {}
  }
  const raw = window.localStorage.getItem(WATER_LEDGER_KEY)
  if (!raw) {
    return {}
  }
  try {
    return JSON.parse(raw) as WaterExportLedger
  } catch {
    return {}
  }
}

let ledgerCache: WaterExportLedger | null = null

function saveLedger(): void {
  if (typeof window !== 'undefined' && window.localStorage && ledgerCache) {
    window.localStorage.setItem(WATER_LEDGER_KEY, JSON.stringify(ledgerCache))
  }
}

// 批量登记外发：已外发过的记录只累加次数、首次外发时间不动，返回去重后的台账视图。
export function markWaterExports(
  records: { id: number; category: string; point: string; sampleDate: string }[],
  exportedAt: string,
): WaterExportLedgerEntry[] {
  if (ledgerCache === null) {
    ledgerCache = readLedger()
  }
  for (const record of records) {
    const key = String(record.id)
    const existing = ledgerCache[key]
    if (existing) {
      existing.exportCount += 1
    } else {
      ledgerCache[key] = {
        recordId: record.id,
        category: record.category,
        point: record.point,
        sampleDate: record.sampleDate,
        firstExportAt: exportedAt,
        exportCount: 1,
      }
    }
  }
  saveLedger()
  return listWaterLedger()
}

export function listWaterLedger(): WaterExportLedgerEntry[] {
  if (ledgerCache === null) {
    ledgerCache = readLedger()
  }
  return Object.values(ledgerCache).sort(
    (a, b) => a.firstExportAt.localeCompare(b.firstExportAt) || a.recordId - b.recordId,
  )
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
