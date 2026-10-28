/**
 * 千问办公（QwenWork）本机 **Cookie** 读取；**已被 `desktop-auth.js` 取代**。
 *
 * ## 为什么保留
 *
 * 真机验证（2026-10-22，装了客户端并登录之后）推翻了这层的前提：
 * 客户端的 Cookie 库里只有一个统计 Cookie（`.mmstat.com / cna`），
 * 眛登录态根本不在 Cookie 里，而在 `auth-v2.dat`（见 `desktop-auth.js`）。
 *
 * 保留这个模块的理由是诊断对照：它仍能扫描浏览器的 Cookie 库，
 * 而“在浏览器里登了一次”与“没登录”是两个可以分开报告的状态。
 * 它不再被 `index.js` 的凭证解析路径使用。
 *
 * 为什么需要这一层。千问办公没有 OpenAI 兼容端点，也没有 API Key 概念：
 * 网页端和桌面端都用**浏览器 Cookie 会话**调用 `qwenwork.cn`（axios 配置是
 * `withCredentials: true`）。所以"接入千问办公的模型"这件事，本质上就是
 * "借用一个已经登录的会话"。
 *
 * 本模块只做一件事：把「本机哪一份登录态可用」查清楚，并把它读成
 * {@link CookieSession}。它不发起任何上游请求，也不写任何文件。
 *
 * 支持的来源，按优先级：
 *   1. 显式配置的 Cookie 串（插件设置里手填，`cookieHeader`）；
 *   2. 桌面客户端（Electron）的 Chromium Cookie 库；
 *   3. 本机浏览器的 Chromium Cookie 库（用户平时用网页版时）。
 *
 * Chromium 在 Windows/macOS 上会把 Cookie 的**值**用操作系统密钥加密
 * （Windows = DPAPI，macOS = Keychain）。Windows 上的 `v10` 前缀密文是
 * `DPAPI( 明文 )`，其中明文前 32 字节是域哈希（新版 Chromium）或直接是值
 * （旧版）。macOS 的 `v10` 用 Keychain 里的 `"<Service Name> Safe Storage"`
 * 密码做 PBKDF2-HMAC-SHA1(1003 次, salt "saltysalt", iv 空格) AES-128-CBC。
 *
 * 解不开时**不抛异常**，而是降级为一条 {@link AuthFailure}，让 UI 能说清
 * "你确实登录了，但那份 Cookie 我读不出来，请改用粘贴方式"。这与参考插件
 * `dsh-connect-workbuddy` 处理加密凭据的思路一致：把"登录了但读不到"和
 * "没登录"区分开，因为两者的修复动作完全不同。
 *
 * @module dsh-connect-qwenwork/auth
 */

import { execFileSync } from 'node:child_process'
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { openDatabase } from './sqlite.js'

/** 上游站点；Cookie 必须送到这个域才会被接受。 */
export const QWENWORK_ORIGINS = Object.freeze([
  'qwenwork.cn',
  'www.qwenwork.cn',
  'gateway.qwenwork.cn',
])

/** 本插件在 DSH 配置里认的环境变量：显式 Cookie 串，优先级最高。 */
export const QWENWORK_COOKIE_ENV = 'QWENWORK_COOKIE'

/** 与插件自有副本（插件把读到的 Cookie 缓存成一份，见 `store.js`）。 */
export const QWENWORK_AUTH_FILENAME = 'qwenwork-auth.json'

/**
 * 一条 Cookie。`hostKey` 保留 Cookie 库里的域键原样（可能是 `.qwenwork.cn`），
 * 因为上游按域匹配，改写域会改变语义。
 */
export function cookie(name, value, hostKey, extra = {}) {
  return Object.freeze({ name, value, hostKey, ...extra })
}

/**
 * 一份可用的登录态。
 *
 * `source` 只说"这份是从哪儿读到的"，不评价可靠性——可靠性由 `verified`
 * 单独表达，因为"读到了"和"上游接受了"是两件事，混在一起会让 UI 无法
 * 区分"该重新登录"还是"该换一种提供方式"。
 */
export class CookieSession {
  /** @param {{cookies: ReadonlyArray<ReturnType<typeof cookie>>, source: string, filePath?: string}} init */
  constructor({ cookies, source, filePath }) {
    this.cookies = Object.freeze([...cookies])
    this.source = source
    this.filePath = filePath
    /** 上游最近一次明确接受该会话的时间（epoch ms）；未验证为 undefined。 */
    this.verifiedAtMs = undefined
  }

  /** 组装 `Cookie:` 请求头。值里的 `;`/换行会被剔除，避免头注入。 */
  header() {
    return this.cookies
      .filter((item) => item.name.length > 0 && item.value.length > 0)
      .map((item) => `${item.name}=${sanitizeCookieValue(item.value)}`)
      .join('; ')
  }

  /** 是否含某个 Cookie 名（只报名字，不泄露值）。 */
  has(name) {
    return this.cookies.some((item) => item.name === name && item.value.length > 0)
  }

  /** 认证类 Cookie 的名字列表，供 UI/诊断展示（绝不返回值）。 */
  names() {
    return this.cookies.map((item) => item.name)
  }

  /** 脱敏摘要：只给来源、条数与名字，够定位问题，又不落盘任何秘密。 */
  describe() {
    return {
      source: this.source,
      filePath: this.filePath,
      cookieCount: this.cookies.length,
      cookieNames: this.names(),
      headerBytes: Buffer.byteLength(this.header(), 'utf8'),
      ...(this.verifiedAtMs === undefined ? {} : { verifiedAtMs: this.verifiedAtMs }),
    }
  }
}

/** Cookie 值里不允许出现分号、逗号或控制字符（会让 Cookie 头变形）。 */
function sanitizeCookieValue(value) {
  return String(value).replace(/[;,\u0000-\u001f\u007f]/g, '')
}

/**
 * 一次读取尝试的失败记录。
 *
 * `reason` 是**稳定分类**，UI 按它决定提示文案：
 *   - `missing`     这个路径上没有 Cookie 库（没装/没登录过）
 *   - `unreadable`  文件存在但打不开（权限、被占用）
 *   - `invalid`     不是可解析的数据库
 *   - `encrypted`   是 Chromium 库，但密文解不开（拿不到系统密钥）
 *   - `no-session`  库能读，但里面没有千问办公的会话 Cookie
 */
export function authFailure(path, reason, message) {
  return { path, reason, ...(message === undefined ? {} : { message }) }
}

/* ------------------------------------------------------------------ *
 * Chromium Cookie 库位置
 * ------------------------------------------------------------------ */

/**
 * 桌面客户端的 userData 目录。客户端 productName 是 `QwenWork`，Electron 的
 * `app.getPath('userData')` 在 Windows 上是 `%APPDATA%/<productName>`，在
 * macOS 上是 `~/Library/Application Support/<productName>`，Linux 是
 * `~/.config/<productName>`。
 *
 * 这里同时覆盖 `QwenWork` 与 `QwenWorkCN`：`entry-app.js` 里的
 * `getExpectedEntryUserDataDirName()` 对 stable 通道用的是 `QwenWorkCN`，
 * 而打包元数据里的 productName 是 `QwenWork`，两个都真实存在于不同版本，
 * 少写一个就会在另一批用户机器上"莫名其妙找不到登录态"。
 */
export function desktopUserDataDirs(platform = process.platform, home = homedir(), env = process.env) {
  const names = ['QwenWork', 'QwenWorkCN', 'QwenWorkDev', 'QwenWorkCanary']
  const roots = []
  if (platform === 'win32') {
    const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming')
    const localAppData = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    for (const name of names) {
      roots.push(join(appData, name))
      roots.push(join(localAppData, name))
    }
    return roots
  }
  if (platform === 'darwin') {
    for (const name of names) roots.push(join(home, 'Library', 'Application Support', name))
    return roots
  }
  const configHome = env.XDG_CONFIG_HOME ?? join(home, '.config')
  for (const name of names) roots.push(join(configHome, name))
  return roots
}

/**
 * 常见 Chromium 浏览器的 userData 根目录。
 *
 * 只列"真实存在才算数"的候选，读取前逐个 `existsSync` 过滤——因为大多数
 * 用户只装其中一两个，列全量不会造成误判，只会让扫描稍慢。
 */
export function browserUserDataDirs(platform = process.platform, home = homedir(), env = process.env) {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    const roaming = env.APPDATA ?? join(home, 'AppData', 'Roaming')
    return [
      join(local, 'Google', 'Chrome', 'User Data'),
      join(local, 'Microsoft', 'Edge', 'User Data'),
      join(local, 'Chromium', 'User Data'),
      join(local, 'BraveSoftware', 'Brave-Browser', 'User Data'),
      join(local, 'Vivaldi', 'User Data'),
      join(roaming, '360se6', 'User Data'),
      join(roaming, 'Tencent', 'QQBrowser', 'User Data'),
    ]
  }
  if (platform === 'darwin') {
    const support = join(home, 'Library', 'Application Support')
    return [
      join(support, 'Google', 'Chrome'),
      join(support, 'Microsoft Edge'),
      join(support, 'Chromium'),
      join(support, 'BraveSoftware', 'Brave-Browser'),
    ]
  }
  const config = env.XDG_CONFIG_HOME ?? join(home, '.config')
  return [join(config, 'google-chrome'), join(config, 'microsoft-edge'), join(config, 'chromium')]
}

/**
 * 一个 Chromium/Electron userData 目录下所有 profile 的 Cookies 文件路径。
 *
 * ## 为什么是"有界遍历"而不是列几个固定路径
 *
 * Chromium 家族的 Cookie 库位置随版本与产品变化：
 *   - `<userData>/Cookies`                      最老
 *   - `<userData>/<Profile>/Cookies`
 *   - `<userData>/<Profile>/Network/Cookies`    现代 Chromium
 *   - `<userData>/Network/Cookies`
 *   - `<userData>/Partitions/<name>/Network/Cookies`   **Electron 分区**
 *
 * 最后一条是实测出来的：千问办公客户端（Electron）把主分区放在
 * `%APPDATA%\QwenWorkCN\Partitions\main\Network\Cookies`。写了前四条却漏掉
 * 它，表现就是"客户端明明登录了，插件却说找不到登录态"——而且不报错。
 *
 * 所以这里改成有界遍历（深度 3），只找名为 `Cookies` 的文件，并跳过体积大
 * 且与 Cookie 无关的目录。目录名写死一份清单是扛不住上游改布局的。
 *
 * `maxDepth` 是相对 userData 的层数，默认 3 刚好覆盖上面全部形状。
 */
export function cookiesFilesUnder(userDataDir, options = {}) {
  const maxDepth = options.maxDepth ?? 3
  const found = []
  const seen = new Set()

  /**
   * 这些目录里不可能有 Cookie 库，而且可能极大（缓存、扩展、字典）。
   * 不跳过会让一次扫描变成遍历上万个文件。
   */
  const SKIP = new Set([
    'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache',
    'DawnWebGPUCache', 'ShaderCache', 'GrShaderCache', 'GraphiteDawnCache',
    'blob_storage', 'Local Storage', 'Session Storage', 'IndexedDB',
    'CacheStorage', 'Service Worker', 'Extensions', 'chrome-extension',
    'Crashpad', 'Dictionaries', 'logs', 'diagnostics', 'data',
    'workspace', 'profile-data', 'rum-electron-store',
  ])

  const push = (path) => {
    if (seen.has(path)) return
    seen.add(path)
    found.push(path)
  }

  /** 深度优先，但只在必要时下探。 */
  const walk = (dir, depth) => {
    if (depth > maxDepth) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    // 同一层里有 `Cookies` 文件就先收下——它与子目录里的库同属一个 profile，
    // 顺序上先收"更靠上"的，读到的更可能是当前登录态。
    for (const entry of entries) {
      if (entry.isFile() && entry.name === 'Cookies') push(join(dir, entry.name))
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (SKIP.has(entry.name)) continue
      walk(join(dir, entry.name), depth + 1)
    }
  }

  walk(userDataDir, 0)
  return found
}

/* ------------------------------------------------------------------ *
 * 解密
 * ------------------------------------------------------------------ */

/**
 * Windows：经 PowerShell 调 DPAPI Unprotect。
 *
 * 为什么用子进程而不是原生模块：DPAPI 的密钥绑定当前用户登录会话，只有
 * 系统 API 能取到；而不想为此引入 `win-dpapi` 这类原生依赖（要编译、
 * 要匹配 Electron ABI）。参考插件 `dsh-connect-workbuddy` 也是用
 * `execFileSync("powershell", …)` 做同类探测，这里沿用同一取舍。
 *
 * 密文以 base64 交给 PowerShell，避免把二进制塞进命令行导致引号/编码问题。
 * 结果以 base64 回传，避免 stdout 被当成文本时被本地代码页破坏。
 */
function dpapiUnprotect(ciphertext, platform) {
  if (platform !== 'win32') return undefined
  const payload = Buffer.from(ciphertext).toString('base64')
  const script = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Security',
    `$raw = [Convert]::FromBase64String("${payload}")`,
    '$plain = [System.Security.Cryptography.ProtectedData]::Unprotect(',
    '  $raw, $null,',
    '  [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Convert]::ToBase64String($plain)',
  ].join('\n')
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024 },
    )
    const trimmed = out.trim()
    if (trimmed.length === 0) return undefined
    return Buffer.from(trimmed, 'base64')
  } catch {
    return undefined
  }
}

/**
 * macOS：用 Keychain 里 Chromium 的 Safe Storage 密码做 AES-128-CBC。
 *
 * `security find-generic-password -w -s "<Service> Safe Storage"` 是 Chromium
 * 自己取密码的同一路径。取不到就返回 undefined（用户没授权/没登录）。
 */
function macKeychainPassword(serviceName, platform) {
  if (platform !== 'darwin') return undefined
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-w', '-s', `${serviceName} Safe Storage`],
      { encoding: 'utf8', timeout: 15000, maxBuffer: 64 * 1024 },
    )
    const password = out.trim()
    return password.length === 0 ? undefined : password
  } catch {
    return undefined
  }
}

const LINUX_PASSWORD = 'peanuts'

/**
 * 解开一个 Chromium `encrypted_value`。
 *
 * Chromium 的密文以一个 3 字节的版本标签开头：
 *   - `v10`：Windows 上是 DPAPI(域哈希 + 明文)，macOS/Linux 上是
 *            AES-128-CBC（salt "saltysalt"，iv 为空格，1003 轮 PBKDF2-SHA1）。
 *            新版 Windows Chromium 在明文前多塞 32 字节的域哈希，需要剥掉。
 *   - `v11`：同上但用 1 轮 PBKDF2（Linux 旧版）。
 *   - 无标签：直接就是明文稿。
 *
 * @returns {string|undefined} 解不开时 undefined，绝不抛异常。
 */
export function decryptCookieValue(encryptedValue, options = {}) {
  const platform = options.platform ?? process.platform
  const serviceName = options.serviceName ?? 'Chrome'
  const buf = Buffer.isBuffer(encryptedValue) ? encryptedValue : Buffer.from(encryptedValue ?? [])
  if (buf.length === 0) return undefined

  const tag = buf.length >= 3 ? buf.subarray(0, 3).toString('latin1') : ''
  if (tag !== 'v10' && tag !== 'v11') {
    // 未加密（或已由调用方解密）：直接当 UTF-8 文本。
    return buf.toString('utf8')
  }
  const body = buf.subarray(3)

  if (platform === 'win32') {
    const plain = dpapiUnprotect(body, platform)
    if (plain === undefined) return undefined
    // 新版把 32 字节域哈希放在前面，且是 SHA-256(host_key)。剥掉的判据是
    // "去掉 32 字节后剩下的仍是合法 UTF-8"，而不是长度阈值——值本身可能
    // 很短，长度阈值会误伤。
    const hasPrefix = plain.length > 32 && looksLikePrecededByDomainHash(plain)
    return (hasPrefix ? plain.subarray(32) : plain).toString('utf8')
  }

  const password = platform === 'darwin'
    ? macKeychainPassword(serviceName, platform)
    : LINUX_PASSWORD
  if (password === undefined) return undefined
  const iterations = tag === 'v11' ? 1 : 1003
  const key = pbkdf2Sync(password, 'saltysalt', iterations, 16, 'sha1')
  const iv = Buffer.alloc(16, ' ')
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, iv)
    const out = Buffer.concat([decipher.update(body), decipher.final()])
    return out.toString('utf8')
  } catch {
    return undefined
  }
}

/**
 * 判断 `plain` 是否"前面多挂了 32 字节域哈希"。
 *
 * 不追求密码学级别的判断，只要足够区分：明文是 Cookie 值，通常全部是可打印
 * ASCII；而 SHA-256 前缀几乎必然含有控制字符或非法 UTF-8。用"前 32 字节
 * 里出现不可打印字符"作为证据，比长度猜测稳得多。
 */
function looksLikePrecededByDomainHash(plain) {
  const head = plain.subarray(0, 32)
  for (const byte of head) {
    if (byte < 0x20 || byte === 0x7f) return true
  }
  return !isValidUtf8(plain.subarray(32))
}

function isValidUtf8(buf) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ *
 * 读取 Cookies
 * ------------------------------------------------------------------ */

/** 只要这些域上的 Cookie：千问办公本体、网关、以及阿里 SSO 跳转。 */
function hostMatches(hostKey) {
  const host = String(hostKey ?? '').replace(/^\./, '').toLowerCase()
  if (host.length === 0) return false
  return QWENWORK_ORIGINS.some((origin) => host === origin || host.endsWith(`.${origin}`))
}

/**
 * 从一个 Cookie 数据库里读出千问办公的会话 Cookie。
 *
 * 全部 Cookie 都要，而不是只挑 `w_` 之类的名字：千问办公的认证 Cookie
 * 名会随版本变，认名字等于把插件绑死在某一个前端版本上。真正决定
 * "这份够不够用"的判据交给上游——`store.js` 会拿它打一次 `/biz/user/v1/auth/me`。
 *
 * @returns {{session?: CookieSession, failures: object[]}}
 */
export function readCookiesFromFile(filePath, options = {}) {
  const platform = options.platform ?? process.platform
  const serviceName = options.serviceName ?? 'QwenWork'
  const failures = []

  let db
  try {
    db = openDatabase(filePath)
  } catch (error) {
    /**
     * 把"打不开"再分一层。
     *
     * 浏览器正在运行时，它的 Cookies 库在 Windows 上是**独占**打开的，
     * 读它必然拿到 EBUSY/EPERM/EACCES。这与"文件损坏"（`invalid`）的修复
     * 动作完全不同：前者是"关掉浏览器再试"，后者是"换一个 profile"。
     * 混成一种，用户会被指向错误的方向。
     */
    const code = error?.cause?.code ?? error?.code ?? ''
    const busy = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
    failures.push(authFailure(filePath, busy ? 'unreadable' : 'invalid', messageOf(error)))
    return { failures }
  }

  let rows
  try {
    rows = db.query('cookies')
  } catch (error) {
    failures.push(authFailure(filePath, 'invalid', messageOf(error)))
    return { failures }
  }

  const cookies = []
  let sawEncryptedUndecryptable = false
  for (const row of rows) {
    if (!hostMatches(row.host_key)) continue
    let value = typeof row.value === 'string' ? row.value : ''
    if (value.length === 0 && row.encrypted_value) {
      const decrypted = decryptCookieValue(row.encrypted_value, { platform, serviceName })
      if (decrypted === undefined) {
        sawEncryptedUndecryptable = true
        continue
      }
      value = decrypted
    }
    if (value.length === 0) continue
    cookies.push(cookie(String(row.name ?? ''), value, String(row.host_key ?? ''), {
      expiresUtc: typeof row.expires_utc === 'number' ? row.expires_utc : undefined,
    }))
  }

  if (cookies.length === 0) {
    failures.push(authFailure(
      filePath,
      sawEncryptedUndecryptable ? 'encrypted' : 'no-session',
      sawEncryptedUndecryptable
        ? 'cookies exist for qwenwork but could not be decrypted; the OS key could not be obtained'
        : 'no qwenwork cookies in this profile',
    ))
    return { failures }
  }
  return { session: new CookieSession({ cookies, source: 'cookie-db', filePath }), failures }
}

/** 解析手填的 `Cookie:` 串（`a=1; b=2`）。 */
export function parseCookieHeader(header, source = 'settings') {
  const cookies = []
  for (const part of String(header ?? '').split(';')) {
    const trimmed = part.trim()
    if (trimmed.length === 0) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    cookies.push(cookie(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim(), 'qwenwork.cn'))
  }
  return cookies.length === 0 ? undefined : new CookieSession({ cookies, source })
}

/**
 * 找到本机**所有**可读的千问办公登录态，按"最可能可用"排序。
 *
 * 排序规则是显式的，因为顺序决定"默认用哪个账号"：
 *   1. 显式配置的 Cookie（用户明确指定的，最高优先）；
 *   2. 桌面客户端的 Cookie（与"用客户端登录过"的预期一致）；
 *   3. 浏览器的 Cookie（次选，可能过期）。
 *
 * 同一来源内按 Cookie 数量降序——一个完整登录态通常带着多个域的多份
 * Cookie，而半截的（例如只剩一个埋点 Cookie）数量明显更少。
 */
export function discoverSessions(options = {}) {
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const env = options.env ?? process.env
  const explicit = options.explicitCookie ?? env[QWENWORK_COOKIE_ENV]
  const extraDesktopDirs = options.desktopDirs ?? []
  const extraBrowserDirs = options.browserDirs ?? []

  const sessions = []
  const failures = []

  if (typeof explicit === 'string' && explicit.trim().length > 0) {
    const parsed = parseCookieHeader(explicit, 'env')
    if (parsed !== undefined) sessions.push(parsed)
    else failures.push(authFailure('<env>' + QWENWORK_COOKIE_ENV, 'invalid', 'no cookie pairs parsed'))
  }

  const groups = [
    { source: 'desktop', dirs: [...extraDesktopDirs, ...desktopUserDataDirs(platform, home, env)], service: 'QwenWork' },
    { source: 'browser', dirs: [...extraBrowserDirs, ...browserUserDataDirs(platform, home, env)], service: 'Chrome' },
  ]

  for (const group of groups) {
    const collected = []
    for (const dir of group.dirs) {
      for (const file of cookiesFilesUnder(dir)) {
        const result = readCookiesFromFile(file, { platform, serviceName: group.service })
        if (result.session !== undefined) collected.push(result.session)
        failures.push(...result.failures)
      }
    }
    collected.sort((a, b) => b.cookies.length - a.cookies.length)
    for (const session of collected) sessions.push(new CookieSession({ ...session, source: group.source }))
  }

  return { sessions, failures }
}

/**
 * 便利封装：返回首选会话；没有就返回 undefined。
 *
 * 命名刻意是 `readSession` 而不是 `resolveSession`：它只读本地，**不刷新**、
 * 不验证。验证发生在真正要发请求的地方（`upstream.js`），因为验证要联网，
 * 让一个"读本地状态"的函数偷偷联网，会让设置卡片在离线时卡住。
 */
export function readSession(options = {}) {
  return discoverSessions(options).sessions[0]
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 诊断用：只报路径与失败原因，不含任何 Cookie 值。 */
export function diagnose(options = {}) {
  const { sessions, failures } = discoverSessions(options)
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const env = options.env ?? process.env
  return {
    platform,
    cookieEnv: env[QWENWORK_COOKIE_ENV] === undefined ? 'unset' : 'set',
    desktopDirs: desktopUserDataDirs(platform, home, env).map((dir) => ({ dir, exists: existsSync(dir) })),
    browserDirs: browserUserDataDirs(platform, home, env).map((dir) => ({ dir, exists: existsSync(dir) })),
    sessions: sessions.map((session) => session.describe()),
    failures,
  }
}

/** 供测试注入：把 `existsSync` 的结果固定下来，避免依赖真实机器布局。 */
export const internal = Object.freeze({
  dpapiUnprotect,
  macKeychainPassword,
  looksLikePrecededByDomainHash,
  hostMatches,
  cookiesFilesUnder,
  statSafe: (path) => {
    try {
      return statSync(path)
    } catch {
      return undefined
    }
  },
  readFileSafe: (path) => {
    try {
      return readFileSync(path)
    } catch {
      return undefined
    }
  },
})
