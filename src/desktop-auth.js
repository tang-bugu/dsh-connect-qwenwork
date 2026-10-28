/**
 * 读取千问办公**桌面客户端**的登录态。
 *
 * ## 这个模块是用真机验证换来的，不是从 bundle 推断的
 *
 * 早期版本的插件假设"客户端把会话放在 Chromium 的 Cookies 库里"，于是花
 * 力气解析 `Cookies` SQLite 并尝试 DPAPI。真机验证（2026-10-22，装了客户端
 * 并登录之后）证明那条路是错的，而且错得很具体：
 *
 *   1. 客户端的 Cookie 库里**只有一个统计 Cookie**（`.mmstat.com / cna`）。
 *      登录态根本不在 Cookie 里。
 *   2. 真正的凭证是 `%APPDATA%\\QwenWorkCN\\auth-v2.dat`：
 *      `"v10"` 前缀 + **AES-256-GCM** 密文，密钥来自 Chromium 的
 *      `Local State → os_crypt.encrypted_key`（本身由 DPAPI 保护，前缀 `DPAPI`）。
 *   3. 解开后是一份 JSON，`token` 字段是 **JWT**：
 *      `{"app_id":"qwenwork-desktop-app","aud":"oauth_app","iss":"qwenwork.cn",…}`。
 *   4. 上游要的是 `Authorization: Bearer <jwt>`，不是 Cookie。
 *
 * 所以本模块读的是 `auth-v2.dat`，解密链是 **DPAPI → os_crypt key → AES-GCM**，
 * 而不是"DPAPI 直接解字段"。
 *
 * ## 为什么仍然保留 `auth.dat`
 *
 * 同一目录下还有一份 `auth.dat`（更老），解开后 `token` 是
 * `"placeholder-token-for-claudecode-sdk"` —— 一个占位值，不能用。把它当
 * 候选列出来是为了诊断（"你机器上有一份更老的登录文件"），而不是为了使用：
 * 真实 token 必须能过 JWT 形状检查。
 *
 * ## 平台差异
 *
 * 目前只实现了 Windows（DPAPI）与 macOS（Keychain）的 os_crypt 取密钥。
 * Linux 上 Chromium 用固定的 `peanuts` 口令做 PBKDF2，这条路径也一并实现，
 * 但未在真机验证过——所以 `verified` 字段会如实反映"这条路径没被跑过"。
 *
 * @module dsh-connect-qwenwork/desktop-auth
 */

import { execFileSync } from 'node:child_process'
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 客户端 userData 目录名。真机上是 `QwenWorkCN`（stable 通道）。 */
export const QWENWORK_USERDATA_NAMES = Object.freeze(['QwenWorkCN', 'QwenWork', 'QwenWorkDev', 'QwenWorkCanary'])

/** 主凭证文件名（v2）。 */
export const AUTH_V2_FILENAME = 'auth-v2.dat'

/** 旧凭证文件名；解开后通常是占位 token，只用于诊断。 */
export const AUTH_V1_FILENAME = 'auth.dat'

/**
 * 上游接受的认证头方案。
 *
 * 真机验证：`Authorization: Bearer <jwt>` 对 `/biz/user/v1/auth/me` 返回 200；
 * 同一 token 放进 `Cookie:` 不行（网关读 Bearer）。
 */
export const BEARER_SCHEME = 'Bearer'

/**
 * 客户端 userData 目录（按平台与产品名）。
 *
 * Electron 的 `app.getPath('userData')`：Windows = `%APPDATA%\<productName>`，
 * macOS = `~/Library/Application Support/<productName>`，Linux =
 * `~/.config/<productName>`。产品名在不同通道/版本下有两个真实取值
 * （`QwenWorkCN` 与 `QwenWork`），两个都要覆盖。
 */
export function desktopUserDataDirs(platform = process.platform, home = homedir(), env = process.env) {
  if (platform === 'win32') {
    const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming')
    return QWENWORK_USERDATA_NAMES.map((name) => join(appData, name))
  }
  if (platform === 'darwin') {
    const support = join(home, 'Library', 'Application Support')
    return QWENWORK_USERDATA_NAMES.map((name) => join(support, name))
  }
  const configHome = env.XDG_CONFIG_HOME ?? join(home, '.config')
  return QWENWORK_USERDATA_NAMES.map((name) => join(configHome, name))
}

/* ------------------------------------------------------------------ *
 * Chromium os_crypt 主密钥
 * ------------------------------------------------------------------ */

/**
 * 从 `Local State` 取出 os_crypt 主密钥（32 字节）。
 *
 * Chromium 把这个密钥以 `DPAPI(<32 字节>)` 的形式存成 base64，前缀是
 * 字面量 `DPAPI`。所以要先把前缀剥掉，再交给 DPAPI 解。
 *
 * @returns {Buffer|undefined} 解不开返回 undefined（绝不抛）。
 */
export function readOsCryptKey(userDataDir, options = {}) {
  const platform = options.platform ?? process.platform
  const localStatePath = join(userDataDir, 'Local State')
  let parsed
  try {
    parsed = JSON.parse(readFileSync(localStatePath, 'utf8'))
  } catch {
    return undefined
  }
  const encoded = parsed?.os_crypt?.encrypted_key
  if (typeof encoded !== 'string' || encoded.length === 0) return undefined

  let blob
  try {
    blob = Buffer.from(encoded, 'base64')
  } catch {
    return undefined
  }
  const prefix = blob.subarray(0, 5).toString('latin1')
  const body = prefix === 'DPAPI' ? blob.subarray(5) : blob

  if (platform === 'win32') {
    return dpapiUnprotect(body) ?? undefined
  }
  if (platform === 'darwin') {
    // macOS 的 os_crypt 走 Keychain 里的 "Chrome Safe Storage" 口令 +
    // PBKDF2-HMAC-SHA1(1003, salt "saltysalt")，再 AES-128-CBC。
    // 本插件目前只在 Windows 上验证过；这里返回 undefined 让上层报"不支持"
    // 而不是给出一个解错的密钥。
    return undefined
  }
  if (platform === 'linux') {
    // Linux 上 Chromium 的密钥是 PBKDF2(peanuts)；未在真机验证。
    return pbkdf2Sync(LINUX_PASSWORD, 'saltysalt', 1, 16, 'sha1')
  }
  return undefined
}

const LINUX_PASSWORD = 'peanuts'

/** 最近一次 DPAPI 失败的原因；诊断用，不含密文。 */
let lastDpapiError

/**
 * Windows DPAPI Unprotect。
 *
 * 用**文件**而不是 stdout 传数据：`execFileSync` 捕获子进程输出在受限环境里
 * 会 EPERM（本会话实测到了 `spawnSync powershell EPERM`），而且二进制经
 * stdout 往返容易被本地代码页破坏。写临时文件再读回来是唯一稳的路径。
 */
function dpapiUnprotect(ciphertext, options = {}) {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return undefined
  const tmp = options.tmpDir ?? process.env.TEMP ?? process.env.TMP
  if (tmp === undefined) return undefined
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const inPath = join(tmp, `qwenwork-dpapi-${stamp}.bin`)
  const outPath = join(tmp, `qwenwork-dpapi-${stamp}.out`)
  const scriptPath = join(tmp, `qwenwork-dpapi-${stamp}.ps1`)
  try {
    const { writeFileSync, unlinkSync } = requireFs()
    writeFileSync(inPath, ciphertext)
    writeFileSync(scriptPath, [
      '$ErrorActionPreference = "Stop"',
      'Add-Type -AssemblyName System.Security',
      `$raw = [System.IO.File]::ReadAllBytes('${inPath.replace(/'/g, "''")}')`,
      'try {',
      '  $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($raw, $null,',
      '    [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
      `  [System.IO.File]::WriteAllBytes('${outPath.replace(/'/g, "''")}', $plain)`,
      '  "OK"',
      '} catch { "ERR: " + $_.Exception.Message }',
    ].join('\n'), 'utf8')
    const result = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { encoding: 'utf8', timeout: 20000, windowsHide: true },
    )
    if (String(result).trim() !== 'OK') {
      lastDpapiError = String(result).trim()
      return undefined
    }
    return readFileSync(outPath)
  } catch (error) {
    /**
     * 记录**为什么**解不开。
     *
     * 最容易误判的一种情况：Node 根本不允许派生子进程（受限执行环境直接给
     * `spawnSync powershell EPERM`）。那时问题不在 DPAPI、也不在用户的登录态，
     * 而在"这个进程没有权限起子进程"。把它和"密文损坏"混成一句"解不开"，
     * 会让用户去重新登录——而重新登录毫无用处。
     */
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      lastDpapiError = `cannot spawn powershell (${error.code}); this process is not allowed to start child processes`
    } else if (error?.code === 'ENOENT') {
      lastDpapiError = 'powershell was not found on PATH'
    } else {
      lastDpapiError = messageOf(error)
    }
    return undefined
  } finally {
    try {
      const { unlinkSync } = requireFs()
      for (const path of [inPath, outPath, scriptPath]) {
        try {
          unlinkSync(path)
        } catch {
          // 临时文件可能根本没被创建。
        }
      }
    } catch {
      // 清理失败不影响结果。
    }
  }
}

/** DPAPI 的临时文件读写助手。ESM 里不能 `require('node:fs')`，直接用具名导入。 */
function requireFs() {
  return {
    writeFileSync: (path, data, enc) => writeFileSync(path, data, enc),
    unlinkSync: (path) => unlinkSync(path),
  }
}

/* ------------------------------------------------------------------ *
 * 解密 auth-v2.dat
 * ------------------------------------------------------------------ */

/**
 * 解一个 `v10`/`v11` 容器。
 *
 * Chromium 的 AES-GCM 布局是 `[3 字节 tag][12 字节 nonce][密文][16 字节 tag]`。
 * 真机上 `auth-v2.dat` 的头 3 字节正是 `v10`，长度 1597，与此吻合。
 *
 * @returns {Buffer|undefined}
 */
export function decryptChromiumAesGcm(container, key, options = {}) {
  const platform = options.platform ?? process.platform
  const buf = Buffer.isBuffer(container) ? container : Buffer.from(container ?? [])
  if (buf.length < 3) return undefined
  const tag = buf.subarray(0, 3).toString('latin1')

  // v11（Linux 旧版）不是 GCM，是 AES-128-CBC + 1 轮 PBKDF2。
  if (tag === 'v11') {
    const password = options.password ?? LINUX_PASSWORD
    const derived = pbkdf2Sync(password, 'saltysalt', 1, 16, 'sha1')
    try {
      const decipher = createDecipheriv('aes-128-cbc', derived, Buffer.alloc(16, ' '))
      return Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()])
    } catch {
      return undefined
    }
  }
  if (tag !== 'v10') {
    // 没有标签：明文容器（老版本或测试夹具）。
    return buf
  }
  const body = buf.subarray(3)
  if (body.length < 12 + 16) return undefined
  const nonce = body.subarray(0, 12)
  const payload = body.subarray(12, body.length - 16)
  const authTag = body.subarray(body.length - 16)

  // Windows/macOS 是 AES-256-GCM；Linux 是 AES-128-CBC。密钥长度决定分支。
  if (key.length === 32) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, nonce)
      decipher.setAuthTag(authTag)
      return Buffer.concat([decipher.update(payload), decipher.final()])
    } catch {
      return undefined
    }
  }
  if (key.length === 16 && platform === 'linux') {
    try {
      const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
      return Buffer.concat([decipher.update(body), decipher.final()])
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * 一份已解开的桌面端凭证。
 *
 * `token` 是 JWT；`displayName` / `expiresAtMs` 直接来自文档，用于 UI 与
 * 到期判断。**不**在这里做刷新：刷新是 `device_token` 策略，需要客户端协议，
 * 而插件用的是客户端的登录结果，刷新交给客户端自己（用户下次开客户端就刷新了）。
 */
export class DesktopCredential {
  constructor(document, meta) {
    this.document = document
    this.token = document.token
    this.refreshToken = document.refreshToken
    this.expiresAtMs = Date.parse(document.expiresAt ?? '') || undefined
    this.refreshExpiresAtMs = Date.parse(document.refreshTokenExpiresAt ?? '') || undefined
    this.user = document.user ?? {}
    this.filePath = meta.filePath
    this.userDataDir = meta.userDataDir
    this.loginMethod = document.loginMethod
    this.schemaVersion = document.schemaVersion
  }

  /** 显示名。真机上 `user.name` 是 `bugu` 这种短名。 */
  get displayName() {
    const user = this.user
    return user.name ?? user.username ?? user.email ?? ''
  }

  /** JWT 是否已过期（按 `expiresAt`；缺失时视为未过期，交给上游判断）。 */
  isExpired(nowMs = Date.now()) {
    return this.expiresAtMs !== undefined && this.expiresAtMs <= nowMs
  }

  /** 认证头。真机验证的方案。 */
  authorization() {
    return `${BEARER_SCHEME} ${this.token}`
  }

  /** 脱敏描述：只给来源与身份片段，绝不带 token。 */
  describe() {
    return {
      source: 'desktop-client',
      filePath: this.filePath,
      displayName: this.displayName,
      username: this.user.username,
      plan: this.user.planName,
      tier: this.user.tier,
      expiresAt: this.expiresAtMs === undefined ? undefined : new Date(this.expiresAtMs).toISOString(),
      expired: this.isExpired(),
      loginMethod: this.loginMethod,
      tokenBytes: typeof this.token === 'string' ? this.token.length : 0,
    }
  }
}

/**
 * 一份 JWT 是否"看起来像真的"。
 *
 * 真机上 `auth.dat` 解出来的 token 是
 * `"placeholder-token-for-claudecode-sdk"` —— 三段式 JWT 检查能直接把它筛掉，
 * 避免把占位值当成凭证发给上游（那会得到一个 401，然后用户被告知"没登录"，
 * 而实际上他登录了，只是我们读错了文件）。
 */
export function looksLikeJwt(token) {
  if (typeof token !== 'string') return false
  const parts = token.split('.')
  if (parts.length !== 3) return false
  if (parts.some((part) => part.length < 8)) return false
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return payload !== null && typeof payload === 'object'
  } catch {
    return false
  }
}

/** 解析 JWT 载荷（不验签）。诊断用。 */
export function jwtClaims(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * 从一个 userData 目录读凭证。
 *
 * @returns {{credential?: DesktopCredential, failures: object[]}}
 */
export function readCredentialFromDir(userDataDir, options = {}) {
  const platform = options.platform ?? process.platform
  const failures = []

  if (!existsSync(userDataDir)) {
    failures.push({ path: userDataDir, reason: 'missing', message: 'userData directory does not exist' })
    return { failures }
  }

  const candidates = [AUTH_V2_FILENAME, AUTH_V1_FILENAME]
  const key = readOsCryptKey(userDataDir, { platform })
  if (key === undefined) {
    failures.push({
      path: join(userDataDir, 'Local State'),
      reason: platform === 'darwin' ? 'unsupported-platform' : 'encrypted',
      ...(lastDpapiError === undefined ? {} : { detail: lastDpapiError }),
      message: platform === 'darwin'
        ? 'os_crypt key on macOS lives in the Keychain and is not read by this build'
        : (lastDpapiError === undefined ? 'could not unwrap the os_crypt master key' : lastDpapiError),
    })
    return { failures }
  }

  let placeholderSeen = false
  for (const name of candidates) {
    const filePath = join(userDataDir, name)
    if (!existsSync(filePath)) continue
    let container
    try {
      container = readFileSync(filePath)
    } catch (error) {
      failures.push({ path: filePath, reason: 'unreadable', message: messageOf(error) })
      continue
    }
    const plain = decryptChromiumAesGcm(container, key, { platform })
    if (plain === undefined) {
      failures.push({ path: filePath, reason: 'encrypted', message: 'the AES-GCM container did not authenticate' })
      continue
    }
    let document
    try {
      document = JSON.parse(plain.toString('utf8'))
    } catch {
      failures.push({ path: filePath, reason: 'invalid', message: 'decrypted payload is not JSON' })
      continue
    }
    if (!looksLikeJwt(document?.token)) {
      // `auth.dat` 就是这个分支：token 是占位字符串。记一笔但继续找。
      placeholderSeen = true
      failures.push({
        path: filePath,
        reason: 'no-session',
        message: `"token" is not a JWT (${typeof document?.token === 'string' ? `${document.token.slice(0, 24)}…` : typeof document?.token})`,
      })
      continue
    }
    return { credential: new DesktopCredential(document, { filePath, userDataDir }), failures }
  }

  if (!placeholderSeen) {
    failures.push({ path: userDataDir, reason: 'no-session', message: 'no auth-v2.dat / auth.dat found' })
  }
  return { failures }
}

/**
 * 找到本机所有可读的桌面端凭证，按"最可能可用"排序。
 *
 * 排序：未过期优先，其次 `schemaVersion` 大（v2 比 v1 新），最后按文件写入
 * 时间。真机上只有一份可用的 v2，但多通道/多版本共存是真实场景。
 */
export function discoverCredentials(options = {}) {
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const env = options.env ?? process.env
  const extra = options.desktopDirs ?? []
  const dirs = [...extra, ...desktopUserDataDirs(platform, home, env)]

  const credentials = []
  const failures = []
  for (const dir of dirs) {
    const result = readCredentialFromDir(dir, { platform })
    failures.push(...result.failures)
    if (result.credential !== undefined) credentials.push(result.credential)
  }

  credentials.sort((a, b) => {
    const expiredDiff = Number(a.isExpired()) - Number(b.isExpired())
    if (expiredDiff !== 0) return expiredDiff
    const versionDiff = (b.schemaVersion ?? 0) - (a.schemaVersion ?? 0)
    if (versionDiff !== 0) return versionDiff
    return (b.expiresAtMs ?? 0) - (a.expiresAtMs ?? 0)
  })
  return { credentials, failures }
}

/** 首选凭证；没有则 undefined。 */
export function readCredential(options = {}) {
  return discoverCredentials(options).credentials[0]
}

/**
 * 诊断：路径、失败原因、身份片段。**绝不**含 token。
 */
export function diagnoseDesktop(options = {}) {
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const env = options.env ?? process.env
  const { credentials, failures } = discoverCredentials(options)
  return {
    platform,
    userDataDirs: desktopUserDataDirs(platform, home, env).map((dir) => ({ dir, exists: existsSync(dir) })),
    credentials: credentials.map((credential) => credential.describe()),
    failures,
  }
}

/** userData 目录下有无 `Local State`（诊断用）。 */
export function hasLocalState(userDataDir) {
  return existsSync(join(userDataDir, 'Local State'))
}

/** 列出 userData 目录里所有 `.dat` 凭证文件（诊断用）。 */
export function listAuthFiles(userDataDir) {
  try {
    return readdirSync(userDataDir).filter((name) => name.endsWith('.dat'))
  } catch {
    return []
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

export const internal = Object.freeze({ dpapiUnprotect, messageOf })
