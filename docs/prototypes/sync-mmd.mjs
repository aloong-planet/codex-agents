#!/usr/bin/env node
// 画廊基建(正本在 prototype skill 目录,项目内为复制实例):
// 扫描本目录下各原型目录的 *.mmd(一图一文件,首行可写 `%% title: 标题`),
// 为每个含 .mmd 的目录生成 model.mmd.js(派生文件,勿手改)。
// 改了 .mmd 后重跑:node docs/prototypes/sync-mmd.mjs
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, basename, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const dirs = new Map()

function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'vendor' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.name.endsWith('.mmd')) {
      const list = dirs.get(dir) ?? []
      list.push(p)
      dirs.set(dir, list)
    }
  }
}
walk(ROOT)

for (const [dir, files] of dirs) {
  const entries = files.sort().map((f) => {
    const src = readFileSync(f, 'utf8').trim()
    const m = src.match(/^%%\s*title:\s*(.+)$/m)
    return { title: m ? m[1].trim() : basename(f, '.mmd'), src }
  })
  const key = relative(ROOT, dir).split(sep).join('/')
  const out =
    '// 派生文件:由 sync-mmd.mjs 从本目录 *.mmd 生成,勿手改;改图请改 .mmd 后重跑脚本。\n' +
    'window.MERMAID_SOURCES = window.MERMAID_SOURCES || {};\n' +
    `window.MERMAID_SOURCES[${JSON.stringify(key)}] = ${JSON.stringify(entries, null, 2)};\n`
  writeFileSync(join(dir, 'model.mmd.js'), out)
  console.log(`sync: ${key} ← ${files.map((f) => basename(f)).join(', ')}`)
}
if (!dirs.size) console.log('未发现 .mmd 文件')
