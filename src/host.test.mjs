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
  const {
    apply, name, inject, settingsNamespaceOf, Config, QWENWORK_PROVIDER,
    QWENWORK_RESTART_PATH, QWENWORK_RELOAD_PATH, QWENWORK_STATUS_PATH, QWENWORK_STREAM_IDLE_TIMEOUT_MS, isSameOriginRequest,
  } = await import('./index.js')

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
function makeContext(options = {}) {
  const registered = { adapters: [], directory: [], discovery: [], settings: [], effects: [], routes: [] }
  const warnings = []
  const cleanups = []
  const context = {
    logger: {
      warn: (message, error) => warnings.push({ message, error }),
      error: (message, error) => warnings.push({ message, error }),
    },
    fiber: { entry: { options: { id: 'dsh-connect-qwenwork' } } },
    /**
     * Cordis 的 `ctx.get(name)`。插件只用它取 `hmr` 服务——"快捷重启"
     * 能不能用完全取决于这一项，所以测试要能分别给出"有"和"没有"。
     */
    get: (name) => (name === 'hmr' ? options.hmr : undefined),
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
      if (names.includes('webServer')) {
        return fn({
          ...context,
          webServer: {
            register: (route) => {
              registered.routes.push(route)
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
 * 一个最小的 HTTP 响应替身。
 *
 * 路由处理器只需要 `writeHead(status, headers)` 与 `end(body)`：`writeJson`
 * 就是这么写的。把它收到的东西原样交回，断言只看状态码与响应体。
 */
function fakeResponse() {
  const captured = { status: undefined, headers: undefined, body: undefined }
  const res = {
    writeHead: (status, headers) => {
      captured.status = status
      captured.headers = headers
    },
    end: (body) => {
      captured.body = body
    },
  }
  return { res, captured }
}

/** 一个来自回环页面、与宿主同源的 POST 请求替身。 */
function sameOriginPost(host = '127.0.0.1:7448') {
  return {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host, origin: `http://${host}` },
  }
}

/** 一个来自回环页面、但 Origin 是别的站点的 POST 请求替身（CSRF 形状）。 */
function crossOriginPost(host = '127.0.0.1:7448') {
  return {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host, origin: 'https://evil.example' },
  }
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
async function withPlugin(config = {}, body, options = {}) {
  const made = makeContext(options)
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

/* ------------------------------------------------------------------ *
 * pi-ai 适配器契约
 * ------------------------------------------------------------------ */

await test('the pi-ai profile carries every field the host reads at request time', async () => {
  await withPlugin({}, async ({ registered }) => {
    const profiles = registered.adapters[0].adapter.config.profiles()
    const profile = profiles.get(QWENWORK_PROVIDER)
    assert.ok(profile !== undefined, 'the adapter must own the qwenwork route')

    // 这一条钉的是真实故障：宿主在发请求之前把 `profile.streamIdleTimeoutMs`
    // 交给 `idleWatchdog`，后者只接受「正的有限数且不超过 2^31-1」。插件是
    // 手工构造 profile 的，漏了这个字段时整条 provider 在请求发出前就失败，
    // 报 `idleWatchdog timeoutMs must be a positive finite number…`。
    assert.equal(typeof profile.streamIdleTimeoutMs, 'number')
    assert.equal(profile.streamIdleTimeoutMs, QWENWORK_STREAM_IDLE_TIMEOUT_MS)
    assert.ok(profile.streamIdleTimeoutMs > 0 && profile.streamIdleTimeoutMs <= 2_147_483_647)

    // 其余被宿主直接读取的字段：缺了不会立刻炸，但会在特定路径上变成
    // `undefined`（例如消息里带图片时的预算、重试策略）。
    assert.ok(profile.retryPolicy !== undefined, 'retryPolicy must be resolved before registration')
    assert.ok(profile.configuredMaxTokens instanceof Map)
    assert.ok(profile.modelErrors instanceof Map)
    assert.ok(profile.piProvider !== undefined, 'the host builds its model table from piProvider')
    // `profile.reasoning` 只能是档位 id（或干脆不写）：写成布尔 `false` 时宿主
    // 会把它当档位去比对，抛 `does not support reasoning effort "false"`。
    // "不支持思考"属于模型描述（`reasoning: false`），不属于 profile。
    assert.ok(
      profile.reasoning === undefined || typeof profile.reasoning === 'string',
      'profile.reasoning must be a level id or absent',
    )
    for (const field of ['maxRequestImageBytes', 'requestImagePixelBudget', 'requestImageMaxBytes']) {
      assert.ok(Number.isInteger(profile[field]) && profile[field] > 0, `${field} must be a positive integer`)
    }
  })
})

/* ------------------------------------------------------------------ *
 * 重启桥
 * ------------------------------------------------------------------ */

await test('the restart path is namespaced next to the status path', () => {
  assert.equal(QWENWORK_RESTART_PATH, '/plugins/dsh-connect-qwenwork/restart')
  assert.notEqual(QWENWORK_RESTART_PATH, QWENWORK_STATUS_PATH)
})

await test('apply() registers both the status and the restart route', async () => {
  await withPlugin({}, async ({ registered }) => {
    const paths = registered.routes.map((route) => route.path)
    assert.ok(paths.includes(QWENWORK_STATUS_PATH), `missing status route, got ${paths.join(',')}`)
    assert.ok(paths.includes(QWENWORK_RESTART_PATH), `missing restart route, got ${paths.join(',')}`)
  })
})

await test('the restart route rejects a GET and a cross-origin POST', async () => {
  await withPlugin({}, async ({ registered }) => {
    const route = registered.routes.find((item) => item.path === QWENWORK_RESTART_PATH)

    const get = fakeResponse()
    await route.handler(
      { method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:7448' } },
      get.res,
    )
    assert.equal(get.captured.status, 405)

    // 回环对端 + 回环 Host，但 Origin 是别的站点：前两条检查都会放过，
    // 只有同源检查能拦住。这正是 CSRF 的形状。
    const cross = fakeResponse()
    await route.handler(crossOriginPost(), cross.res)
    assert.equal(cross.captured.status, 403)
    assert.match(cross.captured.body, /cross-origin/)

    const remote = fakeResponse()
    await route.handler({ ...sameOriginPost(), socket: { remoteAddress: '10.0.0.7' } }, remote.res)
    assert.equal(remote.captured.status, 403)
  })
})

await test('the restart route really re-opens the bridge and returns fresh status', async () => {
  await withPlugin({}, async ({ registered, handle }) => {
    const route = registered.routes.find((item) => item.path === QWENWORK_RESTART_PATH)
    const before = handle.status().bridge
    assert.ok(before !== undefined, 'the bridge must be running before the restart')

    const io = fakeResponse()
    await route.handler(sameOriginPost(), io.res)

    assert.equal(io.captured.status, 200)
    const document = JSON.parse(io.captured.body)
    assert.equal(document.bridge.running, true)
    assert.ok(document.bridge.port > 0)
    assert.ok(Array.isArray(document.catalog) && document.catalog.length >= 4)

    // 状态句柄也必须指向新桥：重启后仍有桥在监听（端口可能变，所以只断言存在）。
    const after = handle.status().bridge
    assert.ok(after !== undefined, 'the bridge must be running after the restart')
    const health = await fetch(`http://127.0.0.1:${after.port}/healthz`)
    assert.equal(health.status, 200)
    await health.body?.cancel()
  })
})

await test('isSameOriginRequest compares Origin against Host', () => {
  assert.equal(isSameOriginRequest({ headers: { host: '127.0.0.1:7448', origin: 'http://127.0.0.1:7448' } }), true)
  assert.equal(isSameOriginRequest({ headers: { host: '127.0.0.1:7448', origin: 'https://127.0.0.1:7448' } }), true)
  assert.equal(isSameOriginRequest({ headers: { host: '127.0.0.1:7448', origin: 'https://evil.example' } }), false)
  // 没有 Origin 的 POST：不是浏览器发的（curl / 本地脚本），放行。
  assert.equal(isSameOriginRequest({ headers: { host: '127.0.0.1:7448' } }), true)
  // 有 Origin 却读不到 Host：无从比对，拒。
  assert.equal(isSameOriginRequest({ headers: { origin: 'http://127.0.0.1:7448' } }), false)
})

/* ------------------------------------------------------------------ *
 * 快捷重启（让 DSH 重新加载插件）
 * ------------------------------------------------------------------ */

await test('the reload path is namespaced and distinct from the restart path', () => {
  assert.equal(QWENWORK_RELOAD_PATH, '/plugins/dsh-connect-qwenwork/reload')
  assert.notEqual(QWENWORK_RELOAD_PATH, QWENWORK_RESTART_PATH)
})

await test('apply() registers the reload route too', async () => {
  await withPlugin({}, async ({ registered }) => {
    const paths = registered.routes.map((route) => route.path)
    assert.ok(paths.includes(QWENWORK_RELOAD_PATH), `missing reload route, got ${paths.join(',')}`)
  })
})

await test('the reload route reports 503 when the host has no hmr service', async () => {
  // headless / 没有 profileContext 的宿主就是这种情况：没有热重载，
  // 必须明确告诉用户去重启，而不是回一个假的"已重启"。
  await withPlugin({}, async ({ registered }) => {
    const route = registered.routes.find((item) => item.path === QWENWORK_RELOAD_PATH)
    const io = fakeResponse()
    await route.handler(sameOriginPost(), io.res)
    assert.equal(io.captured.status, 503)
    assert.match(io.captured.body, /hot-reload-unavailable/)
  })
})

await test('the reload route rejects a GET and a cross-origin POST', async () => {
  await withPlugin({}, async ({ registered }) => {
    const route = registered.routes.find((item) => item.path === QWENWORK_RELOAD_PATH)

    const get = fakeResponse()
    await route.handler({ method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:7448' } }, get.res)
    assert.equal(get.captured.status, 405)

    const cross = fakeResponse()
    await route.handler(crossOriginPost(), cross.res)
    assert.equal(cross.captured.status, 403)
  })
})

await test('the reload route answers 202 first and then recomposes the profile', async () => {
  const calls = []
  const hmr = {
    runExclusive: async (operation) => {
      calls.push('runExclusive')
      return operation()
    },
    reconcileProfile: async () => {
      calls.push('reconcileProfile')
      return { pending: [], warnings: [] }
    },
  }

  await withPlugin({}, async ({ registered }) => {
    const route = registered.routes.find((item) => item.path === QWENWORK_RELOAD_PATH)
    const io = fakeResponse()
    await route.handler(sameOriginPost(), io.res)

    // 先回话：重载会把这条路由所在的 Loader 条目停掉，等重载完成再写响应
    // 就没有人接了。
    assert.equal(io.captured.status, 202)
    assert.match(io.captured.body, /reloading/)

    // 重载是异步触发的（250ms 后），等它跑完再断言。
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.deepEqual(calls, ['runExclusive', 'reconcileProfile'])
  }, { hmr })
})

/* ------------------------------------------------------------------ */

process.stdout.write(`\n${results.join('\n')}\n\n`)
process.stdout.write(failures === 0
  ? `host: all ${results.length} cases passed\n`
  : `host: ${failures} of ${results.length} cases FAILED\n`)
if (failures !== 0) process.exitCode = 1
}
