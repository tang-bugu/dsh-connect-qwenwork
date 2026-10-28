/**
 * 宿主装配自测：`node src/host.test.mjs`
 *
 * 这一条测的不是协议，而是**装配**：`apply()` 在模拟的 Cordis 上下文里
 * 是否真的把 provider 注册上去了。
 *
 * 为什么需要它。前面几条测试都只到"桥/客户端单独能用"，而插件最常见的
 * 失败恰恰是装配层的静默错误——注册方法没被调用、命名空间算错、惰性导入
 * 写错导致整块被跳过。这类错误在单元测试里看不出来，只在真机上表现为
 * "装好了但模型列表是空的"。
 *
 * 本文件先调 `tools/link-test-stubs.mjs` 把桩包链接进 `node_modules`，
 * 跑完再拆掉——这样 `node src/host.test.mjs` 一条命令就能跑，不需要读者
 * 先做任何环境准备。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..')
const linkScript = join(pluginRoot, 'tools', 'link-test-stubs.mjs')

/** 建好桩链接，跑完无论成败都拆掉。 */
execFileSync(process.execPath, [linkScript], { stdio: 'ignore' })

try {
  await runTests()
} finally {
  try {
    execFileSync(process.execPath, [linkScript, '--clean'], { stdio: 'ignore' })
  } catch {
    // 拆除失败不该掩盖测试结果；下一次运行会重建。
  }
}

async function runTests() {
  const { apply, name, inject, settingsNamespaceOf, Config, QWENWORK_PROVIDER } = await import('./index.js')

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
 * 一个最小的 Cordis 上下文替身。
 *
 * 只实现 `apply()` 用到的四个 API：`logger`、`fiber`、`effect`、`inject`。
 * `inject` 会同步回调（与 Cordis 的行为一致），因此本测试不需要等待。
 *
 * `cleanups` 收集 `ctx.effect` 注册的拆除函数：每次 `apply()` 都会起一个
 * 回环桥，测试结束必须真的关掉它，否则端口与 socket 累积，进程不会退出。
 */
function makeContext() {
  const registered = { adapters: [], directory: [], discovery: [], settings: [], effects: [] }
  const warnings = []
  const cleanups = []
  const context = {
    logger: {
      warn: (message, error) => warnings.push({ message, error }),
      error: (message, error) => warnings.push({ message, error }),
    },
    fiber: { entry: { options: { id: 'dsh-connect-qwenwork' } } },
    effect: (fn) => {
      registered.effects.push(fn)
      // Cordis 的 effect(fn) 返回 fn 的返回值作为 disposer；fn 本身是
      // "注册一个清理函数"。两种形状都收下来，测试结束时统一调用。
      const disposer = fn()
      if (typeof disposer === 'function') cleanups.push(disposer)
      return () => {}
    },
    inject: (names, fn) => {
      if (names.includes('llm')) {
        return fn({
          ...context,
          llm: {
            registerAdapter: (routes, adapter) => {
              registered.adapters.push({ routes, adapter })
              return () => {}
            },
            registerConfigurableProviders: (entries) => {
              registered.directory.push(...entries)
              return () => {}
            },
            registerModelDiscovery: (ns, discover) => {
              registered.discovery.push({ ns, discover })
            },
          },
        })
      }
      if (names.includes('settings')) {
        // 必须继承 `context`：插件在这个回调里调用 `ctx.effect(...)` 注册
        // 拆除逻辑。给一个字面量对象会让那次注册静默落空——测试全过，
        // 但真实的桥永远不会被关掉。
        return fn({
          ...context,
          settings: {
            configure: (options, fiber) => {
              registered.settings.push({ options, fiber })
              return () => {}
            },
          },
        })
      }
      return fn(context)
    },
  }
  return { context, registered, warnings, cleanups }
}

/**
 * 跑一次 `apply()`，返回句柄与一个负责拆除的 `dispose()`。
 *
 * 拆除顺序是有讲究的：
 *   1. 调用 `ctx.effect` 收集到的 disposer（插件自己注册的拆除逻辑，
 *      它会关掉桥与 ACP 客户端）；
 *   2. 再等一拍，让 `server.close()` 的回调真正落地。
 *
 * 注意 `apply()` 内部的 `ctx.inject(['llm'], ...)` 是**异步**回调，它注册
 * 的 effect 要到微任务之后才存在。所以这里先等 400ms 再交出去，且拆除时
 * 重新读一次 `cleanups`（它可能在那之后又长了）。
 */
async function withPlugin(config = {}, body) {
  const made = makeContext()
  const handle = apply(made.context, config)
  try {
    // 让惰性导入、桥的启动与 inject 回调里的 effect 注册都跑完。
    await new Promise((resolve) => setTimeout(resolve, 400))
    await body({ ...made, handle })
  } finally {
    // 多轮拆除：某个 cleanup 可能在运行中又注册了新的 cleanup。
    for (let round = 0; round < 3; round += 1) {
      const pending = made.cleanups.splice(0)
      if (pending.length === 0) break
      for (const cleanup of pending) {
        try {
          cleanup()
        } catch {
          // 拆除失败不应掩盖真正的断言失败。
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 60))
    }
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
}

/* ------------------------------------------------------------------ */

await test('the plugin identity is stable', () => {
  assert.equal(name, 'dsh-connect-qwenwork')
  assert.deepEqual(inject, ['llm'])
})

await test('settingsNamespaceOf prefers the loader entry id', () => {
  assert.equal(settingsNamespaceOf({ fiber: { entry: { options: { id: 'custom-id' } } } }), 'custom-id')
})

await test('settingsNamespaceOf falls back when the host has no loader entry', () => {
  assert.equal(settingsNamespaceOf({}), 'dsh-connect-qwenwork')
  assert.equal(settingsNamespaceOf(undefined), 'dsh-connect-qwenwork')
})

await test('apply() registers exactly one provider route named qwenwork', async () => {
  await withPlugin({}, async ({ registered }) => {
    assert.equal(registered.adapters.length, 1)
    assert.deepEqual(registered.adapters[0].routes, [QWENWORK_PROVIDER])
  })
})

await test('apply() publishes a configurable-provider entry', async () => {
  await withPlugin({}, async ({ registered }) => {
    assert.equal(registered.directory.length, 1)
    assert.equal(registered.directory[0].provider, QWENWORK_PROVIDER)
    assert.equal(registered.directory[0].settingsNs, 'dsh-connect-qwenwork')
  })
})

await test('apply() registers model discovery under the same namespace', async () => {
  await withPlugin({}, async ({ registered }) => {
    assert.equal(registered.discovery.length, 1)
    assert.equal(registered.discovery[0].ns, 'dsh-connect-qwenwork')
  })
})

await test('model discovery returns the documented fallback catalog', async () => {
  await withPlugin({}, async ({ registered }) => {
    const models = await registered.discovery[0].discover({ provider: QWENWORK_PROVIDER })
    assert.ok(models.length >= 4)
    const ids = models.map((model) => model.id)
    for (const expected of ['advanced', 'basic', 'economy', 'qwen3.8-max']) {
      assert.ok(ids.includes(expected), `expected ${expected} in ${ids.join(',')}`)
    }
    assert.ok(models.every((model) => model.contextWindow > 0 && model.maxTokens > 0))
  })
})

await test('model discovery ignores another provider', async () => {
  await withPlugin({}, async ({ registered }) => {
    assert.deepEqual(await registered.discovery[0].discover({ provider: 'somebody-else' }), [])
  })
})

await test('apply() wires the settings auto-configuration', async () => {
  await withPlugin({}, async ({ registered }) => {
    assert.equal(registered.settings.length, 1)
    assert.deepEqual(registered.settings[0].options, { auto: true })
  })
})

await test('the returned handle exposes a read-only status', async () => {
  await withPlugin({}, async ({ handle }) => {
    const status = handle.status()
    assert.equal(status.enabled, true)
    assert.ok(Array.isArray(status.catalog))
    assert.ok(status.catalog.length >= 4)
    assert.equal(status.settingsNs, 'dsh-connect-qwenwork')
  })
})

await test('the bridge actually listens once apply() runs', async () => {
  await withPlugin({}, async ({ handle }) => {
    const status = handle.status()
    assert.ok(status.bridge !== undefined, 'the bridge must have started')
    const response = await fetch(`http://127.0.0.1:${status.bridge.port}/healthz`)
    assert.equal(response.status, 200)
    // `fetch` 会把连接留在 keep-alive 池里，而那个池持有 ref'd 的 socket；
    // 不主动收掉，测试进程会在所有断言通过之后继续存活。
    await response.body?.cancel()
  })
})

await test('a disabled plugin reports enabled:false', async () => {
  await withPlugin({ enabled: false }, async ({ handle }) => {
    assert.equal(handle.status().enabled, false)
  })
})

await test('the config schema declares every field the code reads', () => {
  for (const field of ['token', 'enabled', 'defaultModelId', 'allowFallbackCatalog', 'desktopAuthDir']) {
    assert.ok(Config.properties[field] !== undefined, `missing schema field ${field}`)
  }
})

/* ------------------------------------------------------------------ */

process.stdout.write(`\n${results.join('\n')}\n\n`)
process.stdout.write(failures === 0
  ? `host: all ${results.length} cases passed\n`
  : `host: ${failures} of ${results.length} cases FAILED\n`)
if (failures !== 0) process.exitCode = 1
}
