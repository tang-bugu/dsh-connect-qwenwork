/**
 * 桥接层自测：`node src/bridge.test.mjs`
 *
 * 不依赖任何测试框架，也不依赖真实上游。测试的对象是**协议翻译**本身：
 * 给定一组 ACP 归一化事件，桥是否产出合法的 OpenAI `chat.completion` /
 * SSE 流。这是本插件里唯一"写错就会静默产出错内容"的部分（比起"连不上"
 * 那种一眼可见的失败），所以必须被钉死。
 */

import assert from 'node:assert/strict'
import { startBridge, FALLBACK_MODELS } from './bridge.js'

const results = []
let failures = 0

async function test(name, body) {
  try {
    await body()
    results.push(`PASS  ${name}`)
  } catch (error) {
    failures += 1
    results.push(`FAIL  ${name}\n        ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 起一个桥，把 `stream` 换成脚本化的事件序列。 */
async function withBridge(events, run) {
  const bridge = await startBridge({
    log: () => {},
    resolveInventory: () => FALLBACK_MODELS,
    resolveInventorySync: () => FALLBACK_MODELS,
    stream: async function* () {
      for (const event of events) yield event
    },
  })
  try {
    await run(bridge)
  } finally {
    await bridge.close()
  }
}

function post(bridge, body, token = bridge.token) {
  return fetch(`${bridge.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
}

/* ------------------------------------------------------------------ */

await test('GET /v1/models lists the fallback catalog', async () => {
  await withBridge([], async (bridge) => {
    const response = await fetch(`${bridge.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${bridge.token}` },
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.object, 'list')
    assert.equal(body.data.length, FALLBACK_MODELS.length)
    assert.equal(body.data[0].owned_by, 'qwenwork')
    assert.ok(body.data.every((model) => typeof model.id === 'string' && model.id.length > 0))
  })
})

await test('a missing bearer token is rejected with 401', async () => {
  await withBridge([], async (bridge) => {
    const response = await fetch(`${bridge.baseUrl}/models`)
    assert.equal(response.status, 401)
  })
})

await test('a wrong bearer token is rejected with 401', async () => {
  await withBridge([], async (bridge) => {
    const response = await fetch(`${bridge.baseUrl}/models`, {
      headers: { Authorization: 'Bearer definitely-not-the-token' },
    })
    assert.equal(response.status, 401)
  })
})

await test('/healthz needs no token and reveals nothing', async () => {
  await withBridge([], async (bridge) => {
    const response = await fetch(`http://127.0.0.1:${bridge.port}/healthz`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
  })
})

await test('an unknown path is 404 without echoing the path', async () => {
  await withBridge([], async (bridge) => {
    const response = await fetch(`${bridge.baseUrl}/secret-path-xyz`, {
      headers: { Authorization: `Bearer ${bridge.token}` },
    })
    assert.equal(response.status, 404)
    const body = await response.json()
    assert.ok(!JSON.stringify(body).includes('secret-path-xyz'))
  })
})

await test('non-streaming completion folds text and reasoning together', async () => {
  await withBridge([
    { type: 'reasoning', text: '先想一下。' },
    { type: 'text', text: '你好' },
    { type: 'text', text: '，世界。' },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } },
    { type: 'done', stopReason: 'end_turn' },
  ], async (bridge) => {
    const response = await post(bridge, {
      model: 'advanced',
      messages: [{ role: 'user', content: '你好' }],
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.object, 'chat.completion')
    assert.equal(body.choices[0].message.content, '你好，世界。')
    assert.equal(body.choices[0].message.reasoning_content, '先想一下。')
    assert.equal(body.choices[0].finish_reason, 'stop')
    assert.deepEqual(body.usage, { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 })
  })
})

await test('usage is omitted, not fabricated, when the upstream never sent it', async () => {
  await withBridge([
    { type: 'text', text: 'hi' },
    { type: 'done', stopReason: 'end_turn' },
  ], async (bridge) => {
    const body = await (await post(bridge, {
      model: 'advanced',
      messages: [{ role: 'user', content: 'hi' }],
    })).json()
    assert.equal('usage' in body, false)
  })
})

await test('max_tokens maps to finish_reason "length"', async () => {
  await withBridge([
    { type: 'text', text: 'truncated' },
    { type: 'done', stopReason: 'max_tokens' },
  ], async (bridge) => {
    const body = await (await post(bridge, {
      model: 'advanced',
      messages: [{ role: 'user', content: 'x' }],
    })).json()
    assert.equal(body.choices[0].finish_reason, 'length')
  })
})

await test('streaming SSE starts with a role delta and ends with [DONE]', async () => {
  await withBridge([
    { type: 'text', text: 'A' },
    { type: 'text', text: 'B' },
    { type: 'done', stopReason: 'end_turn' },
  ], async (bridge) => {
    const response = await post(bridge, {
      model: 'advanced',
      stream: true,
      messages: [{ role: 'user', content: 'go' }],
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /text\/event-stream/)
    const text = await response.text()
    const events = text
      .split('\n\n')
      .map((block) => block.trim())
      .filter((block) => block.startsWith('data: '))
      .map((block) => block.slice('data: '.length))

    assert.equal(events.at(-1), '[DONE]')

    const chunks = events.slice(0, -1).map((item) => JSON.parse(item))
    // 第一个 chunk 必须确立 role，否则组装器会新建一条消息而不是续写。
    assert.equal(chunks[0].choices[0].delta.role, 'assistant')
    const content = chunks.map((chunk) => chunk.choices[0]?.delta?.content ?? '').join('')
    assert.equal(content, 'AB')
    const last = chunks.at(-1)
    assert.equal(last.choices[0].finish_reason, 'stop')
  })
})

await test('streaming carries reasoning_content as its own delta', async () => {
  await withBridge([
    { type: 'reasoning', text: 'think' },
    { type: 'text', text: 'answer' },
    { type: 'done', stopReason: 'end_turn' },
  ], async (bridge) => {
    const text = await (await post(bridge, {
      model: 'advanced',
      stream: true,
      messages: [{ role: 'user', content: 'q' }],
    })).text()
    const chunks = text.split('\n\n')
      .map((block) => block.trim())
      .filter((block) => block.startsWith('data: ') && !block.includes('[DONE]'))
      .map((block) => JSON.parse(block.slice(6)))
    const reasoning = chunks.map((chunk) => chunk.choices[0]?.delta?.reasoning_content ?? '').join('')
    assert.equal(reasoning, 'think')
  })
})

await test('an upstream failure before any byte yields 502 with the message', async () => {
  const bridge = await startBridge({
    log: () => {},
    resolveInventory: () => FALLBACK_MODELS,
    resolveInventorySync: () => FALLBACK_MODELS,
    stream: async function* () {
      throw new Error('upstream exploded')
    },
  })
  try {
    const response = await post(bridge, { model: 'advanced', messages: [{ role: 'user', content: 'x' }] })
    assert.equal(response.status, 502)
    const body = await response.json()
    assert.match(body.error.message, /upstream exploded/)
  } finally {
    await bridge.close()
  }
})

await test('an upstream failure mid-stream is surfaced then [DONE]', async () => {
  const bridge = await startBridge({
    log: () => {},
    resolveInventory: () => FALLBACK_MODELS,
    resolveInventorySync: () => FALLBACK_MODELS,
    stream: async function* () {
      yield { type: 'text', text: 'partial' }
      throw new Error('died halfway')
    },
  })
  try {
    const text = await (await post(bridge, {
      model: 'advanced',
      stream: true,
      messages: [{ role: 'user', content: 'x' }],
    })).text()
    assert.match(text, /died halfway/)
    assert.match(text, /\[DONE\]/)
  } finally {
    await bridge.close()
  }
})

await test('a body with no usable text is rejected with 400', async () => {
  await withBridge([], async (bridge) => {
    const response = await post(bridge, { model: 'advanced', messages: [] })
    assert.equal(response.status, 400)
  })
})

await test('invalid JSON is rejected with 400 rather than crashing', async () => {
  await withBridge([], async (bridge) => {
    const response = await fetch(`${bridge.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bridge.token}` },
      body: '{ not json',
    })
    assert.equal(response.status, 400)
  })
})

await test('the bridge binds to loopback only', async () => {
  await withBridge([], async (bridge) => {
    assert.equal(bridge.baseUrl.startsWith('http://127.0.0.1:'), true)
  })
})

/* ------------------------------------------------------------------ */

process.stdout.write(`${results.join('\n')}\n\n`)
process.stdout.write(failures === 0
  ? `bridge: all ${results.length} cases passed\n`
  : `bridge: ${failures} of ${results.length} cases FAILED\n`)
process.exitCode = failures === 0 ? 0 : 1
