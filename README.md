# dsh-connect-qwenwork

把 **千问办公（QwenWork）** 接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）。

插件读取本机已登录的千问办公桌面客户端凭证，在 `127.0.0.1` 上起一个 OpenAI 兼容的
回环桥，把 DSH 的模型请求翻译成千问办公真正使用的**会话协议**。

---

## 这份文档的协议结论是实测出来的

本文写于 **2026-10-22**，当时机器上装着千问办公桌面客户端并已登录，因此下面的
协议与凭证格式都在**真实上游**上跑通过（不是从 bundle 推断的）。三个关键结论
与早期的猜测相反：

| 早期猜测 | 实测结果 |
|---|---|
| 会话凭证在 Chromium 的 `Cookies` 库里 | **不在**。那个库里只有一个统计 Cookie（`.mmstat.com / cna`）。真凭证在 `auth-v2.dat` |
| 上游用 `Cookie:` 鉴权 | **用 `Authorization: Bearer <JWT>`**。同一 token 放 Cookie 里无效 |
| 会话协议是标准 ACP（`initialize`/`session/new`/`session/prompt`） | **是带信封的 JSON-RPC**，方法名叫 `join` / `new_prompt`。标准 ACP 的方法名一律被拒：`Unknown control method: initialize` |

---

## 一条真实的对话回合（实测时间线）

```
REST   POST /api/chat-sessions            Authorization: Bearer <jwt>   → 201 { id }
WS     wss://qwenwork.cn/api/chat-ws      Authorization: Bearer <jwt>   → 101
  →    {type:"control", payload:{method:"ping"}}                        → pong
  →    {type:"control", payload:{method:"join",  params:{sessionId}}}   → join_ack {accepted:true}
  →    {type:"control", payload:{method:"new_prompt", id:1,
                                 params:{sessionId, prompt:[{type:"text",text}]}}}
                                            ← result { promptId, turnId }   只是"接受了"
                                            ← new_prompt_ack {accepted:true}
                                            ← session_status: idle          **上一轮遗留，必须忽略**
                                            ← session_status: running       本轮真的开始
                                            ← session/update: agent_thought_chunk     思考增量
                                            ← session/update: agent_message_chunk     正文增量
                                            ← session_status: idle          **本轮结束**
```

一次「一句话 + 单独一行 DONE-OK」的回合实测约 15–17 秒（上游是 agent 型会话，
有固定的沙箱启动开销）。

**信封很重要**：裸 JSON-RPC 会被回
`{"code":-32700,"message":"unknown envelope type"}`，必须包一层
`{"type":"control"|"data", "payload":{...}}`。带 `seq` 的 `data` 帧承载
`session/update` 通知，`control` 帧承载方法与响应。

**结束判据**（最容易写错的地方）：`idle` 在本轮开始前也会来一条，单看"有没有
idle"会把回复截断成空。判据必须是「**见过 `running` 或正文增量之后**的 idle」。

---

## 三层结构

```
DSH / pi-ai                本插件                       千问办公
──────────────         ───────────────────         ──────────────
chat/completions  ──►   bridge.js   (回环 HTTP)
                          │  压成一条 prompt 文本
                          ▼
                        acp.js      (控制信封)   ──►  wss://qwenwork.cn/api/chat-ws
                          ▲                            join / new_prompt
                          │                            session/update …
                        SSE delta   ◄──  data 帧
desktop-auth.js   ◄──  读取本机 %APPDATA%\QwenWorkCN\auth-v2.dat
```

**接缝的选择**与参考插件 [`dsh-connect-workbuddy`](https://github.com/dingminhua/dsh-connect-workbuddy)
一致：回环 HTTP + pi-ai 适配器。理由也一致——DSH 的 adapter 契约是内部 API，
而回环地址 + OpenAI 兼容协议是稳定的外部契约。

---

## 凭证从哪来

按优先级：

1. **插件设置里的 `token`** —— 手填 Bearer 之后的那段 JWT，最高优先。
2. **环境变量 `QWENWORK_TOKEN`** —— 同上，适合脚本化环境。
3. **千问办公桌面客户端**的 `auth-v2.dat`（推荐，复用客户端的登录）。

### auth-v2.dat 的解密链

实测的文件在 `%APPDATA%\QwenWorkCN\auth-v2.dat`（Electron 的 `userData`）：

```
Local State → os_crypt.encrypted_key     base64("DPAPI" + DPAPI(<32 字节>))
                                        ──DPAPI──► 32 字节主密钥
auth-v2.dat  = "v10" + nonce(12) + AES-256-GCM 密文 + tag(16)
                                        ──AES-GCM──► 明文 JSON
明文 JSON    = { token, refreshToken, expiresAt, user: { name, planName, … } }
```

解出来的 `token` 是 JWT，`iss: qwenwork.cn`、`aud: oauth_app`、
`app_id: qwenwork-desktop-app`。同目录下还有一份更老的 `auth.dat`，它的 `token`
是 `"placeholder-token-for-claudecode-sdk"` 占位值——插件用"看起来像 JWT"这条
检查把它筛掉，避免把占位值发给上游（那会得到 401，然后用户被告知"没登录"）。

同目录还有两个取值名（`QwenWork` / `QwenWorkCN`），插件都扫。

### 一个必须知道的限制

DPAPI 解密需要起一个 `powershell` 子进程（`ProtectedData::Unprotect`）。
**在禁止派生子进程的执行环境里这一步会失败**（实测到 `spawnSync powershell EPERM`）。
那时插件会明确报 `cannot spawn powershell (EPERM); this process is not allowed to
start child processes`——不是"登录态坏了"，重新登录没有用。此时用方式 1 手填 token。

同理，客户端**正在运行**时它的 Cookie 库被独占打开，任何方式都读不到（实测
`File.Copy` / `cmd copy` / `esentutl` 全被系统拒绝）。不过 `auth-v2.dat` 不在
那条路径上，所以凭证读取不受影响。

失败分类（每条指向**不同**的修复动作）：

| `reason` | 含义 | 怎么办 |
|---|---|---|
| `missing` | 该路径不存在 | 装客户端，或先登录一次 |
| `unreadable` | 文件存在但打不开 | 退出占用它的程序 |
| `invalid` | 解开后不是 JSON / 不是库 | 文件已损坏 |
| `encrypted` | 容器解不开 | 见上文的 DPAPI 限制，或改手填 token |
| `no-session` | 能读，但 `token` 不是 JWT | 该文件是旧格式/未登录 |
| `unsupported-platform` | 该平台的密钥取法未实现 | 手填 token |

---

## 一个必须遵守的接入约束

本插件用**静态 import** 引宿主的 `@earendil-works/pi-ai` 等包。这不是风格选择：
那些包只在 DSH 的 `app.asar` 里，profile 的 `node_modules` 中不存在，只有宿主的
模块系统认得。改成动态 `await import()` 会 `ERR_MODULE_NOT_FOUND`，让 `apply()`
静默放弃注册——表现为「插件装了但模型列表里没有」，且没有报错。

细节与实测证据见 [`docs/HOST_IMPORTS.md`](docs/HOST_IMPORTS.md)。

---

## 安装

```bash
# 从 GitHub 安装（npm 发布前先走这条）
dsh plugin --profile <你的 profile> add github:tang-bugu/dsh-connect-qwenwork

# 或从本地目录安装
dsh plugin --profile <你的 profile> add "file:/path/to/dsh-connect-qwenwork"
```

`dsh plugin add` 会同时写 `dependencies` 与 `dsh.profile.bundles`——后者才是
Cordis 树真正读取的列表，手改 `node_modules` 不够。

本包自带的 `cordis.patch.yml` 会随 bundle 层一起生效，把插件挂进 Cordis 树，
**不需要**再手改 profile 的 `cordis.patch.yml`。装好重启 DSH 即可在模型选择器
里看到 `qwenwork`。

> ⚠️ 用 `file:` 安装时**不要**跑 `dsh plugin remove`：`file:` 是复制而非链接，
> remove 会把源目录清空。详见 [`docs/INSTALL.md`](docs/INSTALL.md)。

---

## 设置卡片

插件自带一张卡片，注册在设置页的 **Plugins → 本插件** 行里
（`plugins.row.config` 槽位）。它显示：

- 是否找到登录态、账号名与套餐、凭证文件在哪；
- 桥是否就绪、它的回环地址；
- 每一条读取尝试的**失败分类**，并给出对应的修复动作；
- 可用的模型档位。

卡片上可以**手填 Bearer token**，写入 `token` 字段。留空并保存等于 `unset`
（恢复自动读取），而不是写空串——后者会存一个"存在但为空"的覆盖层。

卡片本身**不接触任何 token**：它读 Host 的只读路由
`/plugins/dsh-connect-qwenwork/status`，那份 JSON 只给来源、身份片段与字节数。

> 为什么是手写卡片：`@deepseek-ai/dsh-settings` 文档的原话是「`autoGenerate`
> …供客户端按 schema 建页面；**目前还没有客户端这样做**」。只声明 schema 等于
> 用户没有界面可填，所以插件自带一个。schema 仍要声明——设置页的写入校验走
> 序列化后的 Config schema。

---

## 诊断

```bash
npx dsh-connect-qwenwork doctor        # 本机状态 + 上游验证
npx dsh-connect-qwenwork doctor --json # 机器可读
npx dsh-connect-qwenwork status        # 只读，不联网
```

`doctor` 分两段报告：本地能看见什么（不联网，永远有答案），以及上游认不认
（联网，可能因网络本身失败）。混在一起会让「网络不通」看起来像「没登录」。

输出**绝不**包含 token：只给路径、来源与身份片段。身份信息也脱敏（邮箱保留
首字母与域，用户 id 只留前 6 位）。

---

## 模型目录

千问办公的模型选择器提供四个**档位**（[官方文档](https://docs.qwenwork.cn/features/model-selection)）：
高级 / 基础 / 经济 / Qwen3.8-Max。文档明确说模型列表会持续更新、旧模型会被替换，
所以上游真正接受的 id 无法从文档静态推出。

因此：

- 目录里每个模型带 `source` 字段，标明来自 `documented-tier` 还是上游实测；
- 拿不到上游目录时**保留**这四个档位作为回落，而不是给空列表；
- 绝不编造看起来像真模型 id 的字符串——那会让用户选到一个永远失败的模型。

（建会话时上游回的 `extra_data.mode` 实测是 `"flash"`，模型档位由上游自己
按账号与套餐决定，`new_prompt` 不接受逐轮指定模型。）

---

## 安全边界

- 桥只 `listen('127.0.0.1')`，不接受外部连接；
- 每次进程启动生成随机 bearer token，pi-ai 侧用它作 `apiKey`，桥做**常量时间**
  校验（绑定回环不够：同机进程能猜端口，但猜不到 token）；
- `/healthz` 不需要 token，且不泄露任何信息；
- 未知路径回 404 **不回显路径**；
- 客户端断开时立即 abort 上游，避免继续消耗用户的额度；
- 插件**不**写上游的登录态，也不启动任何 OAuth 流程。

---

## 已知限制

- **每条 DSH 请求开一个新的上游会话。** 复用会话会把 DSH 已经组装好的上下文
  重复跑一遍（上游会话是有状态的 agent 会话），等于重复计费；代价是上游侧
  会留下较多短会话。
- **只发送文本。** 图片与文件标注为 `[image omitted: …]` 占位符而不是静默丢弃，
  但也不会上传。
- **`new_prompt` 不接受逐轮指定模型。** 模型档位由账号/套餐决定；插件目录里的
  四个档位只作为 DSH 模型选择器的可选项。
- **空回合由超时兜底。** 上游若只回一条 `idle` 而没有正文，本轮要等到 idle
  超时才收尾（这是"上一轮遗留的 idle"与"这一轮真的空回复"在消息层面无法
  区分所致）。

---

## 模块地图

| 文件 | 职责 |
|---|---|
| `src/index.js` | 插件入口：配置 schema、provider 注册、状态路由、生命周期 |
| `src/desktop-auth.js` | 读 `auth-v2.dat`（DPAPI → os_crypt → AES-GCM → JWT） |
| `src/auth.js` | 旧的 Cookie 发现/解密层，保留供诊断对照 |
| `src/acp.js` | 会话客户端：控制信封、`join`/`new_prompt`、事件归一化 |
| `src/bridge.js` | 回环 HTTP 桥（OpenAI 兼容 → 会话协议） |
| `src/wsclient.js` | 无依赖的 RFC 6455 WebSocket 客户端（需要自定义握手头） |
| `src/sqlite.js` | 无依赖的只读 SQLite 读取器（供 `auth.js` 用） |
| `src/bin.js` | `doctor` / `status` 诊断 CLI |
| `lib/client.js` | 浏览器侧设置卡片（`window.__ModuleLoader__` 自注册脚本，不需打包） |

---

## 开发

```bash
cd dsh-connect-qwenwork
npm test
```

九个套件、**141** 个用例，全部不联网、不依赖 npm 包：

| 套件 | 用例 | 覆盖 |
|---|---|---|
| `wsclient.test.mjs` | 13 | 握手、分片、控制帧、掩码、超大帧、UTF-8 校验 |
| `sqlite.test.mjs` | 32 | 头部、序列类型、rowid、溢出页、损坏输入 |
| `bridge.test.mjs` | 15 | token 鉴权、SSE 顺序、finish_reason、错误路径 |
| `acp.test.mjs` | 23 | 控制信封、事件归一化、流式时序、遗留 idle、断线 |
| `e2e.test.mjs` | 6 | 假会话上游 → 真客户端 → 真桥 → OpenAI 客户端 |
| `auth.test.mjs` | 19 | Cookie 组头、主机匹配、路径、失败分类 |
| `host.test.mjs` | 13 | `apply()` 的 provider 注册、目录、模型发现 |
| `card.test.mjs` | 18 | 状态路由脱敏；`lib/client.js` 真实执行；字段名对账 |
| `cli.test.mjs` | 2 | CLI 模块顶层求值、help 里的子命令与实现对账 |

两个值得单独说的：

- `host.test.mjs` 需要 `@earendil-works/pi-ai` 等宿主依赖才**能真正注册**。
  测试用 `test/fixtures/stubs` 里形状一致的桩包，运行前后自动链接/拆除
  （`tools/link-test-stubs.mjs`），跑完不留会骗过 `pnpm install` 的 `node_modules`。
- `cli.test.mjs` 覆盖 `bin.js` ——那是**用户跑的第一条命令**，且它引用的函数名没有编译期保障。
  本会话里真的发生过：Host 把 `readSession`/`verifySession` 换成 `readCredential`/
  `verifyCredential` 后，`bin.js` 还在调旧名字，`doctor` 一跑就抛；没有测试
  覆盖到它，因为其它套件根本不碰 CLI。
- `card.test.mjs` 里有两条**字段名对账**测试：把 `lib/client.js` 当文本读，
  取出它引用的配置字段与状态字段，跟 Host 的 schema/状态文档逐个比。这类
  bug（Host 改名、卡片没跟上）会**静默**渲染成"未登录"，没有任何报错——
  值得钉死。

## 许可

MIT
