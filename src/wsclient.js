/**
 * 无依赖的 RFC 6455 WebSocket **客户端**。
 *
 * ## 为什么不用 Node 自带的 `WebSocket`
 *
 * Node 22 起有全局 `WebSocket`（undici 实现），但它的构造函数不接受自定义
 * 请求头。而千问办公的会话通道必须带三样东西：
 *   - `Cookie:`     登录态，**唯一**的鉴权凭据；
 *   - `Origin:`     上游按来源校验；
 *   - `User-Agent:` 上游按客户端识别。
 * undici 的 API 没有开这个口子，所以握手要自己发。
 *
 * ## 实现范围
 *
 * 只做客户端需要的那部分 RFC 6455：文本/二进制帧、分片重组、控制帧、
 * 关闭握手、心跳。不做服务端、不做扩展（除可选的 permessage-deflate）。
 *
 * 三个最容易写错的地方，都在下面标了注释：
 *   1. **分片与控制帧交错** —— 控制帧可能插在一个分片消息中间，必须立即处理
 *      且不能并入分片缓冲；
 *   2. **64 位长度** —— 必须当安全整数校验后才分配，否则一个伪造的头就能
 *      申请几个 GB；
 *   3. **掩码方向** —— 客户端发出的帧必须掩码，服务端发来的必须不掩码。
 *
 * @module dsh-connect-qwenwork/wsclient
 */

import { EventEmitter } from 'node:events'
import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import zlib from 'node:zlib'

/** 握手时服务端必须回的那个 GLOBALLY 固定 GUID。 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** 帧操作码。 */
const OPCODE = Object.freeze({
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
})

/** 控制帧（可插在分片中间）。 */
const isControl = (opcode) => (opcode & 0x8) !== 0

const DEFAULT_MAX_PAYLOAD = 16 * 1024 * 1024

/**
 * 一个 WebSocket 客户端连接。
 *
 * 事件：
 *   `open`                    握手完成
 *   `message` (text)          完整文本消息
 *   `binary`  (Buffer)        完整二进制消息
 *   `close`   (code, reason, wasClean)
 *   `error`   (Error)         任何异步失败；**从不**抛出到事件循环
 */
export class WsClient extends EventEmitter {
  constructor(url, options = {}) {
    super()
    this.url = new URL(url)
    this.options = options
    this.state = 'connecting'
    this.socket = undefined

    /** 分片重组缓冲。见上方注释 1。 */
    this.fragment = undefined
    this.fragmentOpcode = undefined
    this.fragmentCompressed = false

    /** 增量解析缓冲：TCP 分片不保证与帧边界对齐。 */
    this.buffer = Buffer.alloc(0)

    this.closeSent = false
    this.closeReceived = false

    this.pingTimer = undefined
    this.livenessTimer = undefined
    this.handshakeTimer = undefined

    this.maxPayload = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD
    this.perMessageDeflate = options.perMessageDeflate === true
    this.deflateNegotiated = false

    /** 关闭已上报，避免 `close` 事件重复发。 */
    this.closeEmitted = false
  }

  get readyState() {
    return this.state
  }

  get isOpen() {
    return this.state === 'open'
  }

  /**
   * 发起握手。
   *
   * 用 `node:http(s).request` 而不是 `net.connect` 手搓 HTTP：Upgrade 的
   * 请求行、头、以及"响应里可能带 body"的处理都由它负责，少一类边界情况。
   */
  connect() {
    return new Promise((resolve, reject) => {
      const key = randomBytes(16).toString('base64')
      this.expectedAccept = createHash('sha1').update(key + WS_GUID).digest('base64')

      const headers = {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
        ...(this.options.headers ?? {}),
      }
      if (this.perMessageDeflate) {
        headers['Sec-WebSocket-Extensions'] = 'permessage-deflate; client_max_window_bits'
      }

      const secure = this.url.protocol === 'wss:' || this.url.protocol === 'https:'
      const transport = secure ? https : http
      const requestOptions = {
        hostname: this.url.hostname,
        port: this.url.port === '' ? (secure ? 443 : 80) : Number(this.url.port),
        path: `${this.url.pathname}${this.url.search}`,
        method: 'GET',
        headers,
        ...(this.options.agent === undefined ? {} : { agent: this.options.agent }),
        ...(secure && this.options.tls !== undefined ? this.options.tls : {}),
      }

      let settled = false
      const finish = (error) => {
        if (settled) return
        settled = true
        this.clearTimer('handshakeTimer')
        if (error === undefined) resolve()
        else reject(error)
      }

      this.handshakeTimer = setTimeout(() => {
        request.destroy()
        finish(new Error(`WebSocket handshake timed out after ${this.options.handshakeTimeoutMs ?? 20000} ms`))
      }, this.options.handshakeTimeoutMs ?? 20000)
      this.handshakeTimer.unref?.()

      const request = transport.request(requestOptions)
      request.on('upgrade', (response, socket, head) => {
        const status = response.statusCode ?? 0
        if (status !== 101) {
          socket.destroy()
          finish(new Error(`WebSocket handshake rejected with HTTP ${status}`))
          return
        }
        const accept = response.headers['sec-websocket-accept']
        if (accept !== this.expectedAccept) {
          socket.destroy()
          finish(new Error('WebSocket handshake failed: Sec-WebSocket-Accept mismatch'))
          return
        }
        const extensions = String(response.headers['sec-websocket-extensions'] ?? '')
        this.deflateNegotiated = this.perMessageDeflate && /permessage-deflate/i.test(extensions)

        this.socket = socket
        this.state = 'open'
        socket.setNoDelay?.(true)
        socket.on('data', (chunk) => this.onData(chunk))
        socket.on('error', (error) => this.fail(error))
        socket.on('close', () => this.onSocketClose())

        this.startHeartbeat()
        // `open` 必须先于任何 `message` 发出。服务端可以把第一帧紧跟在 101
        // 响应之后（Node 会把它交给我们这里的 `head` 参数），此时若先处理
        // `head`，监听器会收到一条"连接尚未打开"的消息——顺序反了。
        this.emit('open')
        finish()
        if (head !== undefined && head.length > 0) this.onData(head)
      })

      request.on('response', (response) => {
        // 非 101：把状态码与一小段 body 带回去，便于诊断。
        const chunks = []
        let received = 0
        response.on('data', (chunk) => {
          if (received >= 300) return
          chunks.push(chunk)
          received += chunk.length
        })
        response.on('end', () => {
          const body = Buffer.concat(chunks).subarray(0, 300).toString('utf8').replace(/\s+/g, ' ').trim()
          finish(new Error(
            `WebSocket handshake rejected with HTTP ${response.statusCode}`
            + (body.length === 0 ? '' : `: ${body}`),
          ))
        })
        response.on('error', (error) => finish(error))
      })

      request.on('error', (error) => finish(error))
      request.end()
    })
  }

  /**
   * 发一条文本消息。
   *
   * 未连接时**不抛**：调用方通常在异步流里发帧，抛出去会变成一个没人接的
   * 异常；改为发一次 `error` 事件并忽略。真正的失败由 `close` 事件兜底。
   */
  sendText(text) {
    if (!this.isOpen) {
      this.emitError(new Error('cannot send on a closed WebSocket'))
      return
    }
    this.sendFrame(OPCODE.TEXT, Buffer.from(text, 'utf8'), true)
  }

  /** 发二进制。保留给未来的多模态扩展；当前桥不使用。 */
  sendBinary(data) {
    if (!this.isOpen) {
      this.emitError(new Error('cannot send on a closed WebSocket'))
      return
    }
    this.sendFrame(OPCODE.BINARY, Buffer.from(data), true)
  }

  /**
   * 组一个帧并写出去。
   *
   * 掩码是**客户端义务**（RFC 6455 §5.3）：客户端发出的每一帧都必须把
   * payload 与一个随机 4 字节掩码异或。服务端如果收到未掩码的帧，规范要求
   * 直接断开——这就是"本地测着好好的，一上线立刻 1002"的常见来源。
   */
  sendFrame(opcode, payload, fin) {
    const socket = this.socket
    if (socket === undefined) return

    let data = payload
    let rsv1 = false
    if (this.deflateNegotiated && opcode !== OPCODE.CLOSE && opcode !== OPCODE.PING && opcode !== OPCODE.PONG) {
      // RFC 7692：去掉尾部 4 个 0x00 0x00 0xFF 0xFF，并置 RSV1。
      data = zlib.deflateRawSync(payload)
      data = stripDeflateTail(data)
      rsv1 = true
    }

    const length = data.length
    const headerLength = length < 126 ? 2 : length < 65536 ? 4 : 10
    const header = Buffer.alloc(headerLength)
    header[0] = (fin ? 0x80 : 0x00) | (rsv1 ? 0x40 : 0x00) | (opcode & 0x0f)
    if (length < 126) {
      header[1] = 0x80 | length
    } else if (length < 65536) {
      header[1] = 0x80 | 126
      header.writeUInt16BE(length, 2)
    } else {
      header[1] = 0x80 | 127
      header.writeUInt32BE(Math.floor(length / 2 ** 32), 2)
      header.writeUInt32BE(length >>> 0, 6)
    }

    const mask = randomBytes(4)
    const masked = Buffer.allocUnsafe(length)
    for (let index = 0; index < length; index += 1) {
      masked[index] = data[index] ^ mask[index & 3]
    }
    socket.write(Buffer.concat([header, mask, masked]))
  }

  /**
   * 增量解析。**必须**保留 leftover，见上方注释 1。
   */
  onData(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])

    for (;;) {
      const frame = this.readFrame()
      if (frame === undefined) return
      if (frame === null) {
        // 协议错误：已经处理（发 close、断开），停止解析。
        return
      }
      this.handleFrame(frame)
    }
  }

  /**
   * 从缓冲里取一帧，缓冲不足时返回 undefined。
   *
   * 返回 `null` 表示协议错误（已触发断开），调用方应立即停止。
   */
  readFrame() {
    const buffer = this.buffer
    if (buffer.length < 2) return undefined

    const first = buffer[0]
    const second = buffer[1]
    const fin = (first & 0x80) !== 0
    const rsv1 = (first & 0x40) !== 0
    const rsv2 = (first & 0x20) !== 0
    const rsv3 = (first & 0x10) !== 0
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f

    if (rsv2 || rsv3) return this.protocolError('RSV2/RSV3 must be zero')
    if (rsv1 && !this.deflateNegotiated) return this.protocolError('RSV1 set without permessage-deflate')

    let offset = 2
    if (length === 126) {
      if (buffer.length < offset + 2) return undefined
      length = buffer.readUInt16BE(offset)
      offset += 2
    } else if (length === 127) {
      if (buffer.length < offset + 8) return undefined
      const high = buffer.readUInt32BE(offset)
      const low = buffer.readUInt32BE(offset + 4)
      // 见上方注释 2：先算成 Number 并校验，再拿去分配内存。
      const total = high * 2 ** 32 + low
      if (!Number.isSafeInteger(total)) return this.protocolError('frame length is not a safe integer')
      length = total
      offset += 8
    }

    if (length > this.maxPayload) {
      this.failClose(1009, `frame of ${length} bytes exceeds the ${this.maxPayload} byte limit`)
      return null
    }

    // 见上方注释 3：服务端发来的帧不允许掩码。
    if (masked) return this.protocolError('a server frame must not be masked')

    if (buffer.length < offset + length) return undefined

    const payload = buffer.subarray(offset, offset + length)
    this.buffer = buffer.subarray(offset + length)
    return { fin, rsv1, opcode, payload }
  }

  handleFrame(frame) {
    const { fin, rsv1, opcode, payload } = frame

    if (isControl(opcode)) {
      // 控制帧可以插在分片消息中间，且必须立即处理，不能并入分片缓冲。
      switch (opcode) {
        case OPCODE.PING:
          this.sendFrame(OPCODE.PONG, payload, true)
          this.noteLiveness()
          return
        case OPCODE.PONG:
          this.noteLiveness()
          return
        case OPCODE.CLOSE: {
          if (payload.length === 1) {
            this.protocolError('close frame with a 1-byte payload')
            return
          }
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
          const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : ''
          this.closeReceived = true
          if (!this.closeSent) this.sendFrame(OPCODE.CLOSE, payload.subarray(0, 2), true)
          this.finishClose(code, reason)
          return
        }
        default:
          this.protocolError(`unknown control opcode 0x${opcode.toString(16)}`)
          return
      }
    }

    if (opcode === OPCODE.CONTINUATION) {
      if (this.fragment === undefined) {
        this.protocolError('continuation frame without a preceding data frame')
        return
      }
      this.fragment.push(payload)
      if (fin) this.completeMessage(rsv1)
      return
    }

    if (opcode === OPCODE.TEXT || opcode === OPCODE.BINARY) {
      if (this.fragment !== undefined) {
        this.protocolError('a new data frame started before the fragmented message finished')
        return
      }
      if (fin) {
        this.fragment = [payload]
        this.fragmentOpcode = opcode
        this.completeMessage(rsv1)
        return
      }
      this.fragment = [payload]
      this.fragmentOpcode = opcode
      this.fragmentCompressed = rsv1
      return
    }

    this.protocolError(`unknown opcode 0x${opcode.toString(16)}`)
  }

  /** 收满一条消息：解压（若压缩）→ 解码 → 发事件。 */
  completeMessage(compressedHint) {
    const parts = this.fragment ?? []
    this.fragment = undefined
    const opcode = this.fragmentOpcode
    this.fragmentOpcode = undefined
    const compressed = compressedHint === true || this.fragmentCompressed
    this.fragmentCompressed = false

    let payload = parts.length === 1 ? parts[0] : Buffer.concat(parts)

    if (compressed && this.deflateNegotiated) {
      try {
        payload = zlib.inflateRawSync(Buffer.concat([payload, Buffer.from([0x00, 0x00, 0xff, 0xff])]), {
          finishFlush: zlib.constants.Z_SYNC_FLUSH,
        })
      } catch (error) {
        this.protocolError(`could not inflate a compressed message: ${messageOf(error)}`)
        return
      }
    }

    this.noteLiveness()

    if (opcode === OPCODE.BINARY) {
      this.emit('binary', payload)
      return
    }

    // RFC 6455 §8.1：文本消息必须是合法 UTF-8，否则以 1007 断开。
    let text
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(payload)
    } catch {
      this.failClose(1007, 'text message is not valid UTF-8')
      return
    }
    this.emit('message', text)
  }

  /** 心跳：定期 ping，并在长时间没有任何入站数据时判定死亡。 */
  startHeartbeat() {
    const interval = this.options.pingIntervalMs ?? 25000
    const timeout = this.options.pongTimeoutMs ?? 60000
    this.noteLiveness()
    if (interval > 0) {
      this.pingTimer = setInterval(() => {
        if (!this.isOpen) return
        this.sendFrame(OPCODE.PING, Buffer.alloc(0), true)
      }, interval)
      this.pingTimer.unref?.()
    }
    this.livenessTimer = setInterval(() => {
      if (!this.isOpen) return
      if (Date.now() - this.lastActivityMs > timeout) {
        this.emitError(new Error(`no data from the peer in ${timeout} ms`))
        this.terminate()
      }
    }, Math.max(1000, Math.floor(timeout / 4)))
    this.livenessTimer.unref?.()
  }

  noteLiveness() {
    this.lastActivityMs = Date.now()
  }

  /** 主动优雅关闭：发 Close，等对端回 Close；超时则硬断。 */
  close(code = 1000, reason = '') {
    if (this.state === 'closed' || this.state === 'closing') return
    this.state = 'closing'
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason, 'utf8'))
    payload.writeUInt16BE(code, 0)
    payload.write(reason, 2)
    try {
      this.sendFrame(OPCODE.CLOSE, payload, true)
      this.closeSent = true
    } catch {
      this.terminate()
      return
    }
    const timer = setTimeout(() => this.terminate(), 3000)
    timer.unref?.()
    this.once('close', () => clearTimeout(timer))
  }

  /** 立即断开，不发 Close。 */
  terminate() {
    this.state = 'closed'
    this.clearTimers()
    try {
      this.socket?.destroy()
    } catch {
      // 已断开。
    }
    this.onSocketClose()
  }

  /** 发错误 Close 帧后断开。 */
  failClose(code, reason) {
    try {
      if (this.isOpen) {
        const payload = Buffer.alloc(2 + Buffer.byteLength(reason, 'utf8'))
        payload.writeUInt16BE(code, 0)
        payload.write(reason, 2)
        this.sendFrame(OPCODE.CLOSE, payload, true)
        this.closeSent = true
      }
    } catch {
      // 忽略：下面无论如何都会断开。
    }
    this.emitError(new Error(`websocket protocol error (${code}): ${reason}`))
    this.terminate()
  }

  /** 协议错误统一入口：返回 `null` 以便解析器停下。 */
  protocolError(message) {
    this.failClose(1002, message)
    return null
  }

  /** 底层 socket 的 `error`。 */
  fail(error) {
    this.emitError(error instanceof Error ? error : new Error(String(error)))
    this.terminate()
  }

  /**
   * 安全地发 `error`。
   *
   * `error` 是 EventEmitter 的特殊事件：**没有监听器时 Node 会抛出**，把
   * 宿主进程直接干掉。这个客户端常驻后台，对端重置连接是常态，不该因此
   * 崩掉整个 DSH。所以没有订阅者时只记日志。
   */
  emitError(error) {
    if (this.listenerCount('error') > 0) this.emit('error', error)
    else this.options.onUnobservedError?.(error)
  }

  /** 底层 socket 已关：统一发 `close` 事件（只发一次）。 */
  onSocketClose() {
    this.state = 'closed'
    this.clearTimers()
    if (this.closeEmitted) return
    this.closeEmitted = true
    const clean = this.closeSent && this.closeReceived
    this.emit('close', clean ? 1000 : 1006, '', clean)
  }

  finishClose(code, reason) {
    this.state = 'closed'
    this.clearTimers()
    try {
      this.socket?.end()
    } catch {
      // 忽略。
    }
    if (this.closeEmitted) return
    this.closeEmitted = true
    this.emit('close', code, reason, true)
  }

  clearTimers() {
    this.clearTimer('pingTimer')
    this.clearTimer('livenessTimer')
    this.clearTimer('handshakeTimer')
  }

  clearTimer(name) {
    const timer = this[name]
    if (timer !== undefined) {
      clearInterval(timer)
      clearTimeout(timer)
      this[name] = undefined
    }
  }
}

/** 去掉 deflate 尾部的 4 字节 0x00 0x00 0xFF 0xFF（RFC 7692 §7.2.1）。 */
function stripDeflateTail(buffer) {
  if (buffer.length >= 4
    && buffer[buffer.length - 4] === 0x00
    && buffer[buffer.length - 3] === 0x00
    && buffer[buffer.length - 2] === 0xff
    && buffer[buffer.length - 1] === 0xff) {
    return buffer.subarray(0, buffer.length - 4)
  }
  return buffer
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

export const internal = Object.freeze({ stripDeflateTail, WS_GUID, OPCODE })
