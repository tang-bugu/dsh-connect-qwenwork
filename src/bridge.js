/**
 * 回环 HTTP 桥：OpenAI 兼容  ⇄  千问办公 ACP。
 *
 * 为什么要有这一层。pi-ai（DSH 的模型适配层的底层）只会说 OpenAI 兼容协议；
 * 千问办公只会说 ACP over WebSocket（见 `acp.js` 的模块头）。两边协议不重合，
 * 就需要一个翻译点。参考插件 `dsh-connect-workbuddy` 选的也是同一个接缝：
 * 在 `127.0.0.1` 上起一个只监听回环的 HTTP 服务，把它交给 pi-ai 当作
 * `openai-completions` 的 `baseUrl`。
 *
 * 为什么是回环而不是直接实现一个 DSH adapter：
 *   - 回环桥让"协议翻译"与"DSH 适配器契约"彻底解耦。DSH 的 adapter 契约
 *     （`LlmAdapter`、`StreamChunk`、replay 状态）是内部 API，随版本移动；
 *     而 OpenAI 兼容 HTTP 是外部稳定契约。
 *   - 出错的定位也更清楚：桥的日志能单独讲"这条请求在上游发生了什么"。
 *
 * 安全边界（重要）：
 *   - 只 `listen('127.0.0.1')`，不接受外部连接；
 *   - 每个进程启动时生成一个随机 bearer token，pi-ai 侧的 `apiKey` 就是它，
 *     桥校验 `Authorization`。没有这个 token 的本机进程也能猜到端口，
 *     所以只靠"绑定回环"是不够的。
 *
 * @module dsh-connect-qwenwork/bridge
 */

import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'

import {
  AcpError,
  finishReasonOf,
  QwenWorkAcpClient,
  messagesToPrompt,
  UPSTREAM_MESSAGE_LIMIT_BYTES,
} from './acp.js'

/**
 * 拼 prompt 时的字节预算。
 *
 * 上游一条消息只收 32 KB（实测，见 `UPSTREAM_MESSAGE_LIMIT_BYTES`）。这里再
 * 提前留出 2 KB 给 JSON-RPC 外壳、sessionId 与转义，让 `acp.js` 的兜底几乎
 * 不会触发——真正裁消息的逻辑放在 `messagesToPrompt` 里，因为它知道哪条是
 * 系统提示、哪条最新，能按"系统提示 + 最近上下文"的顺序丢。
 */
export const PROMPT_BUDGET_BYTES = UPSTREAM_MESSAGE_LIMIT_BYTES - 2 * 1024

/** 桥只监听这个地址。改成 `0.0.0.0` 会把用户的登录态暴露给局域网。 */
export const BIND_ADDRESS = '127.0.0.1'

/** 一次 SSE 响应的 keep-alive 注释间隔：防止中间的代理或 DSH 侧读超时。 */
export const HEARTBEAT_MS = 15000

/**
 * 千问办公的模型目录。
 *
 * 来自官方文档（`docs.qwenwork.cn/features/model-selection`，2026-10-22 读取）：
 * 选择器提供 **高级 / 基础 / 经济 / Qwen3.8-Max** 四档。注意这是**档位**
 * 而不是模型 id：文档明确说"模型列表会持续更新……替换或下线旧模型"，所以
 * 上游真正接受的 id 不能从文档静态推出。
 *
 * 这就是为什么 `refreshCatalog()` 存在（走 `session/list_models` 或
 * `session/new` 的响应），并把这四档当作**离线回落**：网关联通性差时
 * 至少还有可选项，而不是模型选择器一片空白。`source` 字段标明每条来自
 * 文档还是来自上游，免得把静态猜测当成实测。
 */
export const FALLBACK_MODELS = Object.freeze([
  {
    id: 'advanced',
    name: '高级（Advanced）',
    description: '面向复杂任务的顶级性能：复杂分析、多步骤任务、研究报告、创意写作',
    contextWindow: 200000,
    maxTokens: 32768,
    source: 'documented-tier',
  },
  {
    id: 'basic',
    name: '基础（Basic）',
    description: '智能高效，适合日常任务：简单问答、文件格式转换、文案润色、信息查询',
    contextWindow: 200000,
    maxTokens: 32768,
    source: 'documented-tier',
  },
  {
    id: 'economy',
    name: '经济（Economy）',
    description: '经济实惠，适合简单任务：简单翻译、文本提取、格式整理、基础问答',
    contextWindow: 131072,
    maxTokens: 16384,
    source: 'documented-tier',
  },
  {
    id: 'qwen3.8-max',
    name: 'Qwen3.8-Max',
    description: '最强通义千问，具备进阶推理能力；对生成质量要求极高的长文创作',
    contextWindow: 1000000,
    maxTokens: 65536,
    source: 'documented-tier',
  },
])

/**
 * 桥的对外身份。
 *
 * `owned_by` 用 `qwenwork` 而不是 `openai`：下游有些工具会按这个字段做
 * 模型家族的判断，冒充 OpenAI 会引出错误的分支。
 */
const MODEL_OWNER = 'qwenwork'

/**
 * 启动桥。
 *
 * @param {object} options
 * @param {() => object} options.resolveInventory 返回当前模型目录（`{id,name,...}[]`）
 * @param {(options: object) => AsyncIterable<object>} options.stream 上游流（通常是 `acp.prompt`）
 * @param {(message: string, error?: unknown) => void} [options.log]
 * @returns {Promise<{baseUrl: string, token: string, close: () => Promise<void>, port: number}>}
 */
export async function startBridge(options) {
  const token = randomBytes(32).toString('base64url')
  const log = options.log ?? (() => {})

  /** 所有活动连接，供 `close()` 直接断开（见那里的说明）。 */
  const connections = new Set()

  const server = createServer((request, response) => {
    handleRequest(request, response, { ...options, token, log }).catch((error) => {
      log('qwenwork bridge: unhandled request failure', error)
      if (!response.headersSent) {
        writeJson(response, 500, { error: { message: messageOf(error), type: 'internal_error' } })
      } else {
        try {
          response.end()
        } catch {
          // 已经断了，无事可做。
        }
      }
    })
  })

  server.on('connection', (socket) => {
    connections.add(socket)
    socket.on('close', () => connections.delete(socket))
  })

  // 上游的流可能远长于 Node 默认的 keep-alive，显式放宽，避免桥自己把
  // 长对话掐断——那会表现成"聊到一半突然断"，很难归因。
  server.keepAliveTimeout = 120000
  server.headersTimeout = 130000
  server.requestTimeout = 0

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error)
    server.once('error', onError)
    server.listen(0, BIND_ADDRESS, () => {
      server.off('error', onError)
      resolve()
    })
  })

  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('qwenwork bridge: could not determine the listening port')
  }
  const port = address.port

  return {
    port,
    baseUrl: `http://${BIND_ADDRESS}:${port}/v1`,
    token,
    /**
     * 关掉桥。
     *
     * `server.close()` 只停止接受**新**连接；已建立的 keep-alive 连接会让
     * 它的回调永远不触发。而 pi-ai 侧用的是 `fetch`（底层 keep-alive 池），
     * 桥被反复卸载/重挂时必然还有存活的连接。所以先显式断开所有活动连接，
     * 再等服务器真正关闭。
     *
     * 这不只是测试问题：插件被热重载时若 close 挂住，旧桥的端口会一直
     * 被占着，新的桥再起来就出现两个桥同时服务、一个已经没人管的局面。
     */
    async close() {
      /**
       * 断开所有连接，**然后**再关服务器。
       *
       * 顺序不能反：`server.close()` 在还有活动连接时只是"停止接受新连接"，
       * 它的回调要等最后一个连接结束才触发。先调 close 再断连接，中间那个
       * 窗口里 `await` 会一直挂着。而且即使断了，若某个响应正写到一半，
       * 回调也可能迟迟不来——所以再加一个有上限的等待兜底：卸载一个本地
       * 回环服务不值得无限期阻塞宿主。
       */
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
      for (const socket of connections) socket.destroy()
      connections.clear()
      await new Promise((resolve) => {
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          resolve()
        }
        server.close(finish)
        const timer = setTimeout(finish, 2000)
        timer.unref?.()
      })
    },
  }
}

/**
 * 一条请求的分发。
 *
 * 只实现两个端点：
 *   `GET  /v1/models`            模型目录
 *   `POST /v1/chat/completions`  对话（`stream: true` 时走 SSE）
 *
 * 其余一律 404，且**不**回显路径——回显会让本机能探测到桥在跑什么版本。
 */
async function handleRequest(request, response, context) {
  const url = new URL(request.url ?? '/', `http://${BIND_ADDRESS}`)

  // 健康检查：不需要 bearer，因为它不泄露任何东西，而 DSH 启动时的
  // "桥起来了没"探测如果也要带 token，会让时序问题变得难查。
  if (request.method === 'GET' && url.pathname === '/healthz') {
    writeJson(response, 200, { ok: true })
    return
  }

  if (!authorize(request, context.token)) {
    writeJson(response, 401, {
      error: { message: 'invalid or missing bearer token for the qwenwork bridge', type: 'authentication_error' },
    })
    return
  }

  if (request.method === 'GET' && url.pathname === '/v1/models') {
    const inventory = await context.resolveInventory()
    writeJson(response, 200, {
      object: 'list',
      data: inventory.map((model) => ({
        id: model.id,
        object: 'model',
        created: 0,
        owned_by: MODEL_OWNER,
        ...(model.name === undefined ? {} : { name: model.name }),
      })),
    })
    return
  }

  if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
    const body = await readJsonBody(request)
    if (body === undefined) {
      writeJson(response, 400, { error: { message: 'request body is not valid JSON', type: 'invalid_request_error' } })
      return
    }
    await handleCompletions(request, response, body, context)
    return
  }

  writeJson(response, 404, { error: { message: 'not found', type: 'not_found_error' } })
}

/**
 * 常量时间比较 bearer。
 *
 * 长度不同也必须走同一条路径：先比长度再比内容是常见的写法，但那会让
 * "长度对不对"变成一个可观测信号。这里把两边都补齐到同一长度再比。
 */
function authorize(request, token) {
  const header = request.headers.authorization
  if (typeof header !== 'string') return false
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (match === null) return false
  const offered = Buffer.from(match[1], 'utf8')
  const expected = Buffer.from(token, 'utf8')
  const length = Math.max(offered.length, expected.length)
  const left = Buffer.alloc(length, 0)
  const right = Buffer.alloc(length, 0)
  offered.copy(left)
  expected.copy(right)
  return timingSafeEqual(left, right) && offered.length === expected.length
}

/**
 * 读请求体。
 *
 * 上限 32 MiB：DSH 的上下文可能很大，但无上限会让一个坏客户端把桥吃光内存。
 * 超限直接 413，而不是截断——截断会让模型收到半截上下文并"合理"地答错。
 */
const MAX_BODY_BYTES = 32 * 1024 * 1024

async function readJsonBody(request) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) {
      throw new BridgeError(`request body exceeds ${MAX_BODY_BYTES} bytes`, 'PAYLOAD_TOO_LARGE')
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * `POST /v1/chat/completions`。
 *
 * 流式与非流式走**同一条**上游路径，只是出口不同：
 *   - `stream: true`  → SSE，逐 chunk 转发；
 *   - 否则            → 攒完再回一个完整 `chat.completion`。
 * 两条路共享 `context.stream`，所以不存在"流式能用、非流式走另一套"的分叉，
 * 那种分叉最容易让其中一个悄悄腐烂。
 */
async function handleCompletions(request, response, body, context) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const prompt = messagesToPrompt(messages, { maxBytes: PROMPT_BUDGET_BYTES })
  if (prompt.trim().length === 0) {
    writeJson(response, 400, {
      error: { message: 'no user-visible text in messages', type: 'invalid_request_error' },
    })
    return
  }

  const model = typeof body.model === 'string' && body.model.length > 0 ? body.model : defaultModelId(context)
  const stream = body.stream === true
  const id = `chatcmpl-${randomBytes(12).toString('hex')}`
  const created = Math.floor(Date.now() / 1000)

  // 客户端断开（DSH 取消、用户按停止）时必须让上游也停，否则会继续
  // 消耗用户的积分。`AbortController` 挂在 response 的 close 上。
  const controller = new AbortController()
  response.on('close', () => {
    if (!response.writableEnded) controller.abort()
  })

  const upstream = context.stream({
    prompt,
    modelId: model,
    signal: controller.signal,
    maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined,
  })

  if (!stream) {
    await writeBufferedCompletion(response, upstream, { id, created, model })
    return
  }
  await writeStreamingCompletion(response, upstream, { id, created, model })
}

/** 非流式：攒齐再回。`usage` 只在真的收到时才写，不编数字。 */
async function writeBufferedCompletion(response, upstream, meta) {
  let text = ''
  let reasoning = ''
  let usage
  let stopReason = 'end_turn'
  try {
    for await (const event of upstream) {
      if (event.type === 'text') text += event.text
      else if (event.type === 'reasoning') reasoning += event.text
      else if (event.type === 'usage') usage = event.usage
      else if (event.type === 'done') stopReason = event.stopReason
    }
  } catch (error) {
    writeJson(response, 502, {
      error: { message: messageOf(error), type: 'upstream_error' },
    })
    return
  }
  writeJson(response, 200, {
    id: meta.id,
    object: 'chat.completion',
    created: meta.created,
    model: meta.model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: text,
        ...(reasoning.length === 0 ? {} : { reasoning_content: reasoning }),
      },
      finish_reason: finishReasonOf(stopReason),
    }],
    ...(usage === undefined ? {} : { usage: openAiUsage(usage) }),
  })
}

/**
 * 流式：写 SSE。
 *
 * 首个 chunk 先发 `role`，再逐段发 `content`，最后发 `finish_reason` +
 * `[DONE]`。顺序不是可选的：pi-ai 的组装器以"第一个带 role 的 delta"确立
 * 消息身份，中途补 role 会让它新建一条消息。
 *
 * `reasoning_content` 是 DeepSeek 系的扩展字段，pi-ai 认得它并映射成思考块。
 * 千问办公的 `agent_thought_chunk` 正好对应，所以思考内容不会丢。
 */
async function writeStreamingCompletion(response, upstream, meta) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // 关闭 nginx 之类的缓冲：不关的话增量会被攒住，表现为"不流式"。
    'X-Accel-Buffering': 'no',
  })

  const heartbeat = setInterval(() => {
    try {
      response.write(': keep-alive\n\n')
    } catch {
      clearInterval(heartbeat)
    }
  }, HEARTBEAT_MS)
  heartbeat.unref?.()

  const base = { id: meta.id, object: 'chat.completion.chunk', created: meta.created, model: meta.model }

  const send = (payload) => {
    response.write(`data: ${JSON.stringify(payload)}\n\n`)
  }
  const delta = (value, finishReason) => send({
    ...base,
    choices: [{ index: 0, delta: value, finish_reason: finishReason ?? null }],
  })

  try {
    delta({ role: 'assistant' })
    let usage
    let stopReason = 'end_turn'
    for await (const event of upstream) {
      if (event.type === 'text') delta({ content: event.text })
      else if (event.type === 'reasoning') delta({ reasoning_content: event.text })
      else if (event.type === 'usage') usage = event.usage
      else if (event.type === 'done') stopReason = event.stopReason
    }
    if (usage !== undefined) {
      send({ ...base, choices: [], usage: openAiUsage(usage) })
    }
    delta({}, finishReasonOf(stopReason))
    response.write('data: [DONE]\n\n')
  } catch (error) {
    // 已经发了 200 和 SSE 头，没法再改状态码；用一条 error 事件把原因
    // 交给下游，然后正常收尾，避免下游读到一个永不结束的流。
    try {
      send({ error: { message: messageOf(error), type: 'upstream_error', code: errorCodeOf(error) } })
      response.write('data: [DONE]\n\n')
    } catch {
      // 下游已经断了，忽略。
    }
  } finally {
    clearInterval(heartbeat)
    try {
      response.end()
    } catch {
      // 同上。
    }
  }
}

function openAiUsage(usage) {
  return {
    prompt_tokens: usage.inputTokens ?? 0,
    completion_tokens: usage.outputTokens ?? 0,
    total_tokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
  }
}

function defaultModelId(context) {
  const inventory = context.resolveInventorySync?.()
  return inventory?.[0]?.id ?? FALLBACK_MODELS[0].id
}

function writeJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
  })
  response.end(body)
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function errorCodeOf(error) {
  return error instanceof AcpError ? error.code : 'UPSTREAM_ERROR'
}

/** 桥内部的错误（与上游错误区分开，便于定位是哪一侧的问题）。 */
export class BridgeError extends Error {
  constructor(message, code = 'BRIDGE_ERROR') {
    super(message)
    this.name = 'BridgeError'
    this.code = code
  }
}

/**
 * 造一个直接对外的客户端，把桥的两个依赖（目录、流）绑到 ACP 客户端上。
 *
 * 单独抽出来，是为了让"桥"和"上游"能各自被测试：桥的测试注入一个假的
 * `stream`，上游的测试注入一个假的 socket。
 */
export function createUpstream(options) {
  const client = new QwenWorkAcpClient(options)
  return {
    client,
    stream: ({ prompt, modelId, signal }) => client.prompt(prompt, { modelId, signal }),
    inventory: () => FALLBACK_MODELS,
    close: () => client.close(),
  }
}

/** 供测试注入。 */
export const internal = Object.freeze({
  authorize,
  readJsonBody,
  modelOwner: MODEL_OWNER,
  maxBodyBytes: MAX_BODY_BYTES,
})
