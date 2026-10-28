/**
 * WebSocket 客户端自测：`node src/wsclient.test.mjs`
 *
 * 用真实的 TCP + 手写的 Upgrade 响应来测，而不是打桩：这个模块存在的理由
 * 就是"Node 自带的 WebSocket 不能带自定义握手头"，所以握手必须真的走一遍
 * HTTP，否则测不到真正会出问题的地方。
 *
 * ## 一个容易写错的地方（测试本身踩过）
 *
 * 服务端可以在 101 响应之后**立刻**发第一帧，所以事件必须在 `connect()`
 * **之前**订阅。所有用例因此都用 `collect(client, event)` 先挂好监听再连。
 * 这不是测试的怪癖，而是 `acp.js` 的真实用法：`wireSocket()` 也必须在
 * `connect()` 之前调用。
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

import { WsClient } from './wsclient.js'

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
 * 事件收集器
 * ------------------------------------------------------------------ */

/**
 * 在 `connect()` 之前订阅，把事件攒起来按需取用。
 *
 * `next()` 先看已到达的队列，再看未来——这样"连接建立前就到的帧"也不会丢。
 */
function collect(client, event, timeoutMs = 5000) {
  const queue = []
  const waiters = []
  let lastError

  client.on(event, (...args) => {
    const waiter = waiters.shift()
    if (waiter !== undefined) waiter.resolve(args)
    else queue.push(args)
  })
  client.on('error', (error) => {
    lastError = error
  })

  return {
    next() {
      if (queue.length > 0) return Promise.resolve(queue.shift())
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(
            `timed out waiting for "${event}"`
            + (lastError === undefined ? '' : ` (last error: ${lastError.message})`),
          ))
        }, timeoutMs)
        waiters.push({
          resolve: (args) => {
            clearTimeout(timer)
            resolve(args)
          },
        })
      })
    },
    get error() {
      return lastError
    },
  }
}

/* ------------------------------------------------------------------ *
 * 一个最小的 WebSocket 服务端（只够测试用）
 * ------------------------------------------------------------------ */

/** 组一个服务端→客户端的帧（不掩码）。 */
function serverFrame(opcode, payload, { fin = true, rsv1 = false } = {}) {
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
  header[0] = (fin ? 0x80 : 0x00) | (rsv1 ? 0x40 : 0x00) | opcode
  return Buffer.concat([header, data])
}

/** 解析客户端发来的帧（必须带掩码）。 */
function parseClientFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset]
    const second = buffer[offset + 1]
    const fin = (first & 0x80) !== 0
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
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
    if (!masked) {
      // RFC 6455 §5.3：客户端帧必须掩码。记下来让用例断言失败。
      frames.push({ fin, opcode, masked: false, payload: Buffer.alloc(0), error: 'unmasked client frame' })
      break
    }
    if (cursor + 4 + length > buffer.length) break
    const mask = buffer.subarray(cursor, cursor + 4)
    cursor += 4
    const payload = Buffer.alloc(length)
    for (let index = 0; index < length; index += 1) {
      payload[index] = buffer[cursor + index] ^ mask[index & 3]
    }
    frames.push({ fin, opcode, masked: true, payload })
    offset = cursor + length
  }
  return { frames, rest: buffer.subarray(offset) }
}

/**
 * 起一个测试服务端。
 *
 * `onConnection(connection, state)` 拿到可 send/close/inspect 的句柄，以及
 * 握手时收到的请求头。
 */
async function withServer(onConnection, run) {
  const server = createServer()
  const state = { headers: undefined, received: [], sockets: new Set() }

  server.on('upgrade', (request, socket) => {
    state.headers = request.headers
    // 记住每个升级后的 socket，收尾时统一销毁。`server.close()` 只停止
    // 接受新连接，不会断开已有连接——不主动清理的话，回调永远不会触发，
    // 测试会以"unsettled top-level await"的形式卡死。
    state.sockets.add(socket)
    socket.on('close', () => state.sockets.delete(socket))

    const key = request.headers['sec-websocket-key']
    const accept = createHash('sha1').update(key + GUID).digest('base64')
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '', '',
    ].join('\r\n'))

    let buffer = Buffer.alloc(0)
    const connection = {
      socket,
      send: (opcode, payload, options) => socket.write(serverFrame(opcode, payload, options)),
      sendText: (text) => socket.write(serverFrame(0x1, text)),
      close: (code = 1000, reason = '') => {
        const payload = Buffer.alloc(2 + Buffer.byteLength(reason))
        payload.writeUInt16BE(code, 0)
        payload.write(reason, 2)
        socket.write(serverFrame(0x8, payload))
      },
    }
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const parsed = parseClientFrames(buffer)
      buffer = parsed.rest
      for (const frame of parsed.frames) state.received.push(frame)
      if (parsed.frames.length > 0) connection.onFrames?.(parsed.frames)
    })
    socket.on('error', () => {})
    onConnection(connection, state)
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    await run(`ws://127.0.0.1:${port}/`, state)
  } finally {
    for (const socket of state.sockets) socket.destroy()
    state.sockets.clear()
    await new Promise((resolve) => server.close(resolve))
  }
}

/** 等客户端真的发出某个 opcode 的帧。 */
async function waitForFrame(state, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = state.received.find(predicate)
    if (hit !== undefined) return hit
    if (Date.now() > deadline) throw new Error('timed out waiting for a client frame')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

await test('handshake succeeds and carries custom Cookie / Origin headers', async () => {
  await withServer((connection) => {
    connection.sendText('hello')
  }, async (url, state) => {
    const client = new WsClient(url, {
      headers: { Cookie: 'sid=abc123', Origin: 'https://qwenwork.cn' },
    })
    // 先订阅再连：服务端可能在 101 之后立刻发第一帧。
    const opened = collect(client, 'open')
    const messages = collect(client, 'message')
    await client.connect()
    await opened.next()
    assert.equal(state.headers.cookie, 'sid=abc123')
    assert.equal(state.headers.origin, 'https://qwenwork.cn')
    const [text] = await messages.next()
    assert.equal(text, 'hello')
    client.terminate()
  })
})

await test('a small text message round-trips', async () => {
  await withServer((connection) => {
    connection.onFrames = (frames) => {
      for (const frame of frames) {
        if (frame.opcode === 0x1) connection.sendText(frame.payload.toString('utf8'))
      }
    }
  }, async (url) => {
    const client = new WsClient(url)
    const messages = collect(client, 'message')
    await client.connect()
    client.sendText('ping-pong')
    const [text] = await messages.next()
    assert.equal(text, 'ping-pong')
    client.terminate()
  })
})

await test('a large message (>70 KB) round-trips byte-identically', async () => {
  const big = Buffer.alloc(200000)
  for (let index = 0; index < big.length; index += 1) big[index] = 97 + (index % 26)
  const bigText = big.toString('utf8')
  await withServer((connection) => {
    connection.onFrames = (frames) => {
      for (const frame of frames) {
        if (frame.opcode === 0x1) connection.sendText(frame.payload.toString('utf8'))
      }
    }
  }, async (url) => {
    const client = new WsClient(url, { maxPayloadBytes: 2 * 1024 * 1024 })
    const messages = collect(client, 'message', 15000)
    await client.connect()
    client.sendText(bigText)
    const [text] = await messages.next()
    assert.equal(text.length, bigText.length)
    assert.equal(text, bigText)
    client.terminate()
  })
})

await test('a fragmented message with a ping in the middle is assembled', async () => {
  await withServer((connection) => {
    connection.send(0x1, 'part-one-', { fin: false })
    connection.send(0x9, 'middle-ping')       // 控制帧插在分片中间
    connection.send(0x0, 'part-two', { fin: true })
  }, async (url, state) => {
    const client = new WsClient(url)
    const messages = collect(client, 'message')
    await client.connect()
    const [text] = await messages.next()
    assert.equal(text, 'part-one-part-two')
    // 中间那个 ping 必须被回成 pong。
    const pong = await waitForFrame(state, (frame) => frame.opcode === 0xa)
    assert.equal(pong.payload.toString('utf8'), 'middle-ping')
    client.terminate()
  })
})

await test('a ping is answered with a matching pong', async () => {
  await withServer((connection) => {
    connection.onFrames = (frames) => {
      const pong = frames.find((frame) => frame.opcode === 0xa)
      if (pong !== undefined) connection.sendText(`pong:${pong.payload.toString('utf8')}`)
    }
    connection.send(0x9, 'abc')
  }, async (url) => {
    const client = new WsClient(url)
    const messages = collect(client, 'message')
    await client.connect()
    const [text] = await messages.next()
    assert.equal(text, 'pong:abc')
    client.terminate()
  })
})

await test('a server-initiated close reports its code and reason', async () => {
  await withServer((connection) => {
    connection.close(4321, 'bye now')
  }, async (url) => {
    const client = new WsClient(url)
    const closed = collect(client, 'close')
    await client.connect()
    const [code, reason] = await closed.next()
    assert.equal(code, 4321)
    assert.equal(reason, 'bye now')
  })
})

await test('an HTTP 401 handshake rejects with the status in the message', async () => {
  const server = createServer((request, response) => {
    response.writeHead(401, { 'Content-Type': 'text/plain' })
    response.end('Request denied by JWT Auth check')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const client = new WsClient(`ws://127.0.0.1:${port}/`)
    client.on('error', () => {})
    await assert.rejects(
      () => client.connect(),
      (error) => /401/.test(error.message),
    )
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

await test('invalid UTF-8 in a text frame emits an error instead of crashing', async () => {
  await withServer((connection) => {
    connection.send(0x1, Buffer.from([0xff, 0xfe]))
  }, async (url) => {
    const client = new WsClient(url)
    const errors = collect(client, 'error')
    await client.connect()
    const [error] = await errors.next()
    assert.match(error.message, /UTF-8/i)
  })
})

await test('a response with a wrong Sec-WebSocket-Accept is rejected', async () => {
  const server = createServer()
  const sockets = new Set()
  server.on('upgrade', (request, socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: totally-wrong-value',
      '', '',
    ].join('\r\n'))
    socket.on('error', () => {})
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const client = new WsClient(`ws://127.0.0.1:${port}/`)
    client.on('error', () => {})
    await assert.rejects(() => client.connect(), (error) => /Accept mismatch/i.test(error.message))
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
})

await test('client frames are always masked (RFC 6455 §5.3)', async () => {
  await withServer((connection) => {
    connection.onFrames = (frames) => {
      if (frames.some((frame) => frame.opcode === 0x1)) connection.sendText('ok')
    }
  }, async (url, state) => {
    const client = new WsClient(url)
    const messages = collect(client, 'message')
    await client.connect()
    client.sendText('salut')
    await messages.next()
    const dataFrame = state.received.find((frame) => frame.opcode === 0x1)
    assert.ok(dataFrame !== undefined, 'the server must have received the text frame')
    assert.equal(dataFrame.masked, true)
    assert.equal(dataFrame.error, undefined)
    assert.equal(dataFrame.payload.toString('utf8'), 'salut')
    client.terminate()
  })
})

await test('a frame larger than maxPayloadBytes closes with 1009', async () => {
  await withServer((connection) => {
    connection.sendText('x'.repeat(5000))
  }, async (url) => {
    const client = new WsClient(url, { maxPayloadBytes: 1024 })
    const errors = collect(client, 'error')
    await client.connect()
    const [error] = await errors.next()
    assert.match(error.message, /1009|exceeds/i)
    assert.equal(client.isOpen, false)
  })
})

await test('sendText on a closed socket emits an error, never throws', async () => {
  const client = new WsClient('ws://127.0.0.1:1/')
  const errors = collect(client, 'error')
  assert.doesNotThrow(() => client.sendText('nope'))
  const [error] = await errors.next()
  assert.match(error.message, /closed/i)
})

await test('the client rejects a non-101 upgrade without hanging', async () => {
  const server = createServer((request, response) => {
    response.writeHead(404)
    response.end('not here')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const client = new WsClient(`ws://127.0.0.1:${port}/`)
    client.on('error', () => {})
    await assert.rejects(() => client.connect(), (error) => /404/.test(error.message))
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

/* ------------------------------------------------------------------ */

process.stdout.write(`\n${results.join('\n')}\n\n`)
process.stdout.write(failures === 0
  ? `wsclient: all ${results.length} cases passed\n`
  : `wsclient: ${failures} of ${results.length} cases FAILED\n`)
process.exitCode = failures === 0 ? 0 : 1
