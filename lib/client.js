/**
 * dsh-connect-qwenwork 的浏览器侧设置卡片。
 *
 * ## 为什么是这种"文件形态"
 *
 * DSH 的浏览器插件不是普通 ESM：`dsh-client-ui-renderer` 通过
 * `package.json` 的 `dsh.client` 发现 `./client`，再把那个文件交给一个自带的
 * 模块加载器。产物必须是一个**自注册脚本**，形状固定：
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ...; return module.exports } })
 *
 * 好处是它**不需要打包**：`react` / `react-dom` 由宿主通过 `require` 提供，
 * 所以本文件是可直接读的源码，不是几 MB 的 bundle。参考插件
 * `dsh-connect-workbuddy` 用的是同一个协议。
 *
 * ## 它不做什么
 *
 * 卡片**不**读磁盘、**不**碰 Cookie、**不**自己发上游请求。它只做两件事：
 *   1. 调 Host 的只读路由 `/plugins/dsh-connect-qwenwork/status` 拿状态；
 *   2. 通过 `settingsScope.set()` 写回**一处**配置（手填的 Cookie）。
 *
 * 这条边界是刻意的：敏感材料只有一个出口（`auth.js`），浏览器侧永远拿不到
 * Cookie 值——它连"值"这个字段都收不到，只收到名字与条数。
 *
 * @module dsh-connect-qwenwork/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-connect-qwenwork',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { jsx, jsxs } = require('react/jsx-runtime')

    const h = jsx
    const hs = jsxs

    /** 与 Host 侧 `QWENWORK_STATUS_PATH` 必须一致。 */
    const STATUS_PATH = '/plugins/dsh-connect-qwenwork/status'

    /** 两个候选命名空间：Loader 条目 id 可能带或不带 `include:` 前缀。 */
    const NAMESPACE_CANDIDATES = ['dsh-connect-qwenwork', 'include:dsh-connect-qwenwork']

    /** 卡片注册进 `plugins.row.config` 的 key，逐个候选挂一次。 */
    const CARD_KEYS = ['dsh-connect-qwenwork', 'include:dsh-connect-qwenwork']

    /* ------------------------------------------------------------------ *
     * 样式
     * ------------------------------------------------------------------ */

    /**
     * 内联样式而不是 CSS 文件。
     *
     * 卡片是宿主页面里的一小块，注入 `<style>` 会影响全局；而 DSH 的插件
     * 没有稳定的样式隔离机制。内联把影响面限制在这棵子树上。
     */
    const S = {
      root: { display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 2px' },
      row: { display: 'flex', alignItems: 'flex-start', gap: 8 },
      label: { fontSize: 13, fontWeight: 600, minWidth: 96, paddingTop: 6 },
      grow: { flex: 1, minWidth: 0 },
      hint: { fontSize: 12, opacity: 0.65, lineHeight: 1.5, marginTop: 4 },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '7px 9px',
        fontSize: 13,
        fontFamily: 'inherit',
        borderRadius: 6,
        border: '1px solid rgba(128,128,128,0.35)',
        background: 'transparent',
        color: 'inherit',
      },
      button: {
        padding: '6px 12px',
        fontSize: 13,
        fontFamily: 'inherit',
        borderRadius: 6,
        border: '1px solid rgba(128,128,128,0.35)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      },
      buttonPrimary: {
        padding: '6px 12px',
        fontSize: 13,
        fontFamily: 'inherit',
        borderRadius: 6,
        border: '1px solid transparent',
        background: 'rgba(88,101,242,0.9)',
        color: '#fff',
        cursor: 'pointer',
      },
      badge: (tone) => ({
        display: 'inline-block',
        padding: '1px 7px',
        borderRadius: 999,
        fontSize: 11,
        lineHeight: '18px',
        fontWeight: 600,
        background: tone === 'ok' ? 'rgba(46,160,67,0.18)' : tone === 'warn' ? 'rgba(210,153,34,0.2)' : 'rgba(128,128,128,0.18)',
        color: tone === 'ok' ? '#2ea043' : tone === 'warn' ? '#bf8700' : 'inherit',
      }),
      section: {
        borderTop: '1px solid rgba(128,128,128,0.2)',
        paddingTop: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 11, opacity: 0.75, wordBreak: 'break-all' },
    }

    /* ------------------------------------------------------------------ *
     * 取状态
     * ------------------------------------------------------------------ */

    /**
     * 读 Host 的只读状态。
     *
     * 把 HTTP 与网络错误都折成一个 `{ ok: false, error }`，而不是抛出：
     * 卡片必须能在"桥没起来、Host 没响应"时仍然显示出来——那正是用户最
     * 需要提示的时候。抛出去会让卡片整块消失，用户无从判断发生了什么。
     */
    async function fetchStatus(signal) {
      try {
        const response = await fetch(STATUS_PATH, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          credentials: 'same-origin',
          cache: 'no-store',
          signal,
        })
        if (!response.ok) {
          return { ok: false, error: `HTTP ${response.status}` }
        }
        return { ok: true, document: await response.json() }
      } catch (error) {
        if (error?.name === 'AbortError') return { ok: false, aborted: true }
        return { ok: false, error: String(error?.message ?? error) }
      }
    }

    /* ------------------------------------------------------------------ *
     * 组件
     * ------------------------------------------------------------------ */

    /** 一行"标签 + 值"。 */
    function Field({ label, children }) {
      return hs('div', {
        style: S.row,
        children: [
          h('div', { key: 'l', style: S.label, children: label }),
          h('div', { key: 'v', style: S.grow, children }),
        ],
      })
    }

    /** 失败分类的一句话解释——每一条都指向**不同的**修复动作。 */
    const FAILURE_HINTS = {
      missing: '这台机器上没有这个路径（没装客户端，或从没登录过）。',
      unreadable: '文件存在但打不开：浏览器/客户端正占着它，先退出再试。',
      invalid: '不是可解析的数据库：这份 profile 已损坏，换一个。',
      encrypted: '凭证容器是加密的，且本进程拿不到系统密钥（比如不允许起 DPAPI 子进程）。改用手填 token。',
      'no-session': '库/目录能读，但里面没有千问办公的登录态。',
      'unsupported-platform': '这个平台的密钥取法还没实现，请手填 token。',
    }

    function QwenWorkCard({ settingsScope }) {
      const [status, setStatus] = React.useState(undefined)
      const [loading, setLoading] = React.useState(true)
      const [draft, setDraft] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      const [saveError, setSaveError] = React.useState(undefined)

      /** 当前配置里的手填 Cookie（只在该字段存在时非空）。 */
      const savedCookie = React.useMemo(() => {
        if (settingsScope === undefined) return ''
        try {
          const raw = settingsScope.getSnapshot()?.value?.token
          // `volatile()` 字段在浏览器侧可能是 `{get()}` 形状，也可能已被
          // 展开成字符串。两种都接受。
          if (typeof raw === 'string') return raw
          if (raw !== null && typeof raw === 'object' && typeof raw.get === 'function') {
            const value = raw.get()
            return typeof value === 'string' ? value : ''
          }
          return ''
        } catch {
          return ''
        }
      }, [settingsScope, status])

      const reload = React.useCallback(() => {
        const controller = new AbortController()
        setLoading(true)
        fetchStatus(controller.signal).then((result) => {
          if (result.aborted) return
          setStatus(result.ok ? result.document : { error: result.error })
          setLoading(false)
        })
        return () => controller.abort()
      }, [])

      React.useEffect(() => reload(), [reload])

      const saveCookie = async () => {
        if (settingsScope === undefined) {
          setSaveError('设置命名空间还没就绪，请稍后重试。')
          return
        }
        setSaving(true)
        setSaveError(undefined)
        try {
          const trimmed = draft.trim()
          // `unset` 而不是写空串：空串会让 Host 存一个"存在但为空"的覆盖层，
          // 掩盖 schema 默认值；`unset` 才是"恢复继承"。
          if (trimmed.length === 0) await settingsScope.unset('token')
          else await settingsScope.set('token', trimmed)
          setDraft('')
          reload()
        } catch (error) {
          setSaveError(String(error?.message ?? error))
        } finally {
          setSaving(false)
        }
      }

      if (loading && status === undefined) {
        return h('div', { style: S.root, children: '正在读取千问办公连接状态…' })
      }

      const document = status ?? {}
      const bridge = document.bridge ?? {}
      const credential = document.credential
      const failures = Array.isArray(document.failures) ? document.failures : []

      return hs('div', {
        style: S.root,
        children: [
          /* 状态行 */
          hs('div', { key: 'head', style: S.row, children: [
            h('div', { key: 'l', style: S.label, children: '连接' }),
            hs('div', { key: 'v', style: S.grow, children: [
              hs('div', { key: 'b', style: { display: 'flex', gap: 6, alignItems: 'center' }, children: [
                h('span', { key: 's', style: S.badge(credential === undefined ? 'warn' : 'ok'), children: credential === undefined ? '未登录' : '已找到登录态' }),
                h('span', { key: 'r', style: S.badge(bridge.running ? 'ok' : 'warn'), children: bridge.running ? '桥已就绪' : '桥未就绪' }),
              ] }),
              credential === undefined
                ? h('div', { key: 'h', style: S.hint, children: '请在千问办公客户端登录一次；插件直接复用它的登录态（auth-v2.dat），不需要再配 API Key。' })
                : hs('div', { key: 'h', style: S.hint, children: [
                    `${credential.displayName ? `账户：${credential.displayName} · ` : ''}${credential.plan ?? credential.tier ?? '未知套餐'}`,
                    credential.filePath === undefined ? null : h('div', { style: S.mono, children: credential.filePath }),
                  ] }),
              bridge.running
                ? h('div', { key: 'u', style: S.mono, children: bridge.baseUrl })
                : (bridge.error === undefined ? null : h('div', { key: 'u', style: S.hint, children: `桥启动失败：${bridge.error}` })),
            ] }),
          ] }),

          /* 手填 Cookie */
          hs('div', { key: 'token', style: S.section, children: [
            h('div', { key: 't', style: { fontSize: 13, fontWeight: 600 }, children: '手动提供 Bearer Token（可选）' }),
            h('div', { key: 'd', style: S.hint, children: savedCookie.length === 0
              ? '如果自动读取失败（例如 本机进程不允许解 DPAPI ），可以在浏览器里打开 qwenwork.cn，从开发者工具 → Network → 任意请求的 Authorization 头里复制 Bearer 后的 JWT，粘贴到这里。留空表示继续自动读取。'
              : '已保存一份手填 token。它会优先于自动读取被使用。' }),
            h('textarea', {
              key: 'i',
              style: { ...S.input, minHeight: 62, resize: 'vertical' },
              placeholder: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…',
              value: draft,
              spellCheck: false,
              onChange: (event) => setDraft(event.target.value),
            }),
            hs('div', { key: 'a', style: { display: 'flex', gap: 8 }, children: [
              h('button', {
                key: 'save',
                type: 'button',
                style: S.buttonPrimary,
                disabled: saving || settingsScope === undefined,
                onClick: saveCookie,
                children: saving ? '保存中…' : (draft.trim().length === 0 ? '清除手填 token' : '保存'),
              }),
              h('button', {
                key: 'reload',
                type: 'button',
                style: S.button,
                onClick: reload,
                children: '重新检测',
              }),
            ] }),
            saveError === undefined ? null : h('div', { key: 'e', style: { ...S.hint, color: '#cf222e' }, children: saveError }),
          ] }),

          /* 失败详情 */
          failures.length === 0 ? null : hs('div', { key: 'fail', style: S.section, children: [
            h('div', { key: 't', style: { fontSize: 13, fontWeight: 600 }, children: `读取尝试（${failures.length}）` }),
            ...failures.slice(0, 8).map((failure, index) => hs('div', { key: `f${index}`, style: S.hint, children: [
              h('span', { style: S.badge('warn'), children: failure.reason }),
              ` ${FAILURE_HINTS[failure.reason] ?? ''}`,
              h('div', { style: S.mono, children: failure.path }),
            ] })),
          ] }),

          /* 模型目录 */
          Array.isArray(document.catalog) && document.catalog.length > 0 ? hs('div', { key: 'cat', style: S.section, children: [
            h('div', { key: 't', style: { fontSize: 13, fontWeight: 600 }, children: '可用模型' }),
            h('div', { key: 'd', style: S.hint, children: document.catalog.map((model) => model.name).join(' · ') }),
            h('div', { key: 'n', style: S.hint, children: '档位来自千问办公官方文档；上游没有标准的模型列表接口，因此不臆造模型 id。' }),
          ] }) : null,

          document.error === undefined ? null : h('div', { key: 'err', style: { ...S.hint, color: '#cf222e' }, children: `状态读取失败：${document.error}` }),
        ],
      })
    }

    /* ------------------------------------------------------------------ *
     * 插件体
     * ------------------------------------------------------------------ */

    const name = 'dsh-connect-qwenwork-client'
    const inject = ['slots']

    function apply(ctx) {
      /** 当前绑定的设置作用域；未就绪时卡片是只读的。 */
      let settingsScope
      /** 当前这一轮注册的拆除函数。 */
      let disposers = []

      const t = (key) => {
        // 卡片文案直接写在组件里；这里保留一个函数形状，方便将来接
        // `ctx.locale` 而不改调用点。
        return key
      }

      /**
       * 绑定设置作用域并注册卡片。
       *
       * 为什么要在 `whileServed` 里做：Host 的服务命名空间由 Loader 条目 id
       * 决定（`dsh-connect-qwenwork` 或 `include:dsh-connect-qwenwork`），
       * 插件无法自己选。`whileServed` 等到 Host 真的开始服务其中之一后才
       * 回调，并且在不服务时再回调一次——这样命名空间变了也不用重启页面。
       */
      const bind = () => {
        const forms = ctx.configForms
        const registerCards = () => disposers = CARD_KEYS.map((key) => {
          try {
            return ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
              name: 'plugins.row.config',
              key,
              priority: 30,
              inject: () => ({ t, settingsScope }),
            }, QwenWorkCard))
          } catch (error) {
            console.error('[dsh-connect-qwenwork] could not register the settings card', error)
            return undefined
          }
        }).filter(Boolean)

        const disposeCards = () => {
          for (const dispose of disposers) {
            try {
              dispose()
            } catch {
              // 已经拆过了。
            }
          }
          disposers = []
        }

        if (forms === undefined || typeof forms.whileServed !== 'function') {
          if (forms !== undefined && typeof forms.get === 'function') {
            settingsScope = NAMESPACE_CANDIDATES.map((ns) => {
              try {
                return forms.get(ns)
              } catch {
                return undefined
              }
            }).find((scope) => scope !== undefined)
          }
          registerCards()
          return
        }

        ctx.effect(() => forms.whileServed(NAMESPACE_CANDIDATES, (served) => {
          const resolved = NAMESPACE_CANDIDATES.find((ns) => served.has(ns))
          settingsScope = resolved === undefined
            ? undefined
            : (() => {
                try {
                  return forms.get(resolved)
                } catch {
                  return undefined
                }
              })()
          // 先拆后建：keyed 槽位对同一个 key 重复注册会抛错，而这里的
          // 异常是被逐条捕获的——顺序反了会静默留下一个空 ledger。
          disposeCards()
          registerCards()
          return disposeCards
        }))
      }

      try {
        bind()
      } catch (error) {
        // 卡片失败绝不能影响 Host 侧：provider 与桥在另一个进程里。
        console.error('[dsh-connect-qwenwork] settings card failed to load (the model provider is unaffected):', error)
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = name
    exports.QwenWorkCard = QwenWorkCard
    return module.exports
  },
})
