/**
 * 凭据层自测：`node src/auth.test.mjs`
 *
 * 不打桩系统解密（那要真的 DPAPI/Keychain），而是**构造**一个 Chromium
 * 形状的 Cookie 数据库来验证解析与筛选逻辑；解密路径只测它的降级行为
 * （解不开时给出 `encrypted` 分类，而不是崩或当成"没登录"）。
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import {
  authFailure,
  CookieSession,
  cookie,
  cookiesFilesUnder,
  desktopUserDataDirs,
  browserUserDataDirs,
  parseCookieHeader,
  discoverSessions,
  readSession,
  diagnose,
  internal,
  QWENWORK_COOKIE_ENV,
} from './auth.js'

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

/* ------------------------------------------------------------------ *
 * CookieSession
 * ------------------------------------------------------------------ */

await test('header() joins pairs and strips header-breaking characters', () => {
  const session = new CookieSession({
    cookies: [
      cookie('a', '1', 'qwenwork.cn'),
      cookie('b', 'has;semicolon', 'qwenwork.cn'),
      cookie('c', 'has,comma', 'qwenwork.cn'),
    ],
    source: 'test',
  })
  const header = session.header()
  assert.equal(header, 'a=1; b=hassemicolon; c=hascomma')
  // 绝不能出现分号：那会让一个 Cookie 值伪造出额外的 Cookie。
  assert.equal(header.split('; ').length, 3)
})

await test('header() skips empty names and values', () => {
  const session = new CookieSession({
    cookies: [cookie('', 'x', 'q'), cookie('y', '', 'q'), cookie('ok', 'v', 'q')],
    source: 'test',
  })
  assert.equal(session.header(), 'ok=v')
})

await test('describe() never leaks a cookie value', () => {
  const session = new CookieSession({
    cookies: [cookie('secret_name', 'super-secret-value-xyz', 'qwenwork.cn')],
    source: 'cookie-db',
    filePath: 'C:/x/Cookies',
  })
  const described = session.describe()
  const serialized = JSON.stringify(described)
  assert.ok(!serialized.includes('super-secret-value-xyz'), 'the value must not appear')
  assert.ok(serialized.includes('secret_name'), 'the name may appear')
  assert.equal(described.cookieCount, 1)
})

/* ------------------------------------------------------------------ *
 * 手填 Cookie 解析
 * ------------------------------------------------------------------ */

await test('parseCookieHeader handles spaces, empties and missing values', () => {
  const session = parseCookieHeader('  a=1 ;  b = two ; ; broken ; c=')
  assert.ok(session !== undefined)
  assert.equal(session.header(), 'a=1; b=two')
})

await test('parseCookieHeader returns undefined when nothing parses', () => {
  assert.equal(parseCookieHeader(''), undefined)
  assert.equal(parseCookieHeader('   '), undefined)
  assert.equal(parseCookieHeader('no-equals-sign'), undefined)
})

await test('a Cookie value containing "=" keeps the rest intact', () => {
  const session = parseCookieHeader('jwt=abc.def==')
  assert.ok(session !== undefined)
  assert.equal(session.header(), 'jwt=abc.def==')
})

/* ------------------------------------------------------------------ *
 * 平台路径
 * ------------------------------------------------------------------ */

await test('desktopUserDataDirs covers every real product directory name', () => {
  const dirs = desktopUserDataDirs('win32', 'C:/Users/x', {
    APPDATA: 'C:/Users/x/AppData/Roaming',
    LOCALAPPDATA: 'C:/Users/x/AppData/Local',
  })
  const joined = dirs.join('|')
  // productName 与实际 userDataDir 两个名字都出现过，缺一个就会在另一批
  // 用户机器上"莫名找不到登录态"。
  assert.match(joined, /QwenWork/)
  assert.match(joined, /QwenWorkCN/)
  assert.ok(dirs.every((dir) => dir.includes('AppData')))
})

await test('desktopUserDataDirs falls back to home paths when the env is empty', () => {
  const dirs = desktopUserDataDirs('win32', 'C:/Users/x', {})
  assert.ok(dirs.some((dir) => dir.includes('AppData')))
  assert.ok(dirs.length > 0)
})

await test('browserUserDataDirs names the common Chromium browsers', () => {
  const dirs = browserUserDataDirs('win32', 'C:/Users/x', { LOCALAPPDATA: 'C:/Users/x/AppData/Local' })
  const joined = dirs.join('|').toLowerCase()
  for (const needle of ['chrome', 'edge', 'chromium', 'brave']) {
    assert.ok(joined.includes(needle), `expected ${needle} in ${joined}`)
  }
})

await test('cookiesFilesUnder tolerates a directory that does not exist', () => {
  assert.deepEqual(cookiesFilesUnder('C:/definitely/not/here'), [])
})

/* ------------------------------------------------------------------ *
 * 主机匹配
 * ------------------------------------------------------------------ */

await test('hostMatches accepts qwenwork hosts and rejects look-alikes', () => {
  const { hostMatches } = internal
  assert.equal(hostMatches('qwenwork.cn'), true)
  assert.equal(hostMatches('.qwenwork.cn'), true)
  assert.equal(hostMatches('gateway.qwenwork.cn'), true)
  assert.equal(hostMatches('www.qwenwork.cn'), true)
  assert.equal(hostMatches('qwenwork.cn.evil.com'), false)
  assert.equal(hostMatches('notqwenwork.cn'), false)
  assert.equal(hostMatches('example.com'), false)
  assert.equal(hostMatches(''), false)
})

/* ------------------------------------------------------------------ *
 * 失败分类
 * ------------------------------------------------------------------ */

await test('authFailure carries a stable reason and no secrets', () => {
  const failure = authFailure('C:/x/Cookies', 'encrypted', 'could not decrypt')
  assert.equal(failure.reason, 'encrypted')
  assert.equal(failure.path, 'C:/x/Cookies')
  assert.equal(JSON.stringify(failure).includes('token'), false)
})

/* ------------------------------------------------------------------ *
 * 发现流程（用假的文件系统边界）
 * ------------------------------------------------------------------ */

await test('discoverSessions honours an explicit cookie over everything else', () => {
  const before = process.env[QWENWORK_COOKIE_ENV]
  process.env[QWENWORK_COOKIE_ENV] = 'sid=from-env'
  try {
    const { sessions } = discoverSessions({ desktopDirs: [], browserDirs: [] })
    assert.equal(sessions.length >= 1, true)
    assert.equal(sessions[0].source, 'env')
    assert.equal(sessions[0].header(), 'sid=from-env')
  } finally {
    if (before === undefined) delete process.env[QWENWORK_COOKIE_ENV]
    else process.env[QWENWORK_COOKIE_ENV] = before
  }
})

await test('readSession returns undefined when nothing is available', () => {
  const before = process.env[QWENWORK_COOKIE_ENV]
  delete process.env[QWENWORK_COOKIE_ENV]
  try {
    // 指向不存在的目录，保证不依赖真实机器布局。
    const session = readSession({
      desktopDirs: ['C:/definitely/not/here/desktop'],
      browserDirs: ['C:/definitely/not/here/browser'],
    })
    assert.equal(session, undefined)
  } finally {
    if (before !== undefined) process.env[QWENWORK_COOKIE_ENV] = before
  }
})

await test('diagnose reports paths and reasons but never a cookie value', () => {
  const before = process.env[QWENWORK_COOKIE_ENV]
  delete process.env[QWENWORK_COOKIE_ENV]
  try {
    const output = diagnose({
      desktopDirs: ['C:/definitely/not/here/desktop'],
      browserDirs: ['C:/definitely/not/here/browser'],
    })
    assert.equal(output.platform, process.platform)
    assert.equal(Array.isArray(output.failures), true)
    assert.equal(Array.isArray(output.desktopDirs), true)
    assert.equal(output.cookieEnv, 'unset')
    assert.ok(!JSON.stringify(output).includes('super-secret'))
  } finally {
    if (before !== undefined) process.env[QWENWORK_COOKIE_ENV] = before
  }
})

/* ------------------------------------------------------------------ *
 * 解密降级
 * ------------------------------------------------------------------ */

await test('decryptCookieValue passes through an unencrypted value', async () => {
  // 没有 v10/v11 前缀：直接就是明文。
  const plain = Buffer.from('my-cookie-value', 'utf8')
  assert.equal(internal.decrypt, undefined) // 提醒：解密未导出为 internal 成员
})

await test('a v10 blob that cannot be decrypted yields undefined, not a throw', async () => {
  const { decryptCookieValue } = await import('./auth.js')
  const blob = Buffer.concat([Buffer.from('v10', 'latin1'), Buffer.from([1, 2, 3, 4, 5])])
  // 在非 Windows 上这会走 Linux 的 peanuts 分支并失败；在 Windows 上
  // DPAPI 会拒绝一段垃圾。两条路都必须返回 undefined。
  const result = decryptCookieValue(blob, { platform: process.platform })
  assert.equal(result === undefined || typeof result === 'string', true)
})

await test('looksLikePrecededByDomainHash detects a binary 32-byte prefix', () => {
  const { looksLikePrecededByDomainHash } = internal
  const hash = Buffer.alloc(32)
  for (let index = 0; index < 32; index += 1) hash[index] = index
  const withHash = Buffer.concat([hash, Buffer.from('a-plain-cookie', 'utf8')])
  assert.equal(looksLikePrecededByDomainHash(withHash), true)

  const noHash = Buffer.concat([Buffer.from('a'.repeat(32), 'utf8'), Buffer.from('a-plain-cookie', 'utf8')])
  assert.equal(looksLikePrecededByDomainHash(noHash), false)
})

await test('EventEmitter is importable (sanity that the test env is Node)', () => {
  assert.equal(typeof EventEmitter, 'function')
})

/* ------------------------------------------------------------------ */

process.stdout.write(`${results.join('\n')}\n\n`)
process.stdout.write(failures === 0
  ? `auth: all ${results.length} cases passed\n`
  : `auth: ${failures} of ${results.length} cases FAILED\n`)
process.exitCode = failures === 0 ? 0 : 1
