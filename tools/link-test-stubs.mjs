#!/usr/bin/env node
/**
 * 把 `test/fixtures/stubs` 链接到本包的 `node_modules`，让 `host.test.mjs`
 * 能解析到 `@earendil-works/pi-ai` 等宿主提供的包。
 *
 * 为什么要一个脚本而不是在测试里 `mkdir` + `writeFile`：
 *   - Windows 上建立目录链接要 `mklink /J`（junction，不需要管理员权限），
 *     POSIX 上是 `symlink`；两条路径放一处，测试只负责调用；
 *   - 测试结束后必须能干净拆除，否则 `node_modules` 里的假包会污染
 *     `pnpm install`（它会以为这些依赖已存在）。
 *
 * 用法：
 *   node tools/link-test-stubs.mjs
 *   node tools/link-test-stubs.mjs --clean
 */

import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, rmdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const stubs = join(root, 'test', 'fixtures', 'stubs')
const target = join(root, 'node_modules')

/** 桩提供哪些包（必须与 `test/fixtures/stubs` 下的目录一致）。 */
const PACKAGES = [
  '@earendil-works/pi-ai',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/schemastery',
]

const clean = process.argv.includes('--clean')

if (clean) {
  for (const name of PACKAGES) {
    const path = join(target, name)
    if (!existsSync(path) && !isLink(path)) continue
    removeLink(path)
    process.stdout.write(`removed ${name}\n`)
  }
  // 收掉空掉的 scope 目录与 node_modules。
  for (const scope of uniqueScopes()) {
    removeIfEmpty(join(target, scope))
  }
  removeIfEmpty(target)
  process.stdout.write('clean\n')
  process.exit(0)
}

if (!existsSync(stubs)) {
  process.stderr.write(`stubs are missing: ${stubs}\n`)
  process.exit(1)
}
mkdirSync(target, { recursive: true })

for (const name of PACKAGES) {
  const source = join(stubs, name)
  const destination = join(target, name)
  if (!existsSync(source)) {
    process.stderr.write(`stub is missing: ${source}\n`)
    process.exit(1)
  }
  mkdirSync(dirname(destination), { recursive: true })
  if (existsSync(destination) || isLink(destination)) {
    process.stdout.write(`already linked ${name}\n`)
    continue
  }
  linkDirectory(source, destination)
  process.stdout.write(`linked ${name}\n`)
}

process.stdout.write('done\n')

/* ------------------------------------------------------------------ */

function uniqueScopes() {
  return [...new Set(PACKAGES.map((name) => name.split('/')[0]))]
}

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * 建目录链接。
 *
 * Windows 上 `symlinkSync` 默认要管理员权限或开发者模式，所以改用
 * `mklink /J`（junction）：它不需要特权，而 ESM 解析与它配合得很好。
 */
function linkDirectory(source, destination) {
  if (process.platform === 'win32') {
    execFileSync('cmd', ['/c', 'mklink', '/J', destination, source], { stdio: 'ignore' })
    return
  }
  symlinkSync(source, destination, 'dir')
}

/**
 * 拆链接。
 *
 * junction 必须用 `rmdir` 移除——`rm -rf` 会顺着链接把**源目录**删掉，
 * 那会把测试夹具连同源码一起毁掉。POSIX 上 `unlink` 只移除链接本身。
 *
 * 一个重要细节：Windows 的 junction 用 `lstatSync().isSymbolicLink()`
 * 判定为 `true`（它是重解析点），但用 `rmSync(..., {recursive:false})`
 * 移除会报 `EISDIR`。所以先按链接处理，失败再退回普通删除。
 */
function removeLink(path) {
  if (process.platform === 'win32') {
    try {
      execFileSync('cmd', ['/c', 'rmdir', path], { stdio: 'ignore' })
      return
    } catch {
      // 不是 junction / 已经是普通目录：落到下面的通用路径。
    }
  }
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // 已经消失。
  }
}

/**
 * 删掉一个**空**目录。
 *
 * `rmSync(dir, { recursive: false })` 在 Node 里对目录会抛 `ERR_FS_EISDIR`
 * ——它只删文件。目录必须走 `rmdirSync`。这个细节不写清楚，`--clean` 会
 * 留下一个空的 `node_modules`，而 `pnpm install` 看到它会以为依赖已装好。
 */
function removeIfEmpty(path) {
  try {
    if (readdirSync(path).length === 0) rmdirSync(path)
  } catch {
    // 不存在或非空：都不需要处理。
  }
}
