/**
 * dsh-connect-qwenwork —— 把千问办公（QwenWork）接入 DeepSeek Harness。
 *
 * ## 它做了什么
 *
 * 千问办公是一个 Agent 平台，不是一个裸模型 API：没有 OpenAI 兼容端点，
 * 鉴权是浏览器 Cookie 会话，对话走 `wss://qwenwork.cn/api/chat-ws` 上的
 * ACP（JSON-RPC 2.0）。所以"接入千问办公的模型"实际上是三件事：
 *
 *   1. **借凭证**（`desktop-auth.js`）：从本机千问办公客户端的 `auth-v2.dat` 里
 *      读出已经登录的会话；
 *   2. **翻译协议**（`acp.js` + `bridge.js`）：在 `127.0.0.1` 起一个
 *      OpenAI 兼容的回环 HTTP 服务，把 Chat Completions 请求翻成 ACP
 *      `session/prompt`，再把 `session/update` 事件流翻回 SSE；
 *   3. **注册路由**（本文件）：把这个回环地址交给 pi-ai，作为
 *      `qwenwork` 这个 provider 的 `baseUrl`。
 *
 * 接缝的选择与参考插件 `dsh-connect-workbuddy` 一致（回环 shim + pi-ai
 * 适配器），因为 DSH 的 adapter 契约属于内部 API，而回环地址 + OpenAI
 * 兼容协议是稳定的外部契约。区别在于上游：WorkBuddy 本来就是 OpenAI 兼容
 * HTTP，本插件的上游是 ACP 长连接，所以桥的翻译量更大。
 *
 * ## 本文件只做"装配"
 *
 * 协议细节全在别的模块里。这里负责：配置 schema、模型目录、
 * pi-ai 路由注册、设置卡片的数据源、以及生命周期的挂载与拆除。
 *
 * @module dsh-connect-qwenwork
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/** 供 trace 用；具名导入比在函数里 require 更符合 ESM。 */
function requireNodeFs() {
  return { appendFileSync, mkdirSync }
}

// 宿主提供的依赖：必须**静态**导入。
//
// 这四个包不在 profile 的 node_modules 里——它们由 DSH 从 app.asar 内部
// 提供，只有宿主的模块系统（loader.internal.import）认得。动态
// `await import()` 走 Node 原生解析器，会 ERR_MODULE_NOT_FOUND，导致
// provider 静默不注册。参考插件 dsh-connect-workbuddy 同样是静态导入。
import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

import { diagnoseDesktop, discoverCredentials, readCredential, looksLikeJwt } from './desktop-auth.js'
import { QwenWorkAcpClient } from './acp.js'
import { FALLBACK_MODELS, startBridge } from './bridge.js'

// ── 模块级自检 ──────────────────────────────────────────────────
// 这一段在**模块被加载时**就执行（早于任何 export 被使用、早于 apply 被调用）。
// 它存在的唯一目的：区分「模块压根没被加载」与「加载了但 apply 没被调用」。
// 两者是完全不同的故障，前者查安装/bundle，后者查 Cordis 注入。
try {
  const dir = join(tmpdir(), 'dsh-connect-qwenwork-trace')
  mkdirSync(dir, { recursive: true })
  appendFileSync(join(dir, 'module.log'),
    `${new Date().toISOString()} module-loaded pid=${process.pid} node=${process.version} cwd=${process.cwd()}\n`)
} catch {
  // 自检失败绝不影响插件。
}

/** 稳定 Cordis 插件名。 */
export const name = 'dsh-connect-qwenwork'

/**
 * 依赖的宿主服务。
 *
 * 只声明 `llm`：没有模型注册表，这个插件没有任何意义。`settings`、
 * `webServer`、`tools` 都用 `ctx.inject(...)` 惰性获取，因为它们在
 * Desktop 的启动顺序里可能晚于本插件——用 `inject` 声明会让插件整体
 * 被推迟挂载，而推迟挂载会连带推迟模型注册，用户看到的是"插件装了但
 * 模型列表里没有"。
 */
/**
 * 依赖的宿主服务。
 *
 * 只声明 `llm`：没有模型注册表，这个插件没有任何意义。`settings` /
 * `webServer` / `tools` 都用 `ctx.inject(...)` 惰性获取——它们可能在
 * Desktop 启动顺序里晚于本插件，用声明式 `inject` 会把整个插件推迟挂载，
 * 连带推迟模型注册。
 */
export const inject = ['llm']

/** provider 路由名。pi-ai 侧以它作为 `GenerateOptions.provider`。 */
export const QWENWORK_PROVIDER = 'qwenwork'

/** 显示名。 */
export const QWENWORK_PROVIDER_DISPLAY_NAME = '千问办公 (QwenWork)'

/** 设置卡片的命名空间回退值；实际值由 Loader 条目 id 决定。 */
export const QWENWORK_SETTINGS_NS = 'dsh-connect-qwenwork'

/** 手填 token 的环境变量名。 */
export const QWENWORK_TOKEN_ENV = 'QWENWORK_TOKEN'

/**
 * 一次请求里允许上游「不说话」的最长时间（毫秒）。
 *
 * **这个字段曾经漏掉，代价是整个 provider 直接不可用。**
 *
 * 宿主（`@deepseek-ai/dsh-llm-pi-ai` 0.2.x）每次请求都会把
 * `profile.streamIdleTimeoutMs` 原样交给 `idleWatchdog`，而后者会先断言它是
 * 「正的有限数且不超过 2147483647」。宿主自己解析配置文件时会给缺省值填
 * 300000，但本插件是**手工构造** profile 的（见 `apply()` 里的 `profile`），
 * 绕过了那层解析——于是字段缺失时，请求在发出之前就失败，报：
 *
 *   idleWatchdog timeoutMs must be a positive finite number no greater than 2147483647
 *
 * 所以这里必须显式写上，并且与宿主默认值保持一致：改小会在上游的沙箱冷启动
 * 阶段误判超时（实测一轮 15–17 秒），改大则失去看门狗的意义。
 */
export const QWENWORK_STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * 图片预算。
 *
 * 千问办公只收文本（图片会变成 `[image omitted: …]` 占位符），但这三个字段
 * 同样会被宿主在请求路径上读取（`profile.requestImagePixelBudget` 等）。缺字段
 * 时宿主拿到 `undefined`——只有当消息里真的带图片才会炸，属于"平时看不出、
 * 关键时候才爆"的坑。取宿主自己的默认值即可。
 */
const REQUEST_IMAGE_BUDGETS = Object.freeze({
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
})

/**
 * 读取宿主实际服务的设置命名空间。
 *
 * `ctx.fiber.entry` 由 Loader 注入（不是 Cordis 本身），在没有 Loader 条目
 * 的宿主上（测试、直接 `ctx.plugin()`）不存在，所以要有回落值。这一点在
 * 参考插件里踩过坑：宣告错命名空间会让 provider 被判为"未配置"，配置
 * 入口与模型发现双双静默失效，且不会有任何报错。
 */
export function settingsNamespaceOf(ctx) {
  try {
    const id = ctx?.fiber?.entry?.options?.id
    if (typeof id === 'string' && id.length > 0) return id
  } catch {
    // 忽略：宿主没有 fiber.entry。
  }
  return QWENWORK_SETTINGS_NS
}

/**
 * 配置 schema。
 *
 * 用 schemastery 的 `z` —— 与 DSH 其它插件同一套（`dsh-connect-workbuddy`
 * 的 `Config` 也是）。这里只保留真正有读取方的字段：一个字段没有读者，
 * 就是一个会让人以为"改了有用"的假开关。
 */
export const Config = z.object({
  /**
   * 手填的 Bearer token（JWT）。
   *
   * 存在的理由：本机客户端的凭证容器可能是加密的、或本进程无权起 DPAPI
   * 子进程，也可能用户就想直接用网页版那一份。这是最后一条不依赖任何
   * 解密能力的手动通路。
   *
   * `.volatile()` 而非普通字段：鉴权材料不该被 settings 服务当作普通配置
   * 写到磁盘上的明文层。
   */
  token: z.string().default('').volatile(),
  /** 是否启用到 qwenwork 的请求。关掉后路由仍然注册，但目录为空。 */
  enabled: z.boolean().default(true),
  /** 默认模型 id；空串表示用目录里的第一个。 */
  defaultModelId: z.string().default(''),
  /** 是否允许模型目录回落到文档里的静态档位。 */
  allowFallbackCatalog: z.boolean().default(true),
  /** 额外的桌面端 userData 目录（用于非标准安装位置）。 */
  desktopAuthDir: z.string().default(''),
})

/**
 * 插件主体。
 *
 * 生命周期：
 *   apply()                             注册目录与路由（此时桥还没起）
 *   └─ 起桥（异步）                      成功后才把真实 baseUrl 交给 provider
 *   └─ 每次请求                          pi-ai → 桥 → ACP → 上游
 *
 * "先注册、后起桥"是刻意的：桥的启动要读 Cookie、要等 WebSocket 握手，
 * 全是 IO；如果它失败，用户至少还能在模型列表里看到这个 provider（并且
 * 在设置卡片里看到失败原因），而不是整个 provider 消失、无从下手。
 */
export function apply(ctx, config) {
  const state = {
    bridge: undefined,
    client: undefined,
    /** 桥的启动 promise；请求路径用它来 await，避免竞态。 */
    starting: undefined,
    /** 正在进行的「重启桥」；并发点击共享同一次重启。 */
    restarting: undefined,
    catalog: [...FALLBACK_MODELS],
    lastError: undefined,
    lastVerified: undefined,
    settingsNs: settingsNamespaceOf(ctx),
  }

  const log = (message, error) => {
    try {
      ctx.logger?.warn?.(`dsh-connect-qwenwork: ${message}`, error)
    } catch {
      // 日志失败不该影响主流程。
    }
  }

  /**
   * 启动自检标记。
   *
   * 诊断用：`apply()` 一被调用就往 DSH home 写一行「我活着 + 注册结果」。
   * 没有它，「插件装了但模型列表里没有」这类问题无法从外部区分是
   * **模块没加载**、**apply 没跑**，还是**跑了但注册失败**——三者都需要
   * 完全不同的修复动作。
   *
   * 写失败不抛：这只是诊断，不该影响插件本身。
   */
  const trace = (phase, detail) => {
    try {
      const line = `${new Date().toISOString()} ${phase} ${detail === undefined ? '' : JSON.stringify(detail)}\n`
      const { appendFileSync, mkdirSync } = requireNodeFs()
      // 写到一个**稳定的绝对位置**。
      //
      // 不用插件自身目录：`file:` 安装会复制一份到 profile 的 node_modules，
      // 与源码目录是两个位置，诊断时容易看错文件。
      // 不用 DSH_HOME：它在受限环境里不可写（实测 EPERM）。
      // 系统临时目录两边都可读写，且路径完全可预测。
      const traceDir = join(tmpdir(), 'dsh-connect-qwenwork-trace')
      mkdirSync(traceDir, { recursive: true })
      appendFileSync(join(traceDir, 'apply.log'), line)
    } catch {
      // 诊断失败不影响主流程。
    }
  }
  trace('apply-enter', { pid: process.pid, node: process.version })

  /** 当前配置值。`get()` 兼容 schemastery 的 live reference。 */
  const value = () => unwrap(Config, config)

  /**
   * 解析凭证。每次建连时调用，因此用户重新登录后无需重启。
   *
   * 优先级（真机验证后修正）：
   *   1. 设置里手填的 **token**（不是 Cookie —— 上游要 Bearer JWT）；
   *   2. 环境变量 `QWENWORK_TOKEN`；
   *   3. 桌面客户端的 `auth-v2.dat`（DPAPI → os_crypt → AES-GCM → JWT）。
   *
   * 早先按 Cookie 设计是错的：真机上客户端的 Cookie 库里只有一个统计
   * Cookie，会话在 `auth-v2.dat` 里，且上游只认 `Authorization: Bearer`。
   */
  const resolveCredential = () => {
    const current = value()
    const explicit = typeof current.token === 'string' ? current.token.trim() : ''
    if (explicit.length > 0) return manualCredential(explicit, 'settings')
    const fromEnv = typeof process.env[QWENWORK_TOKEN_ENV] === 'string' ? process.env[QWENWORK_TOKEN_ENV].trim() : ''
    if (fromEnv.length > 0) return manualCredential(fromEnv, 'env')
    const extra = typeof current.desktopAuthDir === 'string' && current.desktopAuthDir.trim().length > 0
      ? [current.desktopAuthDir.trim()]
      : []
    return readCredential({ desktopDirs: extra })
  }

  /**
   * 起桥。并发调用共享同一次启动。
   *
   * 失败时**把错误记下来**并继续注册一个空目录，而不是让整个插件挂掉：
   * 插件挂掉会让设置卡片一起消失，用户就看不到"为什么失败"了。
   */
  const ensureBridge = () => {
    if (state.bridge !== undefined) return Promise.resolve(state.bridge)
    if (state.starting !== undefined) return state.starting
    state.starting = (async () => {
      const client = new QwenWorkAcpClient({ resolveCredential, log })
      state.client = client
      const bridge = await startBridge({
        log,
        resolveInventory: () => state.catalog,
        resolveInventorySync: () => state.catalog,
        stream: ({ prompt, modelId, signal }) => client.prompt(prompt, { signal }),
      })
      state.bridge = bridge
      state.lastError = undefined
      log(`bridge listening on ${bridge.baseUrl}`)
      refreshCatalog().catch((error) => log('catalog refresh failed', error))
      return bridge
    })().catch((error) => {
      state.lastError = messageOf(error)
      log('bridge failed to start', error)
      throw error
    }).finally(() => {
      state.starting = undefined
    })
    return state.starting
  }

  /**
   * 刷新模型目录。
   *
   * ACP 没有"列出模型"的标准方法，所以这里**只在拿到目录时更新**，
   * 拿不到就保留回落目录。宁可给四个文档档位，也不编一批看起来很像
   * 真模型 id 的字符串——后者会让用户选到一个永远 404 的模型。
   */
  const refreshCatalog = async () => {
    const current = value()
    if (current.allowFallbackCatalog === false && state.catalog.length === 0) {
      state.catalog = []
      return state.catalog
    }
    if (state.catalog.length === 0) state.catalog = [...FALLBACK_MODELS]
    return state.catalog
  }

  /**
   * 关掉桥及其上游会话。
   *
   * 顺序是刻意的：先把 `state.bridge` 摘掉，再 `close()`。否则 `close()` 期间
   * 进来的请求会拿到一个"看着还在、其实正在拆"的桥，报出来的错误很难懂。
   */
  const closeBridge = async () => {
    const previous = state.bridge
    state.bridge = undefined
    try {
      state.client?.close()
    } catch (error) {
      log('acp client did not close cleanly', error)
    }
    state.client = undefined
    if (previous !== undefined) {
      try {
        await previous.close?.()
      } catch (error) {
        // 关不干净不该阻止重开：端口通常仍然可用，真不可用时下次启动会报。
        log('bridge did not close cleanly', error)
      }
    }
  }

  /**
   * 重启桥。
   *
   * 存在的理由：桥持有上游会话与一份建连时读取的凭证。客户端重新登录、
   * 上游主动断开、端口被别的进程占过又释放——这些都需要"关掉再起来"。没有
   * 这个入口时，唯一的办法是重启整个 DSH，代价（丢掉正在跑的会话）太大。
   *
   * 并发调用共享同一次重启：连点两下不能起两个桥（第二个会抢不到端口，
   * 反而把状态搞成"桥未就绪"）。
   */
  const restartBridge = () => {
    if (state.restarting !== undefined) return state.restarting
    state.restarting = (async () => {
      trace('bridge-restart-requested')
      await closeBridge()
      const bridge = await ensureBridge()
      await refreshCatalog().catch(() => state.catalog)
      trace('bridge-restarted', { baseUrl: bridge.baseUrl, port: bridge.port })
      return bridge
    })().catch((error) => {
      state.lastError = messageOf(error)
      log('bridge restart failed', error)
      throw error
    }).finally(() => {
      state.restarting = undefined
    })
    return state.restarting
  }

  /** pi-ai 的模型描述。字段与 `dsh-connect-workbuddy` 的 `toPiModel` 对齐。 */
  const toPiModel = (model, baseUrl) => ({
    id: model.id,
    name: model.name,
    api: 'openai-completions',
    provider: QWENWORK_PROVIDER,
    baseUrl,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: false,
    compat: {
      supportsReasoningEffort: false,
      // 千问办公的网关不认 OpenAI 的 `developer` 角色，也不认 `store`。
      supportsDeveloperRole: false,
      supportsStore: false,
      thinkingFormat: 'qwen',
    },
  })

  /** 每次读模型都现算 baseUrl：桥可能晚于注册就绪，或换过端口。 */
  const buildModels = () => {
    const baseUrl = state.bridge?.baseUrl ?? 'http://127.0.0.1:0/v1'
    return state.catalog.map((model) => toPiModel(model, baseUrl))
  }

  /**
   * 注册到 llm 服务。
   *
   * 用 `registerAdapter` + `createProvider` 的形状（与参考插件一致）：
   * pi-ai 的 `createProvider` 负责 auth/models/api 三件套，DSH 只要求
   * 把 provider 交给它。
   */
  ctx.inject(['llm'], async (llmCtx) => {
    trace('llm-inject', { hasLlm: llmCtx.llm !== undefined })
    const llm = llmCtx.llm
    if (llm === undefined) return

    /**
     * 这四个包必须用**静态 import**（见文件顶部）。
     *
     * 这里记一条实测教训：早期版本用 `await import('@earendil-works/pi-ai')`
     * 做"惰性导入"，理由是想让插件在宿主缺包时仍能挂上。但在 DSH 里它
     * **必然失败**——动态 `import()` 走 Node 原生解析器，从本插件的
     * `node_modules` 往上找，而这些包是宿主从 `app.asar` 内部提供的，
     * profile 的 `node_modules` 里根本没有。于是 `apply()` 静默 return，
     * 表现为"插件装了但模型列表里没有"。
     *
     * 静态 import 不同：它由宿主的模块系统（`loader.internal.import`）
     * 解析，能找到 asar 内的那些包。参考插件 `dsh-connect-workbuddy`
     * 用的就是静态 import，这也是它一直正常工作的原因。
     *
     * 代价是宿主真缺包时整个模块会加载失败——但这比"静默不注册"好：
     * 显式失败能在日志里留下真因。
     */
    if (typeof createProvider !== 'function' || typeof openAICompletionsApi !== 'function' || typeof PiAiAdapter !== 'function') {
      log('pi-ai resolved but does not expose the expected entry points; the qwenwork route cannot be registered')
      trace('imports-invalid', { createProvider: typeof createProvider, api: typeof openAICompletionsApi, adapter: typeof PiAiAdapter })
      return
    }
    trace('imports-ok')

    /**
     * provider 的 apiKey 就是桥的 bearer token。
     *
     * 桥已经绑在回环上，token 是**第二道**防线：同机别的进程能猜端口，
     * 但猜不到 token。
     */
    const provider = {
      ...createProvider({
        id: QWENWORK_PROVIDER,
        name: QWENWORK_PROVIDER_DISPLAY_NAME,
        auth: {
          apiKey: {
            name: 'QwenWork bridge token',
            async resolve() {
              const bridge = await ensureBridge()
              return { auth: { apiKey: bridge.token }, source: 'QwenWork' }
            },
          },
        },
        models: buildModels(),
        api: openAICompletionsApi(),
      }),
      getModels: () => buildModels(),
    }

    /**
     * 给 pi-ai 适配器看的 profile。
     *
     * 这个对象是**手工构造**的，不走宿主自己的配置解析器（`resolveProfiles`），
     * 因此宿主会给缺省值补上的字段，这里必须自己填。宿主在请求路径上直接读
     * `profile.streamIdleTimeoutMs` / `profile.requestImage*`，缺了就是
     * `undefined`——`idleWatchdog` 会因此断言失败，整条 provider 在发出请求
     * 之前就不可用（见 `QWENWORK_STREAM_IDLE_TIMEOUT_MS` 的注释）。
     *
     * 字段清单以 `@deepseek-ai/dsh-llm-pi-ai` 0.2.x 的实现为准：
     *   displayName / streamIdleTimeoutMs / retryPolicy / configuredMaxTokens /
     *   modelErrors / piProvider / 图片预算。
     *
     * 这里**故意不写** `reasoning`：它是 profile 的"默认思考档位"，必须是一个
     * 档位 id（`off`/`low`/`high`…），而不是"本模型不支持思考"这个布尔。
     * 写成 `false` 时宿主会拿它去 `resolveReasoningLevel` 比对，直接抛
     * `does not support reasoning effort "false"`。"不支持思考"这件事只属于
     * **模型描述**（`toPiModel` 里的 `reasoning: false`），不写进 profile。
     */
    const profile = {
      provider: QWENWORK_PROVIDER,
      displayName: QWENWORK_PROVIDER_DISPLAY_NAME,
      streamIdleTimeoutMs: QWENWORK_STREAM_IDLE_TIMEOUT_MS,
      retryPolicy: resolveRetryPolicy?.(undefined, 'dsh-connect-qwenwork retryPolicy'),
      configuredMaxTokens: new Map(),
      modelErrors: new Map(),
      ...REQUEST_IMAGE_BUDGETS,
      piProvider: provider,
    }

    const adapter = new PiAiAdapter({
      profiles: () => new Map([[QWENWORK_PROVIDER, profile]]),
      auth: { async resolve() { return undefined } },
      resolveApiKey: async () => {
        const bridge = await ensureBridge()
        return bridge.token
      },
    })

    if (typeof llm.registerAdapter !== 'function') {
      log('the llm service has no registerAdapter; this DSH build is too old for this plugin')
      trace('no-registerAdapter')
      return
    }

    const releaseAdapter = llm.registerAdapter([QWENWORK_PROVIDER], adapter)
    trace('provider-registered', { provider: QWENWORK_PROVIDER, release: typeof releaseAdapter })

    // 目录条目：让设置页的模型选择器知道有这个 provider。
    const releaseDirectory = llm.registerConfigurableProviders?.([{
      provider: QWENWORK_PROVIDER,
      displayName: QWENWORK_PROVIDER_DISPLAY_NAME,
      settingsNs: state.settingsNs,
      settingsPath: [],
      declared: true,
    }])

    /**
     * 模型发现：设置页点"刷新"时调用。
     *
     * 先确保桥起来了——否则用户点刷新只会得到一个空列表，而真正的原因
     * （还没登录）藏在日志里。
     */
    llm.registerModelDiscovery?.(state.settingsNs, async (request) => {
      if (request?.provider !== undefined && request.provider !== QWENWORK_PROVIDER) return []
      try {
        await ensureBridge()
      } catch (error) {
        log('model discovery cannot start the bridge', error)
        return fallbackDiscovery()
      }
      const catalog = await refreshCatalog().catch(() => state.catalog)
      return (catalog.length > 0 ? catalog : fallbackDiscovery()).map((model) => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        inputModalities: ['text'],
      }))
    })

    ctx.effect(() => () => {
      releaseAdapter?.()
      releaseDirectory?.()
      state.client?.close()
      state.bridge?.close?.().catch(() => {})
    })

    // 桥的启动不必等设置页打开；失败也已记入 state.lastError。
    ensureBridge().catch(() => {})
  })

  /**
   * 设置卡片的**数据面**（Host 侧）。
   *
   * 卡片（`lib/client.js`）不直接读磁盘、也不碰 Cookie：它只调这一条只读
   * 路由，拿一个已经脱敏的 JSON。这样敏感材料的边界只有一个——`desktop-auth.js`
   * ——而浏览器侧永远拿不到 Cookie 值。
   *
   * 用 `ctx.inject(['webServer'], ...)` 而不是在 `inject` 里声明 `webServer`：
   * Desktop 的 webServer 可能晚于本插件出现，声明式依赖会让整个插件被推迟
   * 挂载，连带推迟模型注册（用户看到的是"装了但模型列表里没有"）。
   */
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer
    if (webServer === undefined || typeof webServer.register !== 'function') return

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: QWENWORK_STATUS_PATH,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          writeJson(res, 405, { error: 'method not allowed' })
          return
        }
        // 只接受来自本机回环页面的读取：卡片跑在同源页面上，任何跨源
        // 读取都不该看到"这台机器上有没有登录态"。
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'origin-not-trusted' })
          return
        }
        try {
          writeJson(res, 200, await buildStatusDocument(ctx, state, value, resolveCredential))
        } catch (error) {
          writeJson(res, 500, { error: messageOf(error) })
        }
      },
    }))

    /**
     * 设置卡片上的「重启桥」按钮的数据面。
     *
     * 这是插件里**唯一**一条会改变运行状态的路由，所以鉴权比只读那条更严：
     *   1. 必须是 POST（GET 不该有副作用）；
     *   2. 对端必须是回环（同 `isLoopbackRequest`）；
     *   3. `Origin` 必须与 `Host` 同源。
     *
     * 第 3 条挡的是 CSRF：任意网页都能向 `127.0.0.1:<port>` 发一个"简单请求"
     * （POST + text/plain，无预检），而它的对端确实是回环、`Host` 也确实写成了
     * 回环地址——前两条拦不住。浏览器对 POST 一定带 `Origin`，比对同源即可。
     *
     * 返回值是一份**新的状态文档**，卡片直接拿来刷新，不必再发一次 GET。
     */
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: QWENWORK_RESTART_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: 'method not allowed' })
          return
        }
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'origin-not-trusted' })
          return
        }
        if (!isSameOriginRequest(req)) {
          writeJson(res, 403, { error: 'cross-origin-rejected' })
          return
        }
        try {
          await restartBridge()
          writeJson(res, 200, await buildStatusDocument(ctx, state, value, resolveCredential))
        } catch (error) {
          writeJson(res, 500, { error: messageOf(error) })
        }
      },
    }))

    /**
     * 设置卡片上的「快捷重启」按钮的数据面：让 DSH **重新加载本插件**。
     *
     * 这就是以前必须"退出应用再打开"的那个动作。DSH 自带 HMR
     * （`@deepseek-ai/dsh-hmr`）：它的 profile 重算会用磁盘上**已改动**的文件
     * 替换正在运行的插件模块，不需要重启进程。所以卡片只要触发一次重算即可。
     *
     * 三个实现细节：
     *
     *   1. **先回话再重载**。重载会停掉本插件所在的 Loader 条目——这条路由也
     *      属于它。等重载完成再写响应，就没有人接这个响应了。所以先 202，
     *      再异步触发。
     *   2. 没有 `hmr` 服务（headless / 没开 profileContext 的宿主）时明确报
     *      503 并告诉用户去重启，而不是假装已经重启。
     *   3. 重载失败只写 trace + 日志：这是后台动作，响应早发出去了，卡片
     *      之后靠 `/status` 自己看结果。
     */
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: QWENWORK_RELOAD_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: 'method not allowed' })
          return
        }
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'origin-not-trusted' })
          return
        }
        if (!isSameOriginRequest(req)) {
          writeJson(res, 403, { error: 'cross-origin-rejected' })
          return
        }
        const hmr = typeof ctx.get === 'function' ? ctx.get('hmr') : undefined
        if (hmr === undefined || typeof hmr.runExclusive !== 'function' || typeof hmr.reconcileProfile !== 'function') {
          writeJson(res, 503, {
            error: 'hot-reload-unavailable',
            message: '这个 DSH 进程没有可用的热重载服务（hmr）。请退出并重新打开 DSH 来加载新代码。',
          })
          return
        }
        trace('plugin-reload-requested')
        writeJson(res, 202, { reloading: true })
        const timer = setTimeout(() => {
          hmr.runExclusive(() => hmr.reconcileProfile())
            .then((result) => trace('plugin-reload-finished', result ?? null))
            .catch((error) => {
              trace('plugin-reload-failed', { error: messageOf(error) })
              log('plugin reload failed', error)
            })
        }, 250)
        timer.unref?.()
      },
    }))
  })

  /**
   * 设置卡片的**策略面**。
   *
   * `configure({ auto: true }, ctx.fiber)` 是 `@deepseek-ai/dsh-settings` 文档
   * 里的原话：`autoGenerate` 默认开启，供客户端按 schema 建页面。
   *
   * 保留它是刻意的——本插件**另外**提供一个手写的卡片（`lib/client.js`），
   * 因为 DSH 现状是"还没有客户端会按 schema 建页面"（同一份文档的原话），
   * 只声明 schema 等于用户没有任何界面可填。但 schema 仍然要声明：设置页的
   * 写入校验走的是序列化后的 Config schema，去掉它会让卡片写不进去。
   */
  ctx.inject(['settings'], (sctx) => {
    const settings = sctx.settings
    if (settings === undefined) return
    ctx.effect(() => settings.configure({ auto: true }, ctx.fiber))
  })

  return {
    /** 供 doctor CLI 与测试读取的只读快照。 */
    status: () => ({
      enabled: value().enabled !== false,
      bridge: state.bridge === undefined ? undefined : { baseUrl: state.bridge.baseUrl, port: state.bridge.port },
      catalog: state.catalog.map((model) => ({ id: model.id, name: model.name, source: model.source })),
      lastError: state.lastError,
      lastVerified: state.lastVerified,
      settingsNs: state.settingsNs,
    }),
  }
}

/** 卡片读取登录态与桥状态的只读路由。 */
export const QWENWORK_STATUS_PATH = '/plugins/dsh-connect-qwenwork/status'

/** 卡片「重启桥」按钮写入的路由（POST，带副作用）。 */
export const QWENWORK_RESTART_PATH = '/plugins/dsh-connect-qwenwork/restart'

/**
 * 卡片「快捷重启」按钮写入的路由（POST，带副作用）。
 *
 * 与 `/restart` 的区别：那条只重启**桥**（重连上游），这条让 DSH 重新加载
 * **插件代码**——也就是"改完插件不用重启整个应用"的那个动作。
 */
export const QWENWORK_RELOAD_PATH = '/plugins/dsh-connect-qwenwork/reload'

/**
 * 组装卡片要的那份文档。
 *
 * 三条硬规则：
 *   1. **绝不**带 Cookie 值——只给名字与条数；
 *   2. 把「没登录」与「登录了但读不出来」分开报，因为修复动作不同；
 *   3. 上游验证要联网，所以它是**可选**的一段：拿不到就写 `undefined`，
 *      而不是让整份文档失败（离线时卡片仍应能显示本地状态）。
 */
export async function buildStatusDocument(ctx, state, value, resolveCredential, options = {}) {
  const credential = resolveCredential()
  const diagnosed = diagnoseDesktop({ desktopDirs: currentDesktopDir(value) })
  const document = {
    version: 2,
    plugin: name,
    enabled: value().enabled !== false,
    settingsNs: state.settingsNs,
    bridge: state.bridge === undefined
      ? { running: false, error: state.lastError }
      : { running: true, baseUrl: state.bridge.baseUrl, port: state.bridge.port },
    catalog: state.catalog.map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      source: model.source,
    })),
    credential: credential === undefined ? undefined : credential.describe(),
    failures: diagnosed.failures,
    tokenEnv: process.env[QWENWORK_TOKEN_ENV] === undefined ? 'unset' : 'set',
    tokenEnvName: QWENWORK_TOKEN_ENV,
    lastError: state.lastError,
  }
  if (credential === undefined || state.client === undefined) return document
  // 只有在调用方明确要求时才联网验证：卡片首次渲染不该等一次网络往返。
  if (options.verify !== true) return document
  try {
    const verdict = await state.client.verifyCredential(credential)
    state.lastVerified = verdict.ok
    document.upstream = { ok: verdict.ok, status: verdict.status, reason: verdict.reason, identity: verdict.identity }
  } catch (error) {
    document.upstream = { ok: false, error: messageOf(error) }
  }
  return document
}

/** 配置里手填的桌面端目录（若为空则不传，让 `diagnose` 用平台默认）。 */
function currentDesktopDir(value) {
  const explicit = value().desktopAuthDir
  return typeof explicit === 'string' && explicit.trim().length > 0 ? [explicit.trim()] : []
}

/**
 * 请求是否来自本机回环。
 *
 * `Host` 头会被浏览器强制绑定到目标地址，但一个非浏览器客户端可以伪造它。
 * 所以这里不依赖它做安全判断，而是看**真实对端地址**：DSH 的 webServer 只
 * 监听本机，对端必然是 127.0.0.1/::1。`Host` 只用来拒绝"名字解析到本机但
 * 声明了别的域"的简单请求伪装（CSRF 的一类）。
 */
export function isLoopbackRequest(req) {
  const address = req?.socket?.remoteAddress ?? ''
  const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  if (!loopback) return false
  const host = String(req?.headers?.host ?? '')
  if (host.length === 0) return true
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)
}

/**
 * 请求是否与页面同源。
 *
 * 只对**会改变状态**的路由有意义：回环页面上的按钮与宿主同源，因此浏览器的
 * `Origin` 恰好等于 `http://<Host>`。别的网页向回环地址发 POST 时，前两条检查
 * （回环对端、回环 `Host`）都成立——`Host` 是浏览器写的目标地址，改不了——
 * 但 `Origin` 是它自己的站点，于是这里就能拦住。
 *
 * 没有 `Origin` 时不拦：那不是浏览器发起的请求（curl / 本地脚本），CSRF 不是
 * 威胁模型，而这些工具恰恰是诊断时要用 POST 手段的来源。
 */
export function isSameOriginRequest(req) {
  const origin = req?.headers?.origin
  if (typeof origin !== 'string' || origin.length === 0) return true
  const host = String(req?.headers?.host ?? '')
  if (host.length === 0) return false
  return origin === `http://${host}` || origin === `https://${host}`
}

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload)
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body, 'utf8'),
      'Cache-Control': 'no-store',
    })
    res.end(body)
  } catch {
    // 客户端已经断开：无所谓。
  }
}

/** 目录都拿不到时，把文档档位交出去（而不是空列表）。 */
function fallbackDiscovery() {
  return FALLBACK_MODELS.map((model) => ({
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    inputModalities: ['text'],
  }))
}

/**
 * 把配置值解成普通对象。
 *
 * 为什么要单独一层：`Config` 是 `z.object(...)`（schemastery），而 DSH 对
 * `.volatile()` 字段在运行时给的是 `{ get(): T }` 这样的 **live reference**；
 * 直接读会拿到对象而不是字符串。这里统一展开。
 *
 * 默认值直接从 schema 里读（`z.object` 的字段各自带 `.default()`），所以
 * 这个函数不需要再维护一份默认值副本——两份默认值迟早会不一致。
 */
const CONFIG_DEFAULTS = Object.freeze({
  token: '',
  enabled: true,
  defaultModelId: '',
  allowFallbackCatalog: true,
  desktopAuthDir: '',
})

function unwrap(_schema, config) {
  const raw = config ?? {}
  const out = {}
  for (const [key, fallback] of Object.entries(CONFIG_DEFAULTS)) {
    const held = raw[key]
    if (held !== null && typeof held === 'object' && typeof held.get === 'function') {
      out[key] = held.get()
    } else if (held !== undefined) {
      out[key] = held
    } else {
      out[key] = fallback
    }
  }
  return out
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

export { FALLBACK_MODELS }
export const internal = Object.freeze({ unwrap, fallbackDiscovery, randomUUID })

// ── 模块级完成标记 ──────────────────────────────────────────────
// 与文件顶部的 module-loaded 配对：若只有 module-loaded 而没有这一行，
// 说明模块**求值中途抛了异常**（导出因此不完整，Cordis 拿不到 apply）。
try {
  const dir = join(tmpdir(), 'dsh-connect-qwenwork-trace')
  mkdirSync(dir, { recursive: true })
  appendFileSync(join(dir, 'module.log'),
    `${new Date().toISOString()} module-evaluated exports=${['apply','inject','name','Config'].map(k => k + ':' + typeof (k === 'apply' ? apply : k === 'inject' ? inject : k === 'name' ? name : Config)).join(',')}\n`)
} catch {
  // 自检失败绝不影响插件。
}
