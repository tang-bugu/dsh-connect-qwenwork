/**
 * ACP 客户端自测：`node src/acp.test.mjs`
 *
 * 用假的 WebSocket 实现替换真实连接，验证**协议行为**：信封分流、
 * `session/update` 归一化、prompt 生命周期、以及"上游发来请求时怎么回"。
 *
 * 这里的每个方法名都是 2026-10-22 在真机上验证过的，不是从 ACP 标准抄的：
 * 标准里的 `initialize` / `session/new` / `session/prompt` 一律被上游以
 * `Unknown control method` 拒绝（见 `acp.js` 模块头的对照表）。
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import {
  CONTROL,
  controlEnvelope,
  contentToText,
  finishReasonOf,
  messagesToPrompt,
  normalizeUpdate,
  promptParams,
  QwenWorkAcpClient,
} from './acp.js'

const results = []
let failures = 0

async function test(name, body) {
  process.stdout.write(`  ... ${name}\n`)
  try {
    await body()
    results.push(`PASS  ${name}`)
  } catch (error) {
    failures += 1
    results.push(`FAIL  ${name}\n        ${error instanceof Error ? error.message : String(error)}`)
  }
}

/* ------------------------------------------------------------------ *
 * 测试辅助
 * ------------------------------------------------------------------ */

class FakeSocket extends EventEmitter {
  constructor(url, options) {
    super()
    this.url = url
    this.options = options
    this.isOpen = false
    this.sent = []
    this.onSend = undefined
  }

  async connect() {
    this.isOpen = true
    this.emit('open')
    return undefined
  }

  sendText(text) {
    if (!this.isOpen) throw new Error('socket is not open')
    const frame = JSON.parse(text)
    this.sent.push(frame)
    this.onSend?.(frame, this)
  }

  close() {
    this.isOpen = false
    this.emit('close', 1000, '', true)
  }

  terminate() {
    this.isOpen = false
    this.emit('close', 1006, '', false)
  }

  deliver(payload) {
    this.emit('message', JSON.stringify(payload))
  }
}

/**
 * 造一个客户端与它的假 socket。
 *
 * 桩的 REST 侧也被替换：`createSession` 走 HTTP，而本测试不联网。
 */
function makeClient(overrides = {}) {
  let socket
  const holder = { onSend: undefined }
  const credential = {
    token: 'test-token',
    authorization: () => 'Bearer test-token',
    isExpired: () => false,
    describe: () => ({ source: 'test' }),
  }
  const client = new QwenWorkAcpClient({
    resolveCredential: () => credential,
    log: () => {},
    restOrigin: 'https://qwenwork.invalid',
    wsUrl: 'wss://qwenwork.invalid/api/chat-ws',
    ...overrides,
  })
  client.WebSocketImpl = class extends FakeSocket {
    constructor(url, options) {
      super(url, options)
      socket = this
      this.onSend = (frame) => holder.onSend?.(frame, this)
    }
  }
  const socketOf = () => socket
  const setOnSend = (fn) => {
    holder.onSend = fn
    if (socket !== undefined) socket.onSend = (frame) => holder.onSend?.(frame, socket)
  }
  return { client, socketOf, setOnSend }
}

/** 替换 `fetch`，只应答建会话。返回 restore。 */
function stubFetch(options = {}) {
  const { status = 201, body = { id: 'sess-1' } } = options
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/api/chat-sessions')) {
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response('{"error":"not found"}', { status: 404 })
  }
  return () => {
    globalThis.fetch = original
  }
}

/**
 * 假上游的标准应答：ping→pong、join→join_ack、new_prompt→result。
 *
 * `script(update, status, socket)` 负责产出增量与 idle。
 */
function autoAnswer(setOnSend, options = {}) {
  const { script } = options
  setOnSend((frame, socket) => {
    if (frame.type !== 'control') return
    const method = frame.payload?.method
    const params = frame.payload?.params ?? {}
    if (method === CONTROL.PING) {
      queueMicrotask(() => socket.deliver({
        type: 'control', payload: { jsonrpc: '2.0', method: CONTROL.PONG },
      }))
      return
    }
    if (method === CONTROL.JOIN) {
      queueMicrotask(() => socket.deliver({
        type: 'control',
        payload: { jsonrpc: '2.0', method: CONTROL.JOIN_ACK, params: { accepted: true, sessionId: params.sessionId } },
      }))
      return
    }
    if (method === CONTROL.NEW_PROMPT) {
      /**
       * 顺序刻意做成"增量先、响应后"。
       *
       * 真机上两者都在同一条连接上，谁先到不确定；本模块必须两种顺序都
       * 对。测试固定成"增量先到"这一种，因为它是最容易写错的：若实现是
       * "先 await 响应、再读队列"，这里就会变成"攒完再吐"，而下面那条
       * `deltas reach the consumer BEFORE ...` 用例正是钉这个的。
       */
      queueMicrotask(() => socket.deliver({
        type: 'control',
        payload: { jsonrpc: '2.0', id: frame.payload.id, result: { promptId: 'p1', sessionId: params.sessionId, turnId: 't1' } },
      }))
      /**
       * 增量与 status 必须在**响应之后**再推。
       *
       * 真机上 "prompt 响应" 与 "第一条增量/running" 都在同一条连接上，
       * 顺序不确定；而客户端把 `armed` 设在响应落定之后。若测试在上一条
       * microtask 里就把 `running` 推完，那条 `running` 会因为 `armed`
       * 还是 false 被丢掉，于是本轮的 idle 永远不满足结束条件——测试会挂住
       * 而不是失败（这正是本文件第一次运行时踩到的坑）。
       *
       * 用 `setTimeout(0)`（宏任务）保证跑到响应落定之后。
       */
      setTimeout(() => {
        const update = (body) => socket.deliver({
          type: 'data',
          seq: 1,
          payload: { jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: body } },
        })
        const status = (sessionStatus) => socket.deliver({
          type: 'control',
          payload: { jsonrpc: '2.0', method: CONTROL.SESSION_STATUS, params: { sessionId: params.sessionId, sessionStatus } },
        })
        status('running')
        script?.(update, status, socket)
      }, 0)
      return
    }
  })
}

const idle = (status) => status('idle')

/* ------------------------------------------------------------------ *
 * 纯函数
 * ------------------------------------------------------------------ */

await test('finishReasonOf maps every documented stopReason', () => {
  assert.equal(finishReasonOf('end_turn'), 'stop')
  assert.equal(finishReasonOf('max_tokens'), 'length')
  assert.equal(finishReasonOf('max_turn_requests'), 'stop')
  assert.equal(finishReasonOf('refusal'), 'content_filter')
  assert.equal(finishReasonOf('cancelled'), 'stop')
  assert.equal(finishReasonOf('something-new'), 'stop')
})

await test('controlEnvelope builds the exact shape the upstream accepts', () => {
  // 真机：裸 JSON-RPC 会被回 unknown envelope type，必须包一层 control。
  assert.deepEqual(controlEnvelope('ping'), { type: 'control', payload: { jsonrpc: '2.0', method: 'ping' } })
  assert.deepEqual(controlEnvelope('join', { sessionId: 's' }), {
    type: 'control',
    payload: { jsonrpc: '2.0', method: 'join', params: { sessionId: 's' } },
  })
  assert.deepEqual(controlEnvelope('new_prompt', { sessionId: 's' }, 7), {
    type: 'control',
    payload: { jsonrpc: '2.0', method: 'new_prompt', params: { sessionId: 's' }, id: 7 },
  })
})

await test('contentToText joins text blocks and keeps tool traces', () => {
  assert.equal(contentToText('plain'), 'plain')
  assert.equal(contentToText([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }]), 'one\ntwo')
  const withTool = contentToText([
    { type: 'tool-call', name: 'read', arguments: { path: 'a.txt' } },
    { type: 'tool-result', content: [{ type: 'text', text: 'ok' }] },
  ])
  assert.match(withTool, /tool call read/)
  assert.match(withTool, /tool result/)
  assert.match(withTool, /ok/)
})

await test('contentToText marks images instead of silently dropping them', () => {
  const text = contentToText([{ type: 'image', mediaType: 'image/png' }])
  assert.match(text, /image omitted/)
  assert.match(text, /image\/png/)
})

await test('messagesToPrompt labels assistant and tool turns', () => {
  const prompt = messagesToPrompt([
    { role: 'system', content: 'you are helpful' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'tool', content: 'result' },
  ])
  assert.match(prompt, /^you are helpful/)
  assert.match(prompt, /Assistant: hello/)
  assert.match(prompt, /Tool result: result/)
})

await test('messagesToPrompt skips empty turns entirely', () => {
  const prompt = messagesToPrompt([
    { role: 'user', content: '' },
    { role: 'user', content: [{ type: 'text', text: '' }] },
    { role: 'user', content: 'real' },
  ])
  assert.equal(prompt, 'real')
})

await test('promptParams only carries text blocks', () => {
  const params = promptParams('sess-1', 'hello')
  assert.equal(params.sessionId, 'sess-1')
  assert.deepEqual(params.prompt, [{ type: 'text', text: 'hello' }])
})

await test('normalizeUpdate keeps agent text and drops the user echo', () => {
  assert.deepEqual(
    normalizeUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } }),
    { type: 'text', text: 'a' },
  )
  assert.equal(
    normalizeUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'a' } }),
    undefined,
  )
})

await test('normalizeUpdate separates thought chunks from body text', () => {
  assert.deepEqual(
    normalizeUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 't' } }),
    { type: 'reasoning', text: 't' },
  )
})

await test('normalizeUpdate ignores updates with no usable text', () => {
  assert.equal(normalizeUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } }), undefined)
  assert.equal(normalizeUpdate({ sessionUpdate: 'plan' }), undefined)
  assert.equal(normalizeUpdate(null), undefined)
})

await test('usage_update maps token counts and never invents zeros', () => {
  assert.deepEqual(
    normalizeUpdate({ sessionUpdate: 'usage_update', inputTokens: 3, outputTokens: 4 }),
    { type: 'usage', usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } },
  )
  assert.equal(normalizeUpdate({ sessionUpdate: 'usage_update' }), undefined)
})

/* ------------------------------------------------------------------ *
 * 连接与鉴权
 * ------------------------------------------------------------------ */

await test('a missing credential fails with MISSING_CREDENTIAL before any I/O', async () => {
  const client = new QwenWorkAcpClient({ resolveCredential: () => undefined, log: () => {} })
  await assert.rejects(() => client.ensureConnected(), (error) => error.code === 'MISSING_CREDENTIAL')
})

await test('the handshake sends Authorization: Bearer, never a Cookie', async () => {
  const { client, socketOf } = makeClient()
  autoAnswer(() => {})
  await client.ensureConnected()
  const headers = socketOf().options.headers
  assert.equal(headers.Authorization, 'Bearer test-token')
  assert.equal(headers.Cookie, undefined, 'the real upstream authenticates with Bearer, not a cookie')
  client.close()
})

/* ------------------------------------------------------------------ *
 * prompt 生命周期
 * ------------------------------------------------------------------ */

await test('a prompt yields deltas then a done event', async () => {
  const restore = stubFetch()
  const { client, setOnSend } = makeClient()
  autoAnswer(setOnSend, {
    script: (update, status) => {
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } })
      idle(status)
    },
  })
  const events = []
  try {
    for await (const event of client.prompt('hi', {})) events.push(event)
  } finally {
    restore()
    client.close()
  }
  assert.deepEqual(events.filter((event) => event.type === 'text').map((event) => event.text), ['done'])
  assert.equal(events.at(-1).type, 'done')
})

await test('deltas reach the consumer BEFORE the prompt response settles', async () => {
  const restore = stubFetch()
  const { client, setOnSend } = makeClient()
  let promptReplied = false
  setOnSend((frame, socket) => {
    if (frame.type !== 'control') return
    const method = frame.payload?.method
    const params = frame.payload?.params ?? {}
    if (method === CONTROL.PING) {
      queueMicrotask(() => socket.deliver({ type: 'control', payload: { jsonrpc: '2.0', method: CONTROL.PONG } }))
      return
    }
    if (method === CONTROL.JOIN) {
      queueMicrotask(() => socket.deliver({
        type: 'control',
        payload: { jsonrpc: '2.0', method: CONTROL.JOIN_ACK, params: { accepted: true, sessionId: params.sessionId } },
      }))
      return
    }
    if (method === CONTROL.NEW_PROMPT) {
      // 故意延后响应，模拟真实上游："先推增量，响应稍后到"。
      setTimeout(() => {
        promptReplied = true
        socket.deliver({
          type: 'control',
          payload: { jsonrpc: '2.0', id: frame.payload.id, result: { promptId: 'p1' } },
        })
      }, 80)
      queueMicrotask(() => {
        socket.deliver({
          type: 'data', seq: 1,
          payload: { jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'early' } } } },
        })
      })
      return
    }
  })
  const order = []
  const pending = (async () => {
    for await (const event of client.prompt('hi', {})) {
      if (event.type === 'text') order.push(`text:${event.text}`)
      if (event.type === 'done') order.push('done')
    }
  })()
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.deepEqual(order, ['text:early'], 'the delta must reach the consumer before the response settles')
  assert.equal(promptReplied, false, 'the response should still be in flight at this point')
  await new Promise((resolve) => setTimeout(resolve, 90))
  client.socket.deliver({
    type: 'control',
    payload: { jsonrpc: '2.0', method: CONTROL.SESSION_STATUS, params: { sessionId: 'sess-1', sessionStatus: 'idle' } },
  })
  await pending
  restore()
  client.close()
  assert.deepEqual(order, ['text:early', 'done'])
})

await test('a stale idle (before any activity) does not end the turn', async () => {
  // 真机踩到的坑：join 之后立刻收到一条上一轮遗留的 `idle`，把它当成本轮
  // 结束，就会在正文到达之前关掉队列 —— 表现是"成功但正文为空"。
  const restore = stubFetch()
  const { client, setOnSend } = makeClient()
  /**
   * 完全按实测的时间线推：`idle`（遗留）→ `running` → 正文 → `idle`。
   *
   * 用固定的宏任务节奏（而不是 autoAnswer 的 script 回调）是为了保证四条
   * 消息**按顺序**到达消费者，中间不被响应落定打断。
   */
  setOnSend((frame, socket) => {
    if (frame.type !== 'control') return
    const method = frame.payload?.method
    const params = frame.payload?.params ?? {}
    if (method === CONTROL.PING) {
      queueMicrotask(() => socket.deliver({ type: 'control', payload: { jsonrpc: '2.0', method: CONTROL.PONG } }))
      return
    }
    if (method === CONTROL.JOIN) {
      queueMicrotask(() => socket.deliver({
        type: 'control',
        payload: { jsonrpc: '2.0', method: CONTROL.JOIN_ACK, params: { accepted: true, sessionId: params.sessionId } },
      }))
      return
    }
    if (method !== CONTROL.NEW_PROMPT) return
    const status = (sessionStatus) => socket.deliver({
      type: 'control',
      payload: { jsonrpc: '2.0', method: CONTROL.SESSION_STATUS, params: { sessionId: params.sessionId, sessionStatus } },
    })
    const update = (body) => socket.deliver({
      type: 'data',
      seq: 1,
      payload: { jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: body } },
    })
    // 遗留 idle 抢在响应之前到 —— 这是实测的形状。
    status('idle')
    socket.deliver({
      type: 'control',
      payload: { jsonrpc: '2.0', id: frame.payload.id, result: { promptId: 'p1' } },
    })
    status('running')
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'real' } })
    status('idle')
  })
  const events = []
  try {
    for await (const event of client.prompt('hi', {})) events.push(event)
  } finally {
    restore()
    client.close()
  }
  const text = events.filter((event) => event.type === 'text').map((event) => event.text).join('')
  assert.equal(text, 'real', 'an idle that arrives before any activity must not close the turn')
})

await test('updates for another session are ignored', async () => {
  const restore = stubFetch()
  const { client, setOnSend } = makeClient()
  autoAnswer(setOnSend, {
    script: (update, status, socket) => {
      socket.deliver({
        type: 'data', seq: 9,
        payload: { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'other-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'nope' } } } },
      })
      idle(status)
    },
  })
  const events = []
  try {
    for await (const event of client.prompt('hi', {})) events.push(event)
  } finally {
    restore()
    client.close()
  }
  assert.equal(events.filter((event) => event.type === 'text').length, 0)
})

await test('an upstream request for permission is answered with a rejection', async () => {
  const restore = stubFetch()
  const { client, setOnSend } = makeClient()
  autoAnswer(setOnSend, {
    script: (update, status) => {
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } })
      idle(status)
    },
  })
  const pending = (async () => {
    for await (const _ of client.prompt('hi', {})) { /* drain */ }
  })()
  // 先等这一轮跑起来，再模拟上游在会话中途发来一个带 id 的请求。
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (client.socket?.sent.some((frame) => frame.payload?.method === CONTROL.NEW_PROMPT)) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  client.socket.deliver({
    type: 'control',
    payload: { jsonrpc: '2.0', id: 'server-1', method: 'session/request_permission', params: { sessionId: 'sess-1' } },
  })
  await pending
  const answer = client.socket.sent.find((frame) => frame.payload?.id === 'server-1')
  restore()
  client.close()
  assert.ok(answer !== undefined, 'the client must answer a server request')
  assert.equal(answer.payload.result.outcome, 'rejected')
})

await test('a non-JSON frame does not break the connection', async () => {
  const { client, socketOf } = makeClient()
  autoAnswer(() => {})
  await client.ensureConnected()
  const socket = socketOf()
  socket.emit('message', 'this is not json')
  socket.emit('message', '{"type":"control","payload":{}}')
  assert.equal(socket.isOpen, true)
  client.close()
})

await test('a socket that dies mid-turn fails the turn instead of hanging', async () => {
  const restore = stubFetch()
  const { client, setOnSend } = makeClient()
  /**
   * 场景：`new_prompt` 还没被应答，连接就断了。
   *
   * 这是断线**必须**报错的形状：上游从没确认过这一轮，等待方若被当成
   * "正常结束"，调用方会拿到一个空回复并以为模型什么都没说。
   *
   * 反过来说，若 `new_prompt` 已经应答、只是正文没推完就断线，本模块的
   * 处理是"以已收到的内容收尾"——那是可接受的（内容是真的），所以那个
   * 形状不在本用例里。
   */
  setOnSend((frame, socket) => {
    if (frame.type !== 'control') return
    const method = frame.payload?.method
    const params = frame.payload?.params ?? {}
    if (method === CONTROL.PING) {
      queueMicrotask(() => socket.deliver({ type: 'control', payload: { jsonrpc: '2.0', method: CONTROL.PONG } }))
      return
    }
    if (method === CONTROL.JOIN) {
      queueMicrotask(() => socket.deliver({
        type: 'control',
        payload: { jsonrpc: '2.0', method: CONTROL.JOIN_ACK, params: { accepted: true, sessionId: params.sessionId } },
      }))
      return
    }
    // new_prompt：故意不应答。
  })
  const pending = (async () => {
    for await (const _ of client.prompt('hi', {})) { /* drain */ }
  })()
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (client.socket?.sent.some((frame) => frame.payload?.method === CONTROL.NEW_PROMPT)) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  client.socket.terminate()
  await assert.rejects(pending, (error) => error.code === 'STREAM_CLOSED' || error.code === 'CLIENT_CLOSED' || /closed/i.test(error.message))
  restore()
  client.close()
})

await test('createSession surfaces an HTTP failure as MISSING_CREDENTIAL on 401', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response('{"error":"unauthorized"}', { status: 401 })
  try {
    const client = new QwenWorkAcpClient({
      resolveCredential: () => ({ token: 't', authorization: () => 'Bearer t' }),
      log: () => {},
      restOrigin: 'https://qwenwork.invalid',
    })
    await assert.rejects(() => client.createSession(), (error) => error.code === 'MISSING_CREDENTIAL')
  } finally {
    globalThis.fetch = original
  }
})

await test('verifyCredential reports a rejected token as ok:false', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response('{}', { status: 401 })
  try {
    const client = new QwenWorkAcpClient({
      resolveCredential: () => ({ token: 't' }),
      log: () => {},
      restOrigin: 'https://qwenwork.invalid',
    })
    const verdict = await client.verifyCredential({ token: 't' })
    assert.equal(verdict.ok, false)
    assert.equal(verdict.status, 401)
  } finally {
    globalThis.fetch = original
  }
})

await test('verifyCredential returns the identity on success', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ user_id: 'u1', username: 'bugu' }), { status: 200 })
  try {
    const client = new QwenWorkAcpClient({
      resolveCredential: () => ({ token: 't' }),
      log: () => {},
      restOrigin: 'https://qwenwork.invalid',
    })
    const verdict = await client.verifyCredential({ token: 't' })
    assert.equal(verdict.ok, true)
    assert.equal(verdict.identity.userId, 'u1')
    assert.equal(verdict.identity.displayName, 'bugu')
  } finally {
    globalThis.fetch = original
  }
})

/* ------------------------------------------------------------------ */

process.stdout.write(`\n${results.join('\n')}\n\n`)
process.stdout.write(failures === 0
  ? `acp: all ${results.length} cases passed\n`
  : `acp: ${failures} of ${results.length} cases FAILED\n`)
process.exitCode = failures === 0 ? 0 : 1
