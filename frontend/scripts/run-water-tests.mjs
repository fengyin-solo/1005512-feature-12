#!/usr/bin/env node
/**
 * 水系统领域规则回归测试：用 esbuild（vite 自带依赖）把 TS 测试 bundle 成 CJS 后执行。
 * 用法：node scripts/run-water-tests.mjs
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { rmSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outfile = resolve(root, 'node_modules/.cache/water-test.cjs')

await build({
  entryPoints: [resolve(here, 'water-test.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  alias: { '@': resolve(root, 'src') },
  logLevel: 'warning',
})

try {
  process.argv[1] = outfile
  await import(outfile)
} finally {
  rmSync(outfile, { force: true })
}
