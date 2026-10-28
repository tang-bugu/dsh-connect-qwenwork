#!/usr/bin/env node
/**
 * 校验 `git tag` 与 `package.json` 的 `version` 是否一致。
 *
 * ## 为什么需要它
 *
 * 发布是从 tag 触发的（`.github/workflows/release.yml`），但 npm 发布的版本号
 * 来自 `package.json`。两者脱节时会出现最坏的一种状态：**tag 叫 `v0.2.0`，
 * 而 npm 上出现的是 `0.1.0`**——发布"成功"，记录也对得上 tag，但 npm 上那个
 * 版本号与任何人都以为的不一样，而且已经不可撤销。
 *
 * 这类错误无法在事后修复（npm 不允许覆盖已发布版本），只能在发布前挡下，
 * 所以它是一道硬门禁。
 *
 * 用法：
 *   node scripts/check-version.mjs v0.2.0     # 校验 tag 与 package.json 一致
 *   node scripts/check-version.mjs --print    # 只打印当前版本号
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packagePath = resolve(here, '..', 'package.json')
const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))

const args = process.argv.slice(2)

if (args.includes('--print')) {
  process.stdout.write(`${pkg.version}\n`)
  process.exit(0)
}

const tag = args.find((item) => !item.startsWith('-'))

if (tag === undefined) {
  process.stderr.write('usage: node scripts/check-version.mjs <tag> | --print\n')
  process.exit(2)
}

// 接受 `v1.2.3` 与 `1.2.3` 两种写法：前者是本仓库的约定，后者是
// `npm version` 在某些配置下的默认形态。两者都指向同一个版本。
const expected = tag.replace(/^v/, '')

if (pkg.version !== expected) {
  process.stderr.write(
    `tag/version mismatch\n`
    + `  tag            ${tag}  (-> ${expected})\n`
    + `  package.json   ${pkg.version}\n`
    + `\n`
    + `Both must name the same version, because the tag is what this workflow\n`
    + `triggers on while package.json is what npm actually publishes. A mismatch\n`
    + `would publish a version number nobody asked for, and npm does not allow a\n`
    + `published version to be overwritten.\n`
    + `\n`
    + `Fix it with:  npm version ${expected}   (rewrites package.json and tags)\n`,
  )
  process.exit(1)
}

process.stdout.write(`version ok: ${pkg.version}\n`)
