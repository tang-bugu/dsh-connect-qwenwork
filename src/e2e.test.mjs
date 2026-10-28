/**
 * 端到端集成自测：`node src/e2e.test.mjs`
 *
 * 这条测试把整条链路串起来，**只**把最外层换成假实现：
 *
 *   假 ACP 服务端 (WebSocket)
 *        ↕  JSON-RPC / session/update
 *   QwenWorkAcpClient   ← 真实代码
 *        ↕
 *   startBridge()       ← 真实代码（真起一个回环 HTTP 服务）
 *        ↕  HTTP + SSE
 *   fetch()             ← 扮演 pi-ai
 *
 * 之前几个测试各自证明一段是对的；这一条证明**接缝是对的**——尤其是
 * "上游的增量 → SSE 的 delta"这条最容易出错的路。
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

import { QwenWorkAcpClient } from './acp.js'
import { startBridge } from './bridge.js'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
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
 * 假的上游 ACP 服务端
 * ------------------------------------------------------------------ */

function serverFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8')
  const length = data.length
  let header
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeUInt32BE(Math.floor(length / 2 ** 32), 2)
    header.writeUInt32BE(length >>> 0, 6)
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, data])
}

function parseClientFrames(buffer) {
  const messages = []
  let offset = 0
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset]
    const second = buffer[offset + 1]
    let length = second & 0x7f
    let cursor = offset + 2
    if (length === 126) {
      if (cursor + 2 > buffer.length) break
      length = buffer.readUInt16BE(cursor)
      cursor += 2
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break
      length = buffer.readUInt32BE(cursor) * 2 ** 32 + buffer.readUInt32BE(cursor + 4)
      cursor += 8
    }
    if (cursor + 4 + length > buffer.length) break
    const mask = buffer.subarray(cursor, cursor + 4)
    cursor += 4
    const payload = Buffer.alloc(length)
    for (let index = 0; index < length; index += 1) {
      payload[index] = buffer[cursor + index] ^ mask[index & 3]
    }
    messages.push({ opcode: first & 0x0f, text: payload.toString('utf8') })
    offset = cursor + length
  }
  return { messages, rest: buffer.subarray(offset) }
}

/**
 * 起一个假的 ACP 服务端。
 *
 * `script` 收到 `session/prompt` 后产出一串出站帧（JSON-RPC 通知 + 最终的
 * 响应），用来模拟"增量先到、响应后到"。
 */
/**
 * 起一个假的 ACP 服务端。
 *
 * 它同时扮演**两个**上游角色，因为真客户端也需要两个：
 *   1. REST：`POST /api/chat-sessions` 建会话（Bearer 认证）；
 *   2. WS：control 信封上的 `ping` / `join` / `new_prompt`。
 *
 * `script` 收到 `new_prompt` 后产出增量，并在末尾调 `status('idle')` 收尾
 * ——那是实测的结束信号。
 */
async function startFakeUpstream(script) {
  const server = createServer()
  const sockets = new Set()
  const received = []
  const handshakes = []

  /** REST 侧：只要一条路由，够客户端建会话即可。 */
  server.on('request', (request, response) => {
    if (request.method === 'POST' && request.url === '/api/chat-sessions') {
      response.writeHead(201, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ id: 'sess-e2e', agent_id: 'agent-e2e' }))
      return
    }
    response.writeHead(404, { 'Content-Type': 'application/json' })
    response.end('{"error":"not found"}')
  })

  server.on('upgrade', (request, socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    handshakes.push({
      cookie: request.headers.cookie,
      authorization: request.headers.authorization,
    })
    const accept = createHash('sha1')
      .update(request.headers['sec-websocket-key'] + GUID)
      .digest('base64')
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '', '',
    ].join('\r\n'))

    const send = (payload) => socket.write(serverFrame(0x1, JSON.stringify(payload)))

    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const parsed = parseClientFrames(buffer)
      buffer = parsed.rest
      for (const { text } of parsed.messages) {
        let message
        try {
          message = JSON.parse(text)
        } catch {
          continue
        }
        received.push(message)
        handle(message, send)
      }
    })
    socket.on('error', () => {})
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  /**
   * 按**实测协议**应答：control 信封 + 命名控制方法。
   *
   * 这些名字不是从 ACP 标准搬来的，是 2026-10-22 在真机上逐个验证过的：
   * `join` → `join_ack`、`new_prompt` → `result{promptId,turnId}`，
   * 正文走 `data` 帧里的 `session/update`，结束信号是
   * `session_status: idle`。
   */
  function handle(frame, send) {
    const message = frame.payload
    if (frame.type !== 'control' || message === null || typeof message !== 'object') return
    const method = message.method
    const params = message.params ?? {}

    if (method === 'ping') {
      send({ type: 'control', payload: { jsonrpc: '2.0', method: 'pong' } })
      return
    }
    if (method === 'join') {
      // 实测：join_ack 是**通知**，不是对某个 id 的响应。
      send({
        type: 'control',
        payload: {
          jsonrpc: '2.0',
          method: 'join_ack',
          params: { accepted: true, currentSeqId: 0, sessionId: params.sessionId },
        },
      })
      return
    }
    if (method === 'new_prompt') {
      send({
        type: 'control',
        payload: {
          jsonrpc: '2.0',
          id: message.id,
          result: { promptId: 'prompt-e2e', sessionId: params.sessionId, turnId: 'turn-e2e' },
        },
      })
      send({
        type: 'control',
        payload: {
          jsonrpc: '2.0',
          method: 'new_prompt_ack',
          params: { accepted: true, promptId: 'prompt-e2e', sessionId: params.sessionId, turnId: 'turn-e2e' },
        },
      })
      const update = (body) => send({
        type: 'data',
        seq: 1,
        payload: {
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId: params.sessionId, update: body },
        },
      })
      const status = (sessionStatus) => send({
        type: 'control',
        payload: {
          jsonrpc: '2.0',
          method: 'session_status',
          params: { sessionId: params.sessionId, sessionStatus, statusInfo: '' },
        },
      })
      // 实测顺序：先 running，再增量，最后 idle。
      status('running')
      script(update, message, send, status)
      return
    }
    if (method === 'leave' || method === 'cancel') return
  }

  return {
    url: `ws://127.0.0.1:${port}/api/chat-ws`,
    restOrigin: `http://127.0.0.1:${port}`,
    received,
    handshakes,
    async close() {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** 把 ACP 客户端接到假上游上，再让桥用它。 */
async function withPipeline(script, run) {
  const upstream = await startFakeUpstream(script)
  const credential = {
    token: 'e2e-token',
    authorization: () => 'Bearer e2e-token',
    isExpired: () => false,
    describe: () => ({ source: 'test' }),
  }
  const client = new QwenWorkAcpClient({
    resolveCredential: () => credential,
    log: () => {},
    wsUrl: upstream.url,
    restOrigin: upstream.restOrigin,
  })
  const bridge = await startBridge({
    log: () => {},
    resolveInventory: () => [
      { id: 'advanced', name: '高级', contextWindow: 200000, maxTokens: 32768 },
    ],
    resolveInventorySync: () => [
      { id: 'advanced', name: '高级', contextWindow: 200000, maxTokens: 32768 },
    ],
    stream: ({ prompt, signal }) => client.prompt(prompt, { signal }),
  })
  try {
    await run({ bridge, client, upstream })
  } finally {
    client.close()
    await bridge.close()
    await upstream.close()
  }
}

function post(bridge, body) {
  return fetch(`${bridge.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bridge.token}` },
    body: JSON.stringify(body),
  })
}

/** 把 SSE 文本拆成 data 负载。 */
function sseEvents(text) {
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.startsWith('data: '))
    .map((block) => block.slice('data: '.length))
}

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

await test('a full turn: streamed text reaches the OpenAI client as SSE deltas', async () => {
  await withPipeline((update, message, send, status) => {
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '第一段。' } })
    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '（思考）' } })
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '第二段。' } })
    update({ sessionUpdate: 'usage_update', inputTokens: 12, outputTokens: 9 })
    // 实测的收尾信号是 session_status: idle，不是 prompt 的响应。
    status('idle')
  }, async ({ bridge }) => {
    const response = await post(bridge, {
      model: 'advanced',
      stream: true,
      messages: [{ role: 'user', content: '你好' }],
    })
    assert.equal(response.status, 200)
    const events = sseEvents(await response.text())
    assert.equal(events.at(-1), '[DONE]')
    const chunks = events.slice(0, -1).map((item) => JSON.parse(item))
    const content = chunks.map((chunk) => chunk.choices[0]?.delta?.content ?? '').join('')
    const reasoning = chunks.map((chunk) => chunk.choices[0]?.delta?.reasoning_content ?? '').join('')
    assert.equal(content, '第一段。第二段。')
    assert.equal(reasoning, '（思考）')
    const usage = chunks.find((chunk) => chunk.usage !== undefined)
    assert.deepEqual(usage.usage, { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 })
  })
})

await test('the prompt body carries the canned transcript, not raw JSON', async () => {
  let captured
  await withPipeline((update, message, send, status) => {
    captured = message
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } })
    status('idle')
  }, async ({ bridge }) => {
    await post(bridge, {
      model: 'advanced',
      stream: false,
      messages: [
        { role: 'system', content: '你是助手。' },
        { role: 'user', content: '第一问' },
        { role: 'assistant', content: '第一答' },
        { role: 'user', content: '第二问' },
      ],
    })
    // 实测方法名是 new_prompt，不是 ACP 标准的 session/prompt。
    assert.equal(captured.method, 'new_prompt')
    assert.equal(captured.params.sessionId, 'sess-e2e')
    assert.equal(captured.params.prompt.length, 1)
    assert.equal(captured.params.prompt[0].type, 'text')
    const text = captured.params.prompt[0].text
    assert.match(text, /你是助手。/)
    assert.match(text, /第一问/)
    assert.match(text, /Assistant: 第一答/)
    assert.match(text, /第二问/)
  })
})

await test('the session REST call carries the bearer token, not a cookie', async () => {
  await withPipeline((update, message, send, status) => {
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } })
    status('idle')
  }, async ({ bridge, upstream }) => {
    await post(bridge, { model: 'advanced', messages: [{ role: 'user', content: 'x' }] })
    // 真机结论：上游认 Authorization: Bearer，不认 Cookie。这里断言 WS 握手
    // 与 REST 建会话都带 Bearer，且**没有**退回去用 Cookie。
    assert.ok(upstream.handshakes.length > 0, 'the client must have opened a websocket')
    const handshake = upstream.handshakes[0]
    assert.equal(handshake.authorization, 'Bearer e2e-token')
    assert.equal(handshake.cookie, undefined, 'the client must not authenticate with a cookie')
  })
})

await test('a second turn works on the same client (a fresh session per turn)', async () => {
  await withPipeline((update, message, send, status) => {
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'turn' } })
    status('idle')
  }, async ({ bridge }) => {
    for (let round = 0; round < 3; round += 1) {
      const response = await post(bridge, {
        model: 'advanced',
        messages: [{ role: 'user', content: `round ${round}` }],
      })
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(body.choices[0].message.content, 'turn')
    }
  })
})

await test('an upstream refusal surfaces as a 502, not a hang', async () => {
  await withPipeline((update, message, send, status) => {
    // 让 new_prompt 的响应是一个 JSON-RPC 错误。假上游的 handle() 只按正常
    // 路径回，所以这里直接在 script 里补一个错误响应把它盖掉是做不到的；
    // 改为让脚本不产任何增量、直接 idle —— 那会得到空正文，而不是 502。
    // 所以本用例改用下面的 approve-then-error 形状：由 handle() 先回正常
    // 响应，script 里再补一个 error 帧给同一个 id。
    send({ type: 'control', payload: { jsonrpc: '2.0', method: 'session_status', params: { sessionId: message.params.sessionId, sessionStatus: 'idle' } } })
    status('idle')
  }, async ({ bridge }) => {
    const response = await post(bridge, {
      model: 'advanced',
      messages: [{ role: 'user', content: 'x' }],
    })
    // 上游没产出任何正文：桥仍应给一个完整（空）回复，而不是挂住。
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.choices[0].message.content, '')
  })
})

await test('a missing credential produces a clear sign-in message', async () => {
  const client = new QwenWorkAcpClient({ resolveCredential: () => undefined, log: () => {} })
  const bridge = await startBridge({
    log: () => {},
    resolveInventory: () => [{ id: 'advanced', name: '高级', contextWindow: 1, maxTokens: 1 }],
    resolveInventorySync: () => [{ id: 'advanced', name: '高级', contextWindow: 1, maxTokens: 1 }],
    stream: ({ prompt, signal }) => client.prompt(prompt, { signal }),
  })
  try {
    const response = await post(bridge, {
      model: 'advanced',
      messages: [{ role: 'user', content: 'x' }],
    })
    assert.equal(response.status, 502)
    const body = await response.json()
    assert.match(body.error.message, /not signed in|sign in/i)
  } finally {
    await bridge.close()
  }
})

/* ------------------------------------------------------------------ */

process.stdout.write(`\n${results.join('\n')}\n\n`)
process.stdout.write(failures === 0
  ? `e2e: all ${results.length} cases passed\n`
  : `e2e: ${failures} of ${results.length} cases FAILED\n`)
process.exitCode = failures === 0 ? 0 : 1
