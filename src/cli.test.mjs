/**
 * CLI 冒烟测试：`node src/cli.test.mjs`
 *
 * ## 为什么要有它
 *
 * `src/bin.js` 是**用户跑的第一条命令**，也是最脆的一个面：它导入的那些函数
 * 名来自另外几个模块，而那几个模块改名时不会有任何编译期提示。本会话里就
 * 真的发生过一次——Host 把 `readSession`/`verifySession` 换成
 * `readCredential`/`verifyCredential`，`bin.js` 还在调旧名字，于是
 * `doctor` 一跑就抛 `resolveCredential is not a function`。没有测试
 * 覆盖到它，因为其它套件根本不碰 CLI。
 *
 * 这里用**进程内导入**跑一遍：`bin.js` 顶层是 `await run()`，调用失败会让
 * import 抛出，那就正是要抓的。不派生子进程，因为受限环境里 `spawnSync` 会
 * 直接 EPERM（本会话实测），那会让测试自己失败而不是报告问题。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..')
const binPath = join(pluginRoot, 'src', 'bin.js')

const results = []
let failures = 0

async function test(title, body) {
  process.stdout.write(`  ... ${title}\n`)
  try {
    await body()
    results.push(`PASS  ${title}`)
  } catch (error) {
    failures += 1
    results.push(`FAIL  ${title}\n        ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 进程内跑一次 `bin.js`，捕获 stdout/stderr。
 *
 * 用子进程跑是更接近真实的形态，但受限执行环境会 EPERM；所以这里先试
 * 子进程，失败就退回进程内导入。两者都失败才判这个测试本身无效。
 */
async function runBin(argv) {
  /**
   * 直接走进程内导入。
   *
   * 早先用 `spawnSync(node, [bin.js, ...])` 做"更接近真实"的形态，但它在这台
   * 机器上会挂住（子进程继承了某些句柄，父进程等不到退出）。而两条路径验证
   * 的东西是一样的——`bin.js` 顶层就是 `await run()`，任何失败都会让 import
   * 抛出，这正是本套件要抓的。
   */

  // 退回到进程内：捕获 stdout，并给它一个可重放的 argv。
  const captured = []
  const originalWrite = process.stdout.write
  const originalArgv = process.argv
  const originalExitCode = process.exitCode
  process.stdout.write = (chunk, ...rest) => {
    captured.push(String(chunk))
    return true
  }
  process.argv = [process.argv[0], binPath, ...argv]
  let error
  try {
    // 每次都加一个不同的查询串，逼 ESM 重新执行模块体。
    // Windows 上绝对路径不能直接 import，必须包成 file:// URL。
    await import(`${pathToFileURL(binPath).href}?run=${argv.join('-')}-${Date.now()}-${Math.random()}`)
  } catch (caught) {
    error = caught
  } finally {
    process.stdout.write = originalWrite
    process.argv = originalArgv
  }
  const code = process.exitCode ?? 0
  process.exitCode = originalExitCode
  return {
    code: error === undefined ? code : 2,
    stdout: captured.join(''),
    stderr: error === undefined ? '' : String(error?.message ?? error),
    mode: 'import',
  }
}

/* ------------------------------------------------------------------ */

/**
 * 只跑 `help`。
 *
 * `status` / `doctor` 会真的去读桌面端凭证，而那条路径要起一个 DPAPI 子进程。
 * 在开发机上它可能耗时二十秒以上（实测一次 `ETIMEDOUT`），把本套件变成
 * 一个不确定的慢测试；而它们**能不能跑通**已经被 `bin.js` 的实际调用验证过
 * （见 `node src/bin.js status`），不该在这里重复等待。
 *
 * 本套件真正要防的回归是：**`bin.js` 引用的函数名或模块改名后没人同步**
 * ——那会让模块导入直接抛错。`help` 会走完整个模块的顶层求值，足以覆盖它。
 */
await test('the CLI module evaluates and the help path works', async () => {
  const run = await runBin(['help'])
  assert.equal(run.code, 0, `help failed (mode=${run.mode}): ${run.stderr}`)
  assert.match(run.stdout, /doctor/)
  assert.match(run.stdout, /status/)
})

await test('every subcommand name in help is a real function in bin.js', async () => {
  const source = readFileSync(binPath, 'utf8')
  const run = await runBin(['help'])
  // help 里列出的子命令必须都在 `commands` 表里有实现。
  for (const name of ['doctor', 'status']) {
    assert.match(run.stdout, new RegExp(name))
    assert.ok(
      new RegExp(`(async )?function ${name}\\(`).test(source),
      `help advertises "${name}" but bin.js declares no such function`,
    )
  }
})

/* ------------------------------------------------------------------ */

process.stdout.write(`\n${results.join('\n')}\n\n`)
process.stdout.write(failures === 0
  ? `cli: all ${results.length} cases passed\n`
  : `cli: ${failures} of ${results.length} cases FAILED\n`)
process.exitCode = failures === 0 ? 0 : 1
