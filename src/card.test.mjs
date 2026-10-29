/**
 * 设置卡片自测：`node src/card.test.mjs`
 *
 * 分两段。
 *
 * **第一段（Host 侧）**：`/plugins/dsh-connect-qwenwork/status` 的响应形状。
 * 这里钉死的最重要一条是"绝不泄露 Cookie 值"——卡片是给人看的，而它读的
 * 数据来自一台真实登录过的机器。
 *
 * **第二段（浏览器侧）**：用一个最小的 `window.__ModuleLoader__` 与
 * `require` 替身把 `lib/client.js` 真的执行一遍。那份文件是自注册脚本，
 * 语法错、导出错、插槽名写错都只会在浏览器里表现为"卡片不出现"，没有
 * 任何报错——所以它必须被真的跑一次。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..')
const linkScript = join(pluginRoot, 'tools', 'link-test-stubs.mjs')

/**
 * `src/index.js` 用**静态 import** 引宿主提供的 pi-ai 等包（这正是它能在
 * DSH 里工作的前提）。静态 import 在链接阶段就解析，所以必须在导入它之前
 * 把桩包链接好——否则本套件会以 ERR_MODULE_NOT_FOUND 直接失败。
 */
execFileSync(process.execPath, [linkScript], { stdio: 'ignore' })

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

/* ------------------------------------------------------------------ *
 * Host 侧：状态文档
 * ------------------------------------------------------------------ */

const { buildStatusDocument, isLoopbackRequest, QWENWORK_STATUS_PATH } = await import('./index.js')

/** 造一个 `value()` 与 `resolveSession()` 的替身。 */
function fakeInputs(overrides = {}) {
  const config = { enabled: true, desktopAuthDir: '', ...overrides.config }
  return {
    ctx: { logger: { warn() {}, error() {} } },
    state: {
      bridge: { baseUrl: 'http://127.0.0.1:1234/v1', port: 1234 },
      catalog: [
        { id: 'advanced', name: '高级', contextWindow: 200000, maxTokens: 32768, source: 'documented-tier' },
        { id: 'basic', name: '基础', contextWindow: 200000, maxTokens: 32768, source: 'documented-tier' },
      ],
      lastError: undefined,
      settingsNs: 'dsh-connect-qwenwork',
      ...overrides.state,
    },
    value: () => config,
    resolveCredential: overrides.resolveCredential ?? (() => undefined),
  }
}

/**
 * 一个不含真值的最小桌面端凭证替身。
 *
 * 形状照 `DesktopCredential`：`token` / `describe()`。`describe()` 只给
 * 来源、身份片段与字节数——**绝不**返回 token 本身，这正是下面那条
 * "NEVER carries a cookie value" 用例要钉的（现在它盯的是 token）。
 */
function fakeCredential(extra = {}) {
  return {
    token: 'SECRET-VALUE-SECRET-VALUE',
    source: 'desktop-client',
    filePath: 'C:/x/auth-v2.dat',
    isExpired: () => false,
    authorization: () => 'Bearer SECRET-VALUE-SECRET-VALUE',
    describe: () => ({
      source: 'desktop-client',
      filePath: 'C:/x/auth-v2.dat',
      displayName: 'bugu',
      username: '3075a0o',
      expired: false,
      tokenBytes: 27,
    }),
    ...extra,
  }
}

await test('the status path is namespaced under /plugins/<plugin>/', () => {
  assert.equal(QWENWORK_STATUS_PATH, '/plugins/dsh-connect-qwenwork/status')
})

await test('the card calls the restart path the Host actually registers, with POST', async () => {
  // 与本文件后面两条"字段名对账"同一个道理：路径是卡片与 Host 之间唯一的
  // 字符串契约。写错路径时卡片照样渲染，点下去只得到 404——没有任何提示。
  const source = readFileSync(join(pluginRoot, 'lib', 'client.js'), 'utf8')
  const { QWENWORK_RESTART_PATH } = await import('./index.js')
  assert.ok(source.includes(QWENWORK_RESTART_PATH), `lib/client.js never calls ${QWENWORK_RESTART_PATH}`)
  // 重启是有副作用的动作，Host 那条路由只收 POST；GET 会被 405 拒掉。
  assert.match(source, /method:\s*'POST'/, 'the restart request must be a POST')
})

await test('the card calls the reload path the Host actually registers', async () => {
  const source = readFileSync(join(pluginRoot, 'lib', 'client.js'), 'utf8')
  const { QWENWORK_RELOAD_PATH } = await import('./index.js')
  assert.ok(source.includes(QWENWORK_RELOAD_PATH), `lib/client.js never calls ${QWENWORK_RELOAD_PATH}`)
})

await test('the status document reports the bridge and the catalog', async () => {
  const inputs = fakeInputs()
  const document = await buildStatusDocument(inputs.ctx, inputs.state, inputs.value, inputs.resolveCredential)
  assert.equal(document.version, 2)
  assert.equal(document.plugin, 'dsh-connect-qwenwork')
  assert.equal(document.enabled, true)
  assert.equal(document.bridge.running, true)
  assert.equal(document.bridge.port, 1234)
  assert.equal(document.catalog.length, 2)
  assert.equal(document.catalog[0].source, 'documented-tier')
})

await test('the status document NEVER carries a cookie value', async () => {
  const inputs = fakeInputs({ resolveCredential: () => fakeCredential() })
  const document = await buildStatusDocument(inputs.ctx, inputs.state, inputs.value, inputs.resolveCredential)
  const serialized = JSON.stringify(document)
  assert.ok(!serialized.includes('SECRET-VALUE'), 'the token leaked into the card payload')
  assert.equal(document.credential.displayName, 'bugu')
  assert.equal(document.credential.tokenBytes, 27)
})

await test('a not-signed-in state is reported without an upstream call', async () => {
  const inputs = fakeInputs()
  const document = await buildStatusDocument(inputs.ctx, inputs.state, inputs.value, inputs.resolveCredential)
  assert.equal(document.credential, undefined)
  assert.equal(document.upstream, undefined)
})

await test('upstream verification only runs when explicitly requested', async () => {
  let verified = 0
  const inputs = fakeInputs({
    resolveCredential: () => fakeCredential(),
    state: {
      client: {
        async verifyCredential() {
          verified += 1
          return { ok: true, status: 200, identity: { displayName: 'x' } }
        },
      },
    },
  })
  const lazy = await buildStatusDocument(inputs.ctx, inputs.state, inputs.value, inputs.resolveCredential)
  assert.equal(verified, 0, 'rendering the card must not trigger a network round trip')
  assert.equal(lazy.upstream, undefined)

  const eager = await buildStatusDocument(inputs.ctx, inputs.state, inputs.value, inputs.resolveCredential, { verify: true })
  assert.equal(verified, 1)
  assert.equal(eager.upstream.ok, true)
})

await test('a failing upstream verification does not break the document', async () => {
  const inputs = fakeInputs({
    resolveCredential: () => fakeCredential(),
    state: {
      client: {
        async verifyCredential() {
          throw new Error('network down')
        },
      },
    },
  })
  const document = await buildStatusDocument(inputs.ctx, inputs.state, inputs.value, inputs.resolveCredential, { verify: true })
  assert.equal(document.upstream.ok, false)
  assert.match(document.upstream.error, /network down/)
  // 本地状态仍然在。
  assert.equal(document.credential.displayName, 'bugu')
})

await test('a bridge that failed to start is reported, not hidden', async () => {
  const inputs = fakeInputs({ state: { bridge: undefined, lastError: 'port in use' } })
  const document = await buildStatusDocument(inputs.ctx, inputs.state, inputs.value, inputs.resolveCredential)
  assert.equal(document.bridge.running, false)
  assert.equal(document.bridge.error, 'port in use')
})

/* ------------------------------------------------------------------ *
 * 回环判定
 * ------------------------------------------------------------------ */

await test('isLoopbackRequest accepts a loopback peer with a loopback Host', () => {
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:1889' } }), true)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '::1' }, headers: { host: '[::1]:1889' } }), true)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { host: 'localhost:1889' } }), true)
})

await test('isLoopbackRequest rejects a remote peer', () => {
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '10.0.0.7' }, headers: { host: '127.0.0.1:1889' } }), false)
  assert.equal(isLoopbackRequest({ socket: {}, headers: {} }), false)
})

await test('isLoopbackRequest rejects a foreign Host header from a loopback peer', () => {
  // loopback 对端 + 外部 Host：经典的 DNS-rebinding 形状。
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'evil.example' } }), false)
})

/* ------------------------------------------------------------------ *
 * 浏览器侧：真的执行 lib/client.js
 * ------------------------------------------------------------------ */

/**
 * 一个足以让卡片脚本跑起来的最小宿主。
 *
 * `react` 用一个只有 `useState`/`useMemo`/`useEffect`/`useCallback` 的替身：
 * 本测试只验证**注册与取数**这条路径，不验证渲染结果——渲染属于 DSH 的
 * renderer，重复实现它只会测到一个假的 renderer。
 */
function loadClientModule() {
  const registered = []
  const errors = []
  let loaderCall

  const React = {
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useMemo: (factory) => {
      try {
        return factory()
      } catch {
        return undefined
      }
    },
    useEffect: () => {},
    useCallback: (fn) => fn,
    createElement: () => ({}),
    Fragment: 'Fragment',
  }
  const jsxRuntime = {
    jsx: () => ({}),
    jsxs: () => ({}),
    Fragment: 'Fragment',
  }
  const require = (name) => {
    if (name === 'react') return React
    if (name === 'react/jsx-runtime') return jsxRuntime
    throw new Error(`unexpected require("${name}") in the client bundle`)
  }

  const sandbox = {
    window: {},
    console: { error: (...args) => errors.push(args), info: () => {}, warn: () => {} },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ version: 1, plugin: 'dsh-connect-qwenwork', catalog: [] }),
    }),
    AbortController,
    setTimeout,
    clearTimeout,
    Symbol,
    Object,
    Array,
    JSON,
    String,
    Number,
    Promise,
  }
  sandbox.window.__ModuleLoader__ = {
    load(options) {
      loaderCall = options
    },
  }
  sandbox.globalThis = sandbox

  const source = readFileSync(join(pluginRoot, 'lib', 'client.js'), 'utf8')
  vm.createContext(sandbox)
  new vm.Script(source, { filename: 'lib/client.js' }).runInContext(sandbox)

  const moduleExports = loaderCall.factory(require)

  return { registered, errors, loaderCall, moduleExports }
}

await test('lib/client.js self-registers through window.__ModuleLoader__', async () => {
  const { loaderCall, moduleExports } = loadClientModule()
  assert.ok(loaderCall !== undefined, 'the bundle must call window.__ModuleLoader__.load')
  assert.equal(loaderCall.id, 'dsh-connect-qwenwork')
  assert.equal(typeof loaderCall.factory, 'function')
  assert.equal(moduleExports.name, 'dsh-connect-qwenwork-client')
  assert.deepEqual([...moduleExports.inject], ['slots'])
  assert.equal(typeof moduleExports.apply, 'function')
})

await test('apply() registers the card into plugins.row.config', async () => {
  const { moduleExports } = loadClientModule()
  const registrations = []
  const ctx = {
    slots: {
      inject: (slotName, register) => {
        registrations.push(slotName)
        return register()
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
    // 没有 configForms：卡片的只读分支必须仍然注册成功。
    effect: (fn) => fn(),
    configForms: undefined,
  }
  moduleExports.apply(ctx)
  const slots = registrations.filter((item) => typeof item === 'string')
  const entries = registrations.filter((item) => typeof item === 'object')
  assert.ok(slots.length > 0)
  assert.ok(slots.every((name) => name === 'plugins.row.config'))
  assert.ok(entries.length >= 1, 'at least one card must be registered')
  assert.equal(typeof entries[0].component, 'function')
})

await test('the card registers both namespace spellings', async () => {
  const { moduleExports } = loadClientModule()
  const keys = []
  const ctx = {
    slots: {
      inject: (_slotName, register) => register(),
      register: (options) => {
        keys.push(options.key)
        return () => {}
      },
    },
    effect: (fn) => fn(),
    configForms: undefined,
  }
  moduleExports.apply(ctx)
  // Loader 条目 id 可能是 `dsh-connect-qwenwork` 或 `include:dsh-connect-qwenwork`，
  // 两个候选都要挂，否则命名空间算错时卡片静默消失。
  assert.ok(keys.includes('dsh-connect-qwenwork'), `expected the bare key, got ${keys.join(',')}`)
  assert.ok(keys.includes('include:dsh-connect-qwenwork'), `expected the include: key, got ${keys.join(',')}`)
})

await test('a broken slot registration does not throw out of apply()', async () => {
  const { moduleExports, errors } = loadClientModule()
  const ctx = {
    slots: {
      inject: () => {
        throw new Error('slot ledger exploded')
      },
      register: () => () => {},
    },
    effect: (fn) => fn(),
    configForms: undefined,
  }
  assert.doesNotThrow(() => moduleExports.apply(ctx))
  assert.ok(errors.length > 0, 'the failure should be logged, not swallowed silently')
})

await test('apply() survives a missing configForms service', async () => {
  const { moduleExports } = loadClientModule()
  let registered = 0
  const ctx = {
    slots: {
      inject: (_name, register) => register(),
      register: () => {
        registered += 1
        return () => {}
      },
    },
    effect: (fn) => fn(),
  }
  assert.doesNotThrow(() => moduleExports.apply(ctx))
  assert.ok(registered > 0)
})

await test('apply() binds the settings scope through whileServed when available', async () => {
  const { moduleExports } = loadClientModule()
  const scopes = []
  const served = new Set(['include:dsh-connect-qwenwork'])
  const ctx = {
    slots: {
      inject: (_name, register) => register(),
      register: () => () => {},
    },
    effect: (fn) => fn(),
    configForms: {
      whileServed: (namespaces, register) => {
        assert.ok(namespaces.includes('dsh-connect-qwenwork'))
        return register(served)
      },
      get: (ns) => {
        scopes.push(ns)
        return { getSnapshot: () => ({ value: { cookieHeader: '' } }), set: async () => {}, unset: async () => {} }
      },
    },
  }
  moduleExports.apply(ctx)
  assert.ok(scopes.includes('include:dsh-connect-qwenwork'), `expected the served namespace to be bound, got ${scopes.join(',')}`)
})

await test('the card only references config fields the Host schema actually declares', async () => {
  // 这条用例是补出来的回归测试：Host 把 `cookieHeader` 改名成 `token`、把
  // 状态文档的 `session` 改成 `credential` 时，卡片里的字符串还是旧名字 ——
  // 它照样渲染，只是永远显示"未登录"、并把用户粘的 token 写进一个没有读者
  // 的字段。没有任何报错，纯静默失效。
  //
  // 所以这里直接把 `lib/client.js` 的源码当文本，找出它引用的字段名，跟
  // Host 的 Config schema 对账。
  const source = readFileSync(join(pluginRoot, 'lib', 'client.js'), 'utf8')
  const { Config } = await import('./index.js')

  const declared = new Set(Object.keys(Config.properties))
  // 从 `settingsScope.getSnapshot()?.value?.<field>` 与 set/unset 的第一个
  // 参数里取出卡片真正读写的配置字段。
  const referenced = new Set()
  // `value?.token` 与 `value.token` 都要认：可选链的 `?` 是**可选的**，
  // 早先把它写成字面 `?`（`value\?\.\?`），于是 `value?.token` 一个都匹配不到，
  // 这条断言在字段写错时静默通过 —— 那正是它本该拦住的 bug。
  for (const match of source.matchAll(/\.value\??\.\??([A-Za-z_]\w*)/g)) referenced.add(match[1])
  for (const match of source.matchAll(/settingsScope\.(?:set|unset)\('([^']+)'/g)) referenced.add(match[1])

  assert.ok(referenced.size > 0, 'the card should reference at least one config field')
  for (const field of referenced) {
    assert.ok(declared.has(field), `the card references "${field}", which the Config schema does not declare`)
  }
})

await test('the card only reads status fields the Host actually emits', async () => {
  // 同上的道理：状态文档把 `session` 改名成 `credential` 时，卡片仍在读
  // `document.session`，于是永远拿到 undefined。
  const source = readFileSync(join(pluginRoot, 'lib', 'client.js'), 'utf8')
  const known = ['version', 'plugin', 'enabled', 'settingsNs', 'bridge', 'catalog',
    'credential', 'failures', 'tokenEnv', 'tokenEnvName', 'lastError', 'upstream', 'error']
  const unknown = []
  for (const match of source.matchAll(/document\.(\w+)/g)) {
    const field = match[1]
    if (!known.includes(field)) unknown.push(field)
  }
  assert.deepEqual(unknown, [], `the card reads status fields the Host never emits: ${unknown.join(', ')}`)
})

/* ------------------------------------------------------------------ */

process.stdout.write(`\n${results.join('\n')}\n\n`)
process.stdout.write(failures === 0
  ? `card: all ${results.length} cases passed\n`
  : `card: ${failures} of ${results.length} cases FAILED\n`)
try {
  execFileSync(process.execPath, [linkScript, '--clean'], { stdio: 'ignore' })
} catch {
  // 拆除失败不该掩盖测试结果。
}
process.exitCode = failures === 0 ? 0 : 1
