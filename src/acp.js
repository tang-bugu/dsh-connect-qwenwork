/**
 * 千问办公上游客户端 —— 真机协议实现（2026-10-22 实测）。
 *
 * ## 这份文件是根据实测重写的，不是从 bundle 推断的
 *
 * 早期版本按 ACP 标准实现：`initialize` / `session/new` / `session/prompt`，
 * 裸 JSON-RPC 帧，Cookie 认证。真机验证**逐条推翻了它们**：
 *
 * | 假设 | 实测结果 |
 * |---|---|
 * | 裸 JSON-RPC 帧 | `{"code":-32700,"message":"unknown envelope type"}` |
 * | `initialize` | `{"code":-32700,"message":"Unknown control method: initialize"}` |
 * | `session/prompt` | `{"code":-32700,"message":"Unknown control method: session/prompt"}` |
 * | Cookie 认证 | 401 |
 *
 * 真实的握手是一串**命名控制帧**，成功路径如下（全部实测通过）：
 *
 *   POST /api/chat-sessions  → 201 { id }        建会话（REST，Bearer）
 *   → wss://qwenwork.cn/api/chat-ws              Bearer 认证，握手成功
 *   → {type:"control", payload:{method:"ping"}}  → pong
 *   → {type:"control", payload:{method:"join", params:{sessionId}}}
 *                                               → join_ack { accepted:true }
 *   → {type:"control", payload:{method:"new_prompt",
 *                               params:{sessionId, prompt:[{type:"text",…}]}}}
 *                                               → result { promptId, turnId }
 *                                               → new_prompt_ack { accepted:true }
 *   → {type:"data", seq, payload:{method:"session/update",
 *                                 params:{update:{sessionUpdate:"agent_message_chunk",
 *                                                 content:{type:"text", text:"…"}}}}}
 *                                               ← 正文增量（可多段）
 *   → session_status → idle                      本轮结束
 *
 * 实测的一次完整回复（要求模型回答 `PONG123`）依次收到
 * `agent_thought_chunk("The user wants me to…")`、
 * `agent_message_chunk("P")`、`agent_message_chunk("ONG123")`。
 *
 * ## 两层结构
 *
 * 1. **信封层**（control / data）：服务器只认 `{type, payload}`，裸 JSON-RPC
 *    一律 -32700。这一层是本模块自己的事。
 * 2. **载荷层**：`payload` 还是 JSON-RPC 2.0（`jsonrpc/id/method/params`）。
 *    只有 `session/update` 这类**通知**才走 `data` 帧，且带 `seq`。
 *
 * @module dsh-connect-qwenwork/acp
 */

import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'

import { WsClient } from './wsclient.js'

/** 上游站点。 */
export const QWENWORK_ORIGIN = 'https://qwenwork.cn'

/** 会话通道路径（实测）。 */
export const QWENWORK_WS_PATH = '/api/chat-ws'

/** 建会话 / 身份探测的 REST 路径。 */
export const QWENWORK_SESSIONS_PATH = '/api/chat-sessions'
export const QWENWORK_IDENTITY_PATH = '/biz/user/v1/auth/me'

/** 信封类型。实测枚举只此两个。 */
export const ENVELOPE = Object.freeze({ CONTROL: 'control', DATA: 'data' })

/**
 * 控制方法。实测自客户端 bundle 的 `Cr` 常量表，并在真机上逐个验证过
 * 实际用到的那几个（`ping`/`join`/`new_prompt` 均成功）。
 */
export const CONTROL = Object.freeze({
  PING: 'ping',
  PONG: 'pong',
  JOIN: 'join',
  JOIN_ACK: 'join_ack',
  LEAVE: 'leave',
  NEW_PROMPT: 'new_prompt',
  NEW_PROMPT_ACK: 'new_prompt_ack',
  CANCEL: 'cancel',
  CANCEL_ACK: 'cancel_ack',
  REPLAY_START: 'replay_start',
  REPLAY_END: 'replay_end',
  SESSION_STATUS: 'session_status',
  SANDBOX_STATUS: 'sandbox_status',
  REFRESH_PROMPT_QUEUE: 'refresh_prompt_queue',
  QUESTION_RESPONSE: 'question_response',
  PUBLISH: 'publish',
  PUBLISH_ACK: 'publish_ack',
  RENEW_TIMEOUT: 'renew_timeout',
  RESTART_ACP: 'restart_acp',
  CONTENT_BLOCKED: 'content_blocked',
})

/** 会话状态（`session_status` 的取值）。`idle` 表示本轮已完成。 */
export const SESSION_STATUS = Object.freeze({
  STARTING: 'starting', RUNNING: 'running', IDLE: 'idle',
})

/** `session/update` 的 `sessionUpdate` 取值里本插件消费的那些。 */
export const SESSION_UPDATE_KINDS = Object.freeze({
  AGENT_MESSAGE: 'agent_message_chunk',
  AGENT_THOUGHT: 'agent_thought_chunk',
  USER_MESSAGE: 'user_message_chunk',
  USAGE: 'usage_update',
  TOOL_CALL: 'tool_call',
  TOOL_CALL_UPDATE: 'tool_call_update',
  PLAN: 'plan',
})

/** 建会话超时。REST，正常几百毫秒。 */
export const SESSION_TIMEOUT_MS = 60000

/**
 * 一轮 prompt 的总超时。
 *
 * 实测：一次只要求输出 `PONG123` 的回复约 9 秒（会话是"启动沙箱"型，
 * 有固定开销）。给足余量，因为真实任务可能长得多。
 */
export const PROMPT_TIMEOUT_MS = 15 * 60 * 1000

/**
 * 一条 idle 在没有任何活动迹象时要等多久才认。
 *
 * 实测 `idle → running` 会串行到达，要区分「上一轮遗留的 idle」与「真的结束」
 * 只能靠"后面还有没有东西"。几十毫秒对真实延迟没有感知，但足以分开两者。
 */
export const IDLE_GRACE_MS = 60

/** 等 `idle` 的超时；比总超时短一点，好先报"卡住了"而不是"超时了"。 */
export const IDLE_TIMEOUT_MS = 14 * 60 * 1000

/** 上游 `stopReason` → OpenAI `finish_reason`。 */
export function finishReasonOf(stopReason) {
  switch (stopReason) {
    case 'end_turn':
    case 'max_turn_requests':
    case 'cancelled':
      return 'stop'
    case 'max_tokens':
      return 'length'
    case 'refusal':
      return 'content_filter'
    default:
      return 'stop'
  }
}

/**
 * 组装一个 **control** 信封。实测：不带 id 是通知，带 id 是请求。
 */
export function controlEnvelope(method, params, id) {
  const payload = { jsonrpc: '2.0', method }
  if (params !== undefined) payload.params = params
  if (id !== undefined) payload.id = id
  return { type: ENVELOPE.CONTROL, payload }
}

/** `new_prompt` 的参数。实测形状。 */
export function promptParams(sessionId, text) {
  return { sessionId, prompt: [{ type: 'text', text }] }
}

/**
 * 把 DSH 的 `messages` 压成一条 prompt 文本。
 *
 * 为什么压：`new_prompt` 是"新一轮用户输入"，不是完整对话。DSH 每轮会把
 * 完整历史发过来（它按无状态模型设计），两者的接缝就在这里。
 *
 * 保留角色与工具痕迹——丢掉它们模型就看不懂上下文里的工具结果。但**不**
 * 伪装成多轮结构（那需要复用同一个上游会话，见 `prompt()` 的说明）。
 */
export function messagesToPrompt(messages) {
  const parts = []
  for (const message of messages ?? []) {
    const role = String(message?.role ?? 'user')
    const text = contentToText(message?.content)
    if (text.length === 0) continue
    if (role === 'system' || role === 'developer') {
      parts.push(text)
      continue
    }
    if (role === 'assistant') {
      parts.push(`Assistant: ${text}`)
      continue
    }
    if (role === 'tool') {
      parts.push(`Tool result: ${text}`)
      continue
    }
    parts.push(text)
  }
  return parts.join('\n\n')
}

/** 把一个 content 数组/字符串折成纯文本。 */
export function contentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const out = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') out.push(block.text)
        break
      case 'tool-call':
      case 'tool_use':
        out.push(`[tool call ${block.name ?? block.toolName ?? ''}] ${stringify(block.arguments ?? block.input ?? {})}`)
        break
      case 'tool-result':
      case 'tool_result':
        out.push(`[tool result] ${contentToText(block.content) || stringify(block.result ?? {})}`)
        break
      case 'image':
      case 'file':
        // 不进入文本 prompt：模型能力未知，DSH 已在不支持图片的模型上降级。
        // 但显式留标记，免得模型对"这里原本有张图"一无所知。
        out.push(`[${block.type} omitted: ${block.mediaType ?? block.mimeType ?? 'unknown'}]`)
        break
      default:
        break
    }
  }
  return out.join('\n')
}

function stringify(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** 上游/协议层错误。`code` 是稳定分类。 */
export class AcpError extends Error {
  constructor(message, code = 'ACP_ERROR', data) {
    super(message)
    this.name = 'AcpError'
    this.code = code
    if (data !== undefined) this.data = data
  }
}

/**
 * 千问办公上游客户端。
 *
 * @param {object} options
 * @param {() => (object | undefined)} options.resolveCredential
 *   每次建连时调用（不缓存），返回带 `token` 的凭证对象。用户重新登录后
 *   无需重启。
 * @param {(message: string, error?: unknown) => void} [options.log]
 * @param {string} [options.wsUrl] 覆盖通道地址（诊断/测试用）
 * @param {string} [options.restOrigin] 覆盖 REST 站点（诊断/测试用）
 * @param {typeof WsClient} [options.WebSocketImpl]
 */
export class QwenWorkAcpClient extends EventEmitter {
  constructor(options) {
    super()
    this.options = options
    this.log = options.log ?? (() => {})
    this.restOrigin = options.restOrigin ?? QWENWORK_ORIGIN
    this.wsUrl = options.wsUrl ?? wsUrlFor(this.restOrigin)
    this.WebSocketImpl = options.WebSocketImpl ?? WsClient

    this.socket = undefined
    /** 已 join 的会话，按 sessionId 索引。 */
    this.sessions = new Map()
    /** 未完成的 JSON-RPC 请求，按 id 索引。 */
    this.pending = new Map()
    this.nextId = 1
    this.connectInflight = undefined
    this.closed = false
  }

  /** 认证头。实测上游要 Bearer，不是 Cookie。 */
  authorization() {
    const credential = this.options.resolveCredential()
    if (credential === undefined || credential === null) {
      throw new AcpError(
        'qwenwork: not signed in — no desktop credential was found. '
        + 'Sign in once through the QwenWork desktop app (or paste a token in this plugin\'s settings).',
        'MISSING_CREDENTIAL',
      )
    }
    const token = credential.token
    if (typeof token !== 'string' || token.length === 0) {
      throw new AcpError('qwenwork: the local credential holds no token', 'MISSING_CREDENTIAL')
    }
    return `Bearer ${token}`
  }

  /** 确保连接可用。并发调用共享同一次握手。 */
  async ensureConnected(signal) {
    if (this.closed) throw new AcpError('client is closed', 'CLIENT_CLOSED')
    if (this.socket !== undefined && this.socket.isOpen) return this.socket
    if (this.connectInflight !== undefined) return this.connectInflight
    this.connectInflight = this.connectOnce(signal).finally(() => {
      this.connectInflight = undefined
    })
    return this.connectInflight
  }

  async connectOnce(signal) {
    const authorization = this.authorization()
    const socket = new this.WebSocketImpl(this.wsUrl, {
      headers: {
        Authorization: authorization,
        Origin: this.restOrigin,
        'User-Agent': userAgent(),
        'Cache-Control': 'no-cache',
      },
      handshakeTimeoutMs: 20000,
      pingIntervalMs: 25000,
      pongTimeoutMs: 90000,
      perMessageDeflate: false,
    })
    this.socket = socket
    this.wireSocket(socket)
    await socket.connect()
    if (signal?.aborted) {
      socket.terminate()
      throw new AcpError('aborted', 'ABORTED')
    }
    // 实测：连上后服务器先给 pong（如果发过 ping）。这里主动 ping 一次，
    // 用它当作"链路真的活了"的确认——比只看 TCP 握手可靠。
    await this.ping().catch((error) => this.log('qwenwork: initial ping failed', error))
    return socket
  }

  wireSocket(socket) {
    socket.on('message', (text) => this.onWireMessage(text))
    socket.on('error', (error) => {
      this.log('qwenwork: websocket error', error)
      this.failAllPending(error)
      // `error` 没有监听器时 Node 会抛；本客户端常驻后台，连接被重置是常态。
      if (this.listenerCount('error') > 0) this.emit('error', error)
    })
    socket.on('close', (code, reason) => {
      for (const [sessionId] of this.sessions) this.emit('session-closed', sessionId)
      this.sessions.clear()
      this.failAllPending(new AcpError(`websocket closed (${code}) ${reason}`, 'STREAM_CLOSED'))
      if (this.socket === socket) this.socket = undefined
      this.emit('closed', code, reason)
    })
  }

  /**
   * 解一层信封，再按 content/method 分流。
   *
   * 三种入站形状（全部实测到）：
   *   - 对请求的响应：`{type:'control', payload:{jsonrpc, id, result|error}}`
   *   - 控制通知：    `{type:'control', payload:{jsonrpc, method, params}}`
   *   - 数据通知：    `{type:'data', seq, payload:{jsonrpc, method, params}}`
   */
  onWireMessage(text) {
    let envelope
    try {
      envelope = JSON.parse(text)
    } catch (error) {
      this.log('qwenwork: non-JSON frame ignored', error)
      return
    }
    if (envelope === null || typeof envelope !== 'object') return
    const type = envelope.type
    const payload = envelope.payload
    if (payload === null || typeof payload !== 'object') return

    // 响应：带 id 且带 result/error。
    if (payload.id !== undefined && ('result' in payload || 'error' in payload)) {
      const waiter = this.pending.get(payload.id)
      if (waiter === undefined) return
      this.pending.delete(payload.id)
      if (payload.error !== undefined && payload.error !== null) {
        waiter.reject(new AcpError(
          String(payload.error.message ?? 'upstream error'),
          String(payload.error.code ?? 'UPSTREAM_ERROR'),
          payload.error.data,
        ))
        return
      }
      waiter.resolve(payload.result)
      return
    }

    // 通知。
    if (typeof payload.method === 'string') {
      const method = payload.method
      const params = payload.params ?? {}
      if (method === 'session/update') {
        const sessionId = params.sessionId
        const update = params.update
        if (typeof sessionId === 'string' && update !== null && typeof update === 'object') {
          this.emit('update', sessionId, update)
        }
        return
      }
      this.emit('control', method, params, type)
      // 上游发来的**请求**（带 id 但没有 result/error）：必须回一个响应，
      // 否则上游会一直等，表现为挂起而不是报错。
      if (payload.id !== undefined) this.answerServerRequest(payload)
      return
    }

    if (payload.id !== undefined) this.answerServerRequest(payload)
  }

  /**
   * 回应上游发起的请求。
   *
   * 上游会问 `session/request_permission`（工具执行权限）。本插件把工具
   * **全部在本地执行**，上游不该拿到任何工具，也就永远不会合法地请求权限；
   * 真收到就拒绝——同意等于让上游在本插件不知情时驱动本地工具，那是错的
   * 授权方向。
   */
  answerServerRequest(payload) {
    const socket = this.socket
    if (socket === undefined || !socket.isOpen) return
    socket.sendText(JSON.stringify({
      type: ENVELOPE.CONTROL,
      payload: {
        jsonrpc: '2.0',
        id: payload.id,
        result: { outcome: 'rejected', reason: 'tools are executed locally by the host; no permission is granted' },
      },
    }))
  }

  failAllPending(error) {
    for (const [, waiter] of this.pending) waiter.reject(error)
    this.pending.clear()
  }

  /**
   * 发一个带 id 的控制请求并等响应。
   *
   * `signal` 只控制**等待**，不发 cancel：调用方超时后自己决定是否取消，
   * 因为"等太久了"与"不要这个结果了"是两回事。
   */
  async request(method, params, signal, timeoutMs = SESSION_TIMEOUT_MS) {
    const socket = await this.ensureConnected(signal)
    const id = this.nextId++
    const frame = controlEnvelope(method, params, id)
    return new Promise((resolve, reject) => {
      let timer
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer)
        this.pending.delete(id)
        signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = () => {
        cleanup()
        reject(new AcpError('aborted', 'ABORTED'))
      }
      if (signal?.aborted) {
        reject(new AcpError('aborted', 'ABORTED'))
        return
      }
      timer = setTimeout(() => {
        cleanup()
        reject(new AcpError(`qwenwork: "${method}" timed out after ${timeoutMs} ms`, 'TIMEOUT'))
      }, timeoutMs)
      timer.unref?.()
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        resolve: (result) => {
          cleanup()
          resolve(result)
        },
        reject: (error) => {
          cleanup()
          reject(error)
        },
      })
      try {
        socket.sendText(JSON.stringify(frame))
      } catch (error) {
        cleanup()
        reject(error instanceof Error ? error : new AcpError(String(error), 'SEND_FAILED'))
      }
    })
  }

  /** 发一个**不带 id** 的通知（不等响应）。 */
  async notify(method, params) {
    const socket = await this.ensureConnected()
    socket.sendText(JSON.stringify(controlEnvelope(method, params)))
  }

  /** 心跳。实测 `ping` → `pong`。 */
  async ping() {
    // 不用 `request()`：`pong` 是不带 id 的通知，没有响应可等。
    const socket = await this.ensureConnected()
    socket.sendText(JSON.stringify(controlEnvelope(CONTROL.PING)))
  }

  /**
   * 用 REST 建一个会话。
   *
   * 实测：`POST /api/chat-sessions` 带 Bearer 返回 201，body 里 `id` 是
   * 会话 id。WS 侧的 `join` 用的就是它。
   *
   * `_meta` 里那个 `{"mode":"flash"}` 是上游自己写的（`extra_data.mode`），
   * 不传也可以——所以这里只发一个最小 body，不猜上游的内部字段。
   */
  async createSession(signal) {
    const authorization = this.authorization()
    const response = await fetch(new URL(QWENWORK_SESSIONS_PATH, this.restOrigin), {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Origin: this.restOrigin,
        Referer: `${this.restOrigin}/`,
        'User-Agent': userAgent(),
      },
      body: JSON.stringify({}),
      signal,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new AcpError(
        `qwenwork: could not create a chat session (HTTP ${response.status})${text.length === 0 ? '' : `: ${text.slice(0, 200)}`}`,
        response.status === 401 || response.status === 403 ? 'MISSING_CREDENTIAL' : 'SESSION_CREATE_FAILED',
      )
    }
    const body = await response.json().catch(() => undefined)
    const sessionId = body?.id ?? body?.sessionId ?? body?.data?.id
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new AcpError('qwenwork: the session endpoint returned no id', 'BAD_UPSTREAM_RESPONSE')
    }
    return sessionId
  }

  /**
   * join 一个会话并等 `join_ack`。
   *
   * 实测：`join_ack` 是**通知**（`params.accepted`），不是对某个 id 的响应，
   * 所以不能走 `request()`，要等事件。
   */
  async joinSession(sessionId, signal, timeoutMs = SESSION_TIMEOUT_MS) {
    const socket = await this.ensureConnected(signal)
    return new Promise((resolve, reject) => {
      const onControl = (method, params) => {
        if (method !== CONTROL.JOIN_ACK) return
        if (params?.sessionId !== sessionId) return
        cleanup()
        if (params.accepted === true) resolve(params)
        else reject(new AcpError('qwenwork: the upstream refused to join the session', 'JOIN_REJECTED', params))
      }
      const onClose = () => {
        cleanup()
        reject(new AcpError('qwenwork: the socket closed while joining', 'STREAM_CLOSED'))
      }
      let timer
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer)
        this.off('control', onControl)
        this.off('closed', onClose)
        signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = () => {
        cleanup()
        reject(new AcpError('aborted', 'ABORTED'))
      }
      timer = setTimeout(() => {
        cleanup()
        reject(new AcpError(`qwenwork: join timed out after ${timeoutMs} ms`, 'TIMEOUT'))
      }, timeoutMs)
      timer.unref?.()
      signal?.addEventListener('abort', onAbort, { once: true })
      this.on('control', onControl)
      this.on('closed', onClose)
      socket.sendText(JSON.stringify(controlEnvelope(CONTROL.JOIN, { sessionId }, this.nextId++)))
    })
  }

  /**
   * 一轮对话。
   *
   * 产出归一化事件：
   *   `{ type: 'text', text }` / `{ type: 'reasoning', text }`
   *   `{ type: 'usage', usage }` / `{ type: 'done', stopReason, sessionId }`
   *
   * ## 结束条件
   *
   * 实测：`new_prompt` 的响应立刻回来（`{promptId, turnId}`），**正文靠
   * `session/update` 推送**，本轮真正结束的标志是 `session_status: idle`。
   * 所以这里等 idle，而不是等那个响应——等响应会立刻结束，什么也收不到。
   *
   * ## 每条请求一个新会话
   *
   * 复用会话会把上一轮的完整历史再跑一遍（上游会话是有状态的 agent 会话），
   * 等于重复计费。DSH 自己就是"每轮发完整 messages"，压成一条 prompt 才是
   * 正确的接缝。
   */
  async *prompt(text, options = {}) {
    const { signal } = options
    const sessionId = await this.createSession(signal)
    const queue = createUpdateQueue(this, sessionId)

    /**
     * 本轮的结束判据（三种，全部来自实测）。
     *
     * 实测的时间线是：
     *
     *   join            -> join_ack
     *   new_prompt      -> result{promptId,turnId}     只是"接受了"
     *                   -> session_status: idle          **上一轮遗留，必须忽略**
     *                   -> session_status: running       本轮真的开始
     *                   -> session/update: agent_thought_chunk
     *                   -> session/update: agent_message_chunk
     *                   -> session_status: idle           **本轮结束**
     *
     * 所以判据是"本轮出现过 running 或正文增量之后的 idle"。
     * 只看 idle 会把那条遗留的当作结束，表现为"成功但正文为空"——这是
     * 本文件历史上真实发生过的 bug。
     *
     * 另外两条结束路径：
     *   - 断线：置 closedEarly，必须报错而不是假装成功；
     *   - 超时：IDLE_TIMEOUT_MS 兜底，防止上游干脆不发收尾。
     */
    let started = false
    let progress = false
    /**
     * "本轮跑过之后"的那条 idle 是否已经到达。
     *
     * 单独记一个标志，是因为它有**两种到达时机**：可能在 `new_prompt` 的
     * 响应落定之前就冲进来（短回复），也可能在之后。前者若不记下来，响应
     * 落定后的补判会以为"还没收尾"，然后等满 IDLE_TIMEOUT——而真正的收尾
     * 早就过去了。
     */
    let idleAfterProgress = false
    let closedEarly = false
    let finished = false

    const finish = () => {
      if (finished) return
      finished = true
      queue.end()
    }

    /**
     * 活动证据**不**要求 `started` 已经为真。
     *
     * 实测里短回复的时间线是 `running` → 正文 → `idle` → **响应**，
     * 即响应反而是最后到的那一个。若把 `started` 当成记录活动的前提，
     * 这三条证据会全被丢掉，然后真正的收尾 idle 因为"没见过活动"被忽略，
     * 本轮到 idle 超时才结束——表现为"卡住"。
     *
     * 唯一的噪声是**遗留 idle**，它由"必须见过活动"这条挡掉，不需要
     * 再叠一个 `started`。
     */
    const onControl = (method, params) => {
      if (method !== CONTROL.SESSION_STATUS) return
      if (params?.sessionId !== sessionId) return
      if (params.sessionStatus === SESSION_STATUS.RUNNING) {
        progress = true
        return
      }
      if (params.sessionStatus !== SESSION_STATUS.IDLE) return
      // 只有"本轮确实跑过"之后的 idle 才是收尾。
      if (progress) {
        idleAfterProgress = true
        finish()
      }
    }
    const onUpdate = (id, update) => {
      if (id !== sessionId) return
      const kind = update?.sessionUpdate
      if (kind !== SESSION_UPDATE_KINDS.AGENT_MESSAGE && kind !== SESSION_UPDATE_KINDS.AGENT_THOUGHT) return
      // 只记"本轮真的产出过内容"，**不**在这里结束：增量可以有很多条，
      // 在第一条就 finish 会把回复截断成第一个字。
      progress = true
    }
    const onClosed = () => {
      // 先置标志再关队列：queue.end() 会同步唤醒等待者。
      closedEarly = true
      finish()
    }

    this.on('control', onControl)
    this.on('update', onUpdate)
    this.on('closed', onClosed)

    let failure
    try {
      await this.joinSession(sessionId, signal)

      /**
       * 请求与消费**并发**，不能先 await 再读队列。
       *
       * 先 await 的写法会让整条流退化成"等响应落定后一次性吐出"——在长
       * 回复上表现为界面上几分钟没有任何输出，然后突然全文出现。而
       * `session/prompt` 的响应本来就要等到整轮结束才回来，正文是靠
       * `session/update` 在它**之前**陆续推来的。
       *
       * 所以：把请求的落定值接进一个 promise（不阻塞生成器），同时开始
       * 消费队列。队列的结束由 onControl/onUpdate/onClosed/超时驱动。
       */
      const settled = this.request(
        CONTROL.NEW_PROMPT,
        promptParams(sessionId, text),
        signal,
        PROMPT_TIMEOUT_MS,
      ).then(
        () => {
          started = true
          if (idleAfterProgress) finish()
          return { ok: true }
        },
        (error) => {
          started = true
          finish()
          return { ok: false, error }
        },
      )

      const idleTimer = setTimeout(finish, IDLE_TIMEOUT_MS)
      idleTimer.unref?.()
      try {
        for await (const event of queue.iterate()) yield event
      } finally {
        clearTimeout(idleTimer)
      }

      const outcome = await settled
      if (!outcome.ok) {
        throw outcome.error instanceof Error
          ? outcome.error
          : new AcpError(String(outcome.error), 'PROMPT_REJECTED')
      }
    } catch (error) {
      failure = error
      finish()
    } finally {
      this.off('control', onControl)
      this.off('update', onUpdate)
      this.off('closed', onClosed)
      await this.leaveSession(sessionId).catch(() => {})
    }

    if (failure !== undefined) throw failure
    if (closedEarly) {
      // 断线不能假装成功：调用方需要知道这一轮没跑完。
      throw new AcpError('qwenwork: the connection closed before the turn finished', 'STREAM_CLOSED')
    }
    yield { type: 'done', sessionId, stopReason: 'end_turn' }
  }

  /** 退出会话。失败不抛：会话是服务端资源，超时会自己回收。 */
  async leaveSession(sessionId) {
    if (!this.sessions.has(sessionId)) {
      // 即使没在 sessions 表里也发一次：服务端可能记着。
      try {
        await this.notify(CONTROL.LEAVE, { sessionId })
      } catch {
        // 连接已断，忽略。
      }
      return
    }
    this.sessions.delete(sessionId)
    try {
      await this.notify(CONTROL.LEAVE, { sessionId })
    } catch (error) {
      this.log('qwenwork: leave failed (the upstream reaps it eventually)', error)
    }
  }

  /** 只读身份探测。实测：Bearer → 200，body 含 `user_id`/`username`。 */
  async verifyCredential(credential, signal) {
    const target = new URL(QWENWORK_IDENTITY_PATH, this.restOrigin)
    const response = await fetch(target, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${credential.token}`,
        Origin: this.restOrigin,
        Referer: `${this.restOrigin}/`,
        'User-Agent': userAgent(),
      },
      signal,
    })
    if (response.status === 401 || response.status === 403) {
      return { ok: false, status: response.status, reason: 'the upstream rejected the token' }
    }
    if (!response.ok) {
      return { ok: false, status: response.status, reason: `unexpected status ${response.status}` }
    }
    const body = await response.json().catch(() => undefined)
    return {
      ok: true,
      status: response.status,
      identity: {
        userId: body?.user_id ?? body?.userId ?? body?.id,
        displayName: body?.username ?? body?.name,
        email: body?.email,
        phone: body?.phone,
      },
    }
  }

  close() {
    this.closed = true
    this.failAllPending(new AcpError('client closed', 'CLIENT_CLOSED'))
    const socket = this.socket
    this.socket = undefined
    if (socket !== undefined) {
      try {
        socket.close(1000, 'client shutdown')
      } catch {
        socket.terminate()
      }
    }
  }
}

/**
 * 把一个"推送"变成"拉取"的队列。
 *
 * 上游的 `session/update` 是事件，而调用方要 `for await`。直接由事件驱动
 * 生成器会丢事件：从"发出 prompt"到"调用方开始迭代"之间有空窗。所以这里
 * 有显式缓冲。
 */
function createUpdateQueue(client, sessionId) {
  const buffered = []
  let waiter
  let finished = false

  const pump = () => {
    if (waiter === undefined) return
    const next = buffered.shift()
    if (next !== undefined) {
      const resolve = waiter
      waiter = undefined
      resolve({ value: next, done: false })
      return
    }
    if (finished) {
      const resolve = waiter
      waiter = undefined
      resolve({ value: undefined, done: true })
    }
  }

  const onUpdate = (id, update) => {
    if (id !== sessionId) return
    const event = normalizeUpdate(update)
    if (event === undefined) return
    buffered.push(event)
    pump()
  }
  client.on('update', onUpdate)

  return {
    end() {
      client.off('update', onUpdate)
      finished = true
      pump()
    },
    /**
     * 按到达顺序吐事件，**永不**抛异常。
     *
     * 错误不进这条通道：`prompt()` 在拿到请求的落定值后自己 throw，让错误
     * 只有一个来源。若这里也 throw，调用方会看到两个错误，而栈上那个
     * 往往不是真正的原因。
     */
    async *iterate() {
      for (;;) {
        const next = buffered.shift()
        if (next !== undefined) {
          yield next
          continue
        }
        if (finished) return
        const result = await new Promise((resolve) => {
          waiter = resolve
        })
        if (result.done === true) return
        yield result.value
      }
    },
  }
}

/** 轮询等到 `predicate()` 为真，或 aborted。 */
function waitFor(predicate, signal, intervalMs = 50) {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (signal?.aborted) {
        clearInterval(timer)
        resolve(undefined)
        return
      }
      if (predicate()) {
        clearInterval(timer)
        resolve(undefined)
      }
    }, intervalMs)
    timer.unref?.()
    signal?.addEventListener('abort', () => clearInterval(timer), { once: true })
  })
}

/**
 * 把一个 `session/update` 归一化。
 *
 * 返回 `undefined` 表示"与文本生成无关，丢掉"。丢掉而不是透传：桥的出口是
 * OpenAI 兼容流，非文本事件没有合法的表达形式，硬塞会让下游解析失败。
 */
export function normalizeUpdate(update) {
  if (update === null || typeof update !== 'object') return undefined
  const kind = update.sessionUpdate
  switch (kind) {
    case SESSION_UPDATE_KINDS.AGENT_MESSAGE: {
      const text = textOf(update.content)
      return text.length === 0 ? undefined : { type: 'text', text }
    }
    case SESSION_UPDATE_KINDS.AGENT_THOUGHT: {
      const text = textOf(update.content)
      return text.length === 0 ? undefined : { type: 'reasoning', text }
    }
    case SESSION_UPDATE_KINDS.USAGE: {
      const usage = usageOf(update)
      return usage === undefined ? undefined : { type: 'usage', usage }
    }
    case SESSION_UPDATE_KINDS.USER_MESSAGE:
      // 上游会回显用户消息；转发会让正文重复。
      return undefined
    default:
      return undefined
  }
}

function textOf(content) {
  if (content === null || typeof content !== 'object') return ''
  if (typeof content.text === 'string') return content.text
  if (Array.isArray(content)) return content.map(textOf).join('')
  return ''
}

function usageOf(update) {
  const input = numberOrUndefined(update.inputTokens ?? update.input_tokens ?? update.promptTokens)
  const output = numberOrUndefined(update.outputTokens ?? update.output_tokens ?? update.completionTokens)
  const total = numberOrUndefined(update.totalTokens ?? update.total_tokens)
  if (input === undefined && output === undefined && total === undefined) return undefined
  return {
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(total === undefined && input !== undefined && output !== undefined
      ? { totalTokens: input + output }
      : total === undefined ? {} : { totalTokens: total }),
  }
}

function numberOrUndefined(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** 默认 WS 地址。 */
export function wsUrlFor(origin = QWENWORK_ORIGIN) {
  const url = new URL(QWENWORK_WS_PATH, origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

/** 与桌面客户端一致的 UA。 */
function userAgent() {
  return 'QwenWork/1.0 (dsh-connect-qwenwork)'
}

export const internal = Object.freeze({
  createUpdateQueue,
  textOf,
  usageOf,
  userAgent,
  waitFor,
  randomUUID,
})
