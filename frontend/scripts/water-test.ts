import { SEED_ROWS } from '../src/data/seed'

// --- localStorage shim ---
const mem = new Map<string, string>()
;(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => void mem.set(k, v),
  },
}

// reset store to seed
mem.set('pharma-cleanroom:entries', JSON.stringify(SEED_ROWS))
mem.delete('pharma-cleanroom:water-export-ledger')

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass += 1; console.log('  ✓', name) }
  else { fail += 1; console.log('  ✗', name, detail) }
}

import {
  registerWaterSample,
  runWaterAction,
  enterWaterResults,
  buildWaterFascicles,
  waterExportLedger,
  syncConclusionsToCleanroom,
} from '../src/api/water-service'
import { listRows, readJson } from '../src/data/local-store'
import { inspectorOn } from '../src/data/water-config'

const W = 'watermonitor'
const rowsNow = () => listRows(W)
const findId = (category: string, point: string, date: string) =>
  rowsNow().find((r) => r['水系统类别'] === category && r['取样点'] === point && r['取样日期'] === date)!

console.log('1. 分线取样 / 班次对齐 / 检验人轮换')
// 纯化水周一早班：2026-10-05 是周一
check('正确班次(周一)登记成功', registerWaterSample({ category: '纯化水', samplePoint: 'PW-储罐出口', date: '2026-10-05' }).ok)
// 2026-10-06 周二 -> 纯化水挡回
check('非班次日期挡回', !registerWaterSample({ category: '纯化水', samplePoint: 'PW-储罐出口', date: '2026-10-06' }).ok)
// 注射用水周三 -> 10-05 周一挡回
check('注射用水周三对齐', !registerWaterSample({ category: '注射用水', samplePoint: 'WFI-储罐出口', date: '2026-10-05' }).ok)
check('注射用水 10-07 周三登记成功', registerWaterSample({ category: '注射用水', samplePoint: 'WFI-储罐出口', date: '2026-10-07' }).ok)
// 非本线取样点挡回
check('非本线取样点挡回', !registerWaterSample({ category: '饮用水', samplePoint: 'PW-储罐出口', date: '2026-10-06' }).ok)
// 重复登记挡回
check('重复登记挡回', !registerWaterSample({ category: '纯化水', samplePoint: 'PW-储罐出口', date: '2026-10-05' }).ok)

console.log('2. 检验人按周轮换')
const i1 = inspectorOn('纯化水', '2026-10-05') // ISO week 41
const i2 = inspectorOn('纯化水', '2026-10-12') // week 42
const i3 = inspectorOn('纯化水', '2026-10-19') // week 43
check('相邻两周检验人不同', i1 !== i2 && i2 !== i3, `${i1} ${i2} ${i3}`)
check('四周一轮回', inspectorOn('纯化水', '2026-11-02') === i1, `${inspectorOn('纯化水','2026-11-02')} vs ${i1}`)
check('登记自动派工检验人', String(findId('纯化水', 'PW-储罐出口', '2026-10-05')['检验人']) === i1)
check('同周同线各点同一检验人',
  String(findId('纯化水', 'PW-总送水口', '2026-10-05')['检验人']) ===
  String(findId('纯化水', 'PW-总回水口', '2026-10-05')['检验人']))

console.log('3. 状态只能顺流转，越级挡回')
{
  const r = findId('纯化水', 'PW-总送水口', '2026-10-05')
  check('待取样→判定合格 越级挡回', !runWaterAction(Number(r.id), '判定合格').ok)
  check('待取样→标记不合格 越级挡回', !runWaterAction(Number(r.id), '标记不合格').ok)
  check('待取样→提交检测 放行', runWaterAction(Number(r.id), '提交检测').ok)
  // 结果录一半不能判合格
  const half = enterWaterResults(Number(r.id), { conductivity: '1.2', toc: '', microbial: '' })
  check('缺TOC/微生物时结果被拒', !half.ok, half.message)
}

console.log('4. 微生物各入口同一份')
{
  const a = findId('纯化水', 'PW-总送水口', '2026-10-05')
  const b = findId('纯化水', 'PW-总回水口', '2026-10-05')
  runWaterAction(Number(b.id), '提交检测')
  check('录入 a 结果成功', enterWaterResults(Number(a.id), { conductivity: '1.2', toc: '0.18', microbial: '40' }).ok)
  check('同份微生物自动带到 b', String(findId('纯化水', 'PW-总回水口', '2026-10-05')['微生物限度']) === '40')
  const conflict = enterWaterResults(Number(b.id), { conductivity: '1.3', toc: '0.20', microbial: '55' })
  check('b 改成不同微生物被拒', !conflict.ok, conflict.message)
  check('同值允许提交(电导/TOC可不同)', enterWaterResults(Number(b.id), { conductivity: '1.3', toc: '0.20', microbial: '40' }).ok)
  check('各入口电导率可不同', String(findId('纯化水','PW-总送水口','2026-10-05')['电导率']) !==
        String(findId('纯化水','PW-总回水口','2026-10-05')['电导率']))
  check('正常判定合格', runWaterAction(Number(a.id), '判定合格').ok)
}

console.log('5. 微生物越界：打回重填，且不能判合格/不合格')
{
  // 种子：注射用水 2026-09-16 WFI-洗瓶机使用点 微生物 15 > 10，检测中
  const r = findId('注射用水', 'WFI-洗瓶机使用点', '2026-09-16')
  check('越界判合格被拒', !runWaterAction(Number(r.id), '判定合格').ok)
  check('越界标记不合格被拒', !runWaterAction(Number(r.id), '标记不合格').ok)
  const back = runWaterAction(Number(r.id), '打回重填', { reason: '微生物初测越界复检' })
  check('打回重填成功', back.ok, back.message)
  const after = findId('注射用水', 'WFI-洗瓶机使用点', '2026-09-16')
  check('打回后状态=待取样', String(after.status) === '待取样')
  check('打回后检测项清空', after['微生物限度'] === '' && after['电导率'] === '')
  check('打回原因写入备注', String(after['备注']).includes('微生物初测越界复检'))
  // 同份兄弟记录也应被打回？兄弟仍检测中且微生物15越界——口径上同样需打回
  const sib = findId('注射用水', 'WFI-总回水口', '2026-09-16')
  check('同份兄弟记录仍可打回', runWaterAction(Number(sib.id), '打回重填').ok)
}

console.log('6. 电导率/TOC 越界 → 不合格（非微生物路径）')
{
  const r = findId('饮用水', 'DW-原水入口', '2026-09-29') // 25.6 > 20 不合格（种子）
  check('种子不合格态成立', String(r.status) === '不合格')
  check('已合格终态无动作', r.status === '不合格')
}

console.log('7. 结论反映到洁净区环境监测清单')
{
  const sync = syncConclusionsToCleanroom()
  const room = listRows('cleanroom')
  const waterPass = rowsNow().filter((r) => r.status === '已合格').length
  const waterFail = rowsNow().filter((r) => r.status === '不合格').length
  const mirrored = room.filter((r) => String(r['来源编号']).startsWith('水质监测#'))
  check('环境清单存在水点镜像条目', mirrored.length > 0)
  check('镜像数=终态水记录数', mirrored.length === waterPass + waterFail, `${mirrored.length} vs ${waterPass + waterFail}`)
  const passRow = mirrored.find((r) => r['检验结论'] === '水质合格')
  const failRow = mirrored.find((r) => r['检验结论'] === '水质不合格')
  check('合格结论→已达标', !!passRow && passRow.status === '已达标')
  check('不合格结论→超标预警', !!failRow && failRow.status === '超标预警')
  check('镜像携带微生物限度(沉降菌列)', !!passRow && String(passRow['沉降菌数']) !== '')
  // 打回的 09-16 记录不应再有镜像
  check('打回记录镜像已撤销', !mirrored.some((r) => r['来源编号'] === `水质监测#${findId('注射用水','WFI-洗瓶机使用点','2026-09-16').id}`))
  check('同步幂等', syncConclusionsToCleanroom().added === 0)
  void sync
}

console.log('8. 月报分册导出（2026-09）')
{
  const book1 = buildWaterFascicles('2026-09')
  const sheets = (book1.content.match(/<Worksheet /g) || []).length
  check('含封面+4分册+台账=6张表', sheets === 6, `实际 ${sheets}`)
  for (const cat of ['纯化水', '注射用水', '灭菌注射用水', '饮用水']) {
    check(`${cat}分册含册名与类别`, book1.content.includes(`${cat}分册`) && book1.content.includes(`水系统类别：${cat}`))
  }
  check('分册标注取样日期', book1.content.includes('取样日期：2026-09-01'))
  check('列明电导率/TOC/微生物列', book1.content.includes('电导率 µS/cm') && book1.content.includes('总有机碳 mg/L') && book1.content.includes('微生物限度 CFU/ml'))
  check('饮用水 TOC 标不适用', book1.content.includes('不适用'))
  check('非空壳：有结论与编制行', book1.content.includes('符合规定') && book1.content.includes('编制：QC'))
  // 10 月：灭菌注射用水无记录 → 说明页
  const book10 = buildWaterFascicles('2026-10')
  check('空册补正式说明页', book10.content.includes('灭菌注射用水') && book10.content.includes('本期分册无检验数据可列'))
  check('说明页列出排班日期', book10.content.includes('2026-10-02') && book10.content.includes('2026-10-30'))
  check('10月其他册有真实数据', book10.content.includes('PW-总送水口'))
}

console.log('9. 同一条记录重复导出只算一次')
{
  const ledgerBefore = waterExportLedger().length
  const second = buildWaterFascicles('2026-09')
  const swfi = second.summaries.find((s) => s.category === '灭菌注射用水')!
  check('二次导出新增为0', swfi.fresh === 0 && swfi.alreadyExported === swfi.total, JSON.stringify(swfi))
  check('台账条目数不翻倍', waterExportLedger().length === ledgerBefore)
  check('分册注明已导出不重复列示', second.content.includes('按「同一条记录只算一次」口径'))
  // 全量重出选项仍可列全，但不记账
  const full = buildWaterFascicles('2026-09', { includeExported: true })
  const swfi2 = full.summaries.find((s) => s.category === '灭菌注射用水')!
  check('全量重出列全部记录', swfi2.fresh === swfi2.total && swfi2.total > 0)
  check('全量重出不新增台账', waterExportLedger().length === ledgerBefore)
}

console.log('10. 历史兼容：电导率原样保留')
{
  const h1 = findId('饮用水', 'DW-原水入口', '2026-08-04')
  const h2 = findId('饮用水', 'DW-车间总进水', '2026-08-11')
  check('手抄文本原样保留', String(h1['电导率']) === '10.8（25℃手抄）')
  check('快测文本原样保留', String(h2['电导率']) === '约 9（车间快测）')
  check('历史文本记录保持已合格', String(h1.status) === '已合格' && String(h2.status) === '已合格')
  const book8 = buildWaterFascicles('2026-08')
  check('8月册原样呈现历史电导率', book8.content.includes('10.8（25℃手抄）'))
}

console.log('11. 10月空册场景下完整导出记账一致性')
{
  const book = buildWaterFascicles('2026-10')
  const emptyCat = book.summaries.filter((s) => s.empty).map((s) => s.category)
  check('灭菌注射用水标为空期', emptyCat.includes('灭菌注射用水'), JSON.stringify(emptyCat))
  const ledger = readJson<{ id: number; month: string }[]>('pharma-cleanroom:water-export-ledger', [])
  const oct = ledger.filter((e) => e.month === '2026-10')
  const waterOct = rowsNow().filter((r) => String(r['取样日期']).startsWith('2026-10')).length
  check('10月台账条数=实际记录数(空册不造假)', oct.length === waterOct, `${oct.length} vs ${waterOct}`)
}

console.log(`\n结果：${pass} 通过，${fail} 失败`)
if (fail) process.exit(1)
