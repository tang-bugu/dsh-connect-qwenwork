#!/usr/bin/env node
/**
 * dsh-connect-qwenwork 的独立诊断 CLI。
 *
 * ## 为什么要有它
 *
 * 这个插件最可能的失败方式是"在别人的机器上悄悄不工作"：客户端没装在标准
 * 位置、凭证容器解不开（例如进程无权起 DPAPI 子进程）、登录态过期。这些都
 * 不是崩溃，而是**空结果**——而空结果在 UI 里长得和"没配置"一模一样。
 *
 * 所以提供一个能在终端里跑、输出确定性 JSON 的命令，把"它到底看见了什么"
 * 讲清楚。这个结构沿用参考插件 `dsh-connect-workbuddy` 的 `bin` 设计
 * （`doctor` / `status` / `logout` + `--json` + 脱敏）。
 *
 * 用法：
 *   dsh-connect-qwenwork doctor [--json]   本机凭证与上游连通性诊断
 *   dsh-connect-qwenwork status [--json]   只读状态摘要
 *
 * 输出里**绝不**包含任何 token；只给路径、来源与身份片段。
 *
 * @module dsh-connect-qwenwork/bin
 */

import { diagnoseDesktop, discoverCredentials, QWENWORK_USERDATA_NAMES } from './desktop-auth.js'
import { QwenWorkAcpClient } from './acp.js'

/** `doctor --json` 的文档版本。加字段时递增，消费方据此判断字段是否存在。 */
const JSON_SCHEMA_VERSION = 2

const args = process.argv.slice(2)
const command = args.find((item) => !item.startsWith('-')) ?? 'status'
const asJson = args.includes('--json')

const commands = {
  doctor,
  status,
  help,
}

const run = commands[command] ?? help

try {
  await run()
} catch (error) {
  report(`failed: ${error instanceof Error ? error.message : String(error)}`, 1)
}

/* ------------------------------------------------------------------ */

/**
 * 完整诊断：本地能看见什么 + 上游到底认不认。
 *
 * 两段分开报告是刻意的。第一段不联网，永远能给出答案；第二段要联网，
 * 可能因为网络本身失败。混在一起会让"网络不通"看起来像"没登录"。
 */
async function doctor() {
  const local = diagnoseDesktop()
  const { credentials } = discoverCredentials()
  const credential = credentials[0]

  const output = {
    schemaVersion: JSON_SCHEMA_VERSION,
    command: 'doctor',
    generatedAt: new Date().toISOString(),
    platform: local.platform,
    userDataNames: QWENWORK_USERDATA_NAMES,
    userDataDirs: local.userDataDirs,
    credentials: local.credentials,
    failures: local.failures,
    upstream: undefined,
  }

  if (credential === undefined) {
    output.summary = 'no local QwenWork credential found'
    output.hint = 'sign in once through the QwenWork desktop app, '
      + 'or set QWENWORK_TOKEN / paste a Bearer token in this plugin\'s settings'
    emit(output)
    return
  }

  const client = new QwenWorkAcpClient({ resolveCredential: () => credential, log: () => {} })
  try {
    const verdict = await client.verifyCredential(credential)
    output.upstream = {
      ok: verdict.ok,
      status: verdict.status,
      reason: verdict.reason,
      ...(verdict.identity === undefined ? {} : { identity: redactIdentity(verdict.identity) }),
    }
    output.summary = verdict.ok ? 'the upstream accepts this token' : 'the upstream rejected this token'
    if (!verdict.ok) {
      output.hint = 'the stored token is no longer valid; sign in again through the QwenWork desktop app'
    }
  } catch (error) {
    output.upstream = { ok: false, error: messageOf(error) }
    output.summary = 'could not reach the upstream identity endpoint'
    output.hint = 'this is a network problem, not a sign-in problem'
  } finally {
    client.close()
  }

  emit(output)
}

/** 只读状态：不需要联网，永远能回答。 */
async function status() {
  const { credentials, failures } = discoverCredentials()
  const credential = credentials[0]
  emit({
    schemaVersion: JSON_SCHEMA_VERSION,
    command: 'status',
    generatedAt: new Date().toISOString(),
    credential: credential === undefined ? undefined : credential.describe(),
    failures,
    summary: credential === undefined ? 'not signed in' : `credential from ${credential.filePath ?? '(unknown source)'}`,
  })
}

function help() {
  process.stdout.write([
    'dsh-connect-qwenwork — diagnostics for the QwenWork model bridge',
    '',
    'Usage:',
    '  dsh-connect-qwenwork status [--json]   read-only local state',
    '  dsh-connect-qwenwork doctor [--json]   local state + upstream verification',
    '',
    'Nothing here writes to disk, and no output contains a token.',
    '',
  ].join('\n'))
}

/* ------------------------------------------------------------------ */

function emit(payload) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return
  }
  const lines = [`summary: ${payload.summary ?? '(none)'}`]
  if (payload.hint !== undefined) lines.push(`hint:    ${payload.hint}`)
  if (payload.credential !== undefined) {
    lines.push(`account: ${payload.credential.displayName ?? '(no name)'}`
      + (payload.credential.plan === undefined ? '' : ` · ${payload.credential.plan}`))
    lines.push(`file:    ${payload.credential.filePath ?? '(unknown source)'}`)
    lines.push(`expires: ${payload.credential.expiresAt ?? '(unknown)'}`
      + (payload.credential.expired ? '  [EXPIRED]' : ''))
  }
  if (Array.isArray(payload.credentials) && payload.credentials.length > 0) {
    lines.push(`credentials: ${payload.credentials.length}`)
    for (const item of payload.credentials) {
      lines.push(`  - ${item.displayName ?? '(no name)'} @ ${item.filePath ?? '(no file)'}`
        + (item.expired ? '  [EXPIRED]' : ''))
    }
  }
  if (Array.isArray(payload.failures) && payload.failures.length > 0) {
    lines.push(`failures: ${payload.failures.length}`)
    for (const failure of payload.failures) {
      lines.push(`  - [${failure.reason}] ${failure.path}${failure.message === undefined ? '' : ` — ${failure.message}`}`)
    }
  }
  if (payload.upstream !== undefined) {
    lines.push(`upstream: ${payload.upstream.ok === true ? 'ok' : 'failed'} (${payload.upstream.status ?? payload.upstream.error ?? '?'})`)
    if (payload.upstream.identity !== undefined) {
      lines.push(`identity: ${payload.upstream.identity.displayName ?? '?'}`
        + (payload.upstream.identity.email === undefined ? '' : ` · ${payload.upstream.identity.email}`))
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`)
}

/**
 * 身份信息脱敏。
 *
 * 邮箱只保留首字符与域，用户 id 只留前 6 位：诊断需要"是不是同一个账号"
 * 这个信息，而不需要账号本身。把完整身份写进一条可能被贴到 issue 里的
 * 输出，是不必要的泄露。
 */
function redactIdentity(identity) {
  const out = {}
  if (typeof identity.displayName === 'string' && identity.displayName.length > 0) {
    out.displayName = identity.displayName
  }
  if (typeof identity.userId === 'string' && identity.userId.length > 0) {
    out.userIdPrefix = identity.userId.slice(0, 6)
  }
  if (typeof identity.email === 'string' && identity.email.includes('@')) {
    const [local, domain] = identity.email.split('@')
    out.email = `${local.slice(0, 1)}***@${domain}`
  }
  return out
}

function report(message, code) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: JSON_SCHEMA_VERSION, error: message }, null, 2)}\n`)
  } else {
    process.stderr.write(`${message}\n`)
  }
  process.exitCode = code
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
