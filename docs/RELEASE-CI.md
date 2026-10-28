# 自动发布（GitHub Actions）

推一个 `v*` 标签，GitHub Actions 自动跑测试、发布 npm、建 Release。

## 一次性配置：加 `NPM_TOKEN`

自动化发布的唯一前置是给仓库加一个 secret。

**第 1 步：建 token**

打开 https://www.npmjs.com/settings/tangbugu/tokens → **Generate New Token → Granular Access Token**：

| 字段 | 填什么 | 为什么 |
|---|---|---|
| Token name | `dsh-connect-qwenwork CI` | 便于日后单独吊销 |
| Expiration | 90 天 | 到期后重新建；太短会突然断掉发布 |
| Permissions | **Read and write** | Read-only 发布时报 403 |
| Packages and scopes | **All packages** | 发布新版本要在既有包上写；限定单包也行，但新建包时选不到 |
| **Bypass two-factor authentication** | **✅ 必须勾** | 不勾就是本文档要解决的 E403 |

> **不要用 Classic Token。** npm 已经把「发布」收紧了：现在的报错是
> `Two-factor authentication or granular access token with bypass 2fa enabled is required`。
> 你的账号 `two-factor auth: disabled`，没有验证码可输，因此**只有 granular + bypass 这一条路**。

**第 2 步：加进仓库 secret**

```
https://github.com/tang-bugu/dsh-connect-qwenwork/settings/secrets/actions
```

→ **New repository secret** → Name 填 **`NPM_TOKEN`**（必须一字不差）→ Secret 粘贴 token。

也可以命令行（需要 gh）：

```powershell
gh secret set NPM_TOKEN --repo tang-bugu/dsh-connect-qwenwork
```

## 日常发布

```powershell
cd C:\Users\dell\Documents\deepseek-harness\default-workspace\dsh-connect-qwenwork
npm run release
```

这一条会依次做：跑 141 个用例 → `npm version patch` 把 `0.1.0` 改成 `0.1.1` 并提交、打 tag → 推送 tag。

推送那一刻工作流启动，做四件事：

1. **必须是 tag** —— 从分支手动触发会被拦下，报错直接说明原因
2. **版本与 tag 一致** —— tag 是 `v0.1.1` 而 `package.json` 是 `0.1.0` 会在这里失败
3. **跑测试** —— 9 个套件、不联网（不跑 `npm install`，见下）
4. **发布 npm**（`--provenance`）→ **建 GitHub Release**（自动生成更新说明）

## 为什么不用「每次 push 到 main 就发」

npm 的版本号**一旦发布不可覆盖**。每次 push 都发就必须自动 bump 版本号，那会让版本号与 git 历史失去一一对应——出问题时说不清「npm 上的 0.1.7 是哪个 commit」。

tag 是显式的意图声明，也是事后唯一能对齐「版本 ↔ 提交」的凭据。所以：**合并代码不发布，打 tag 才发布**。

## 为什么 CI 里不跑 `npm install`

本包 141 个用例不依赖任何 npm 包：宿主提供的 4 个包（`@earendil-works/pi-ai` 等）由 `test/fixtures/stubs` 里的桩替代，测试自己链接和拆除（`tools/link-test-stubs.mjs`）。

实测：工作区**没有** `node_modules` 时，9 个套件全部通过。所以工作流省掉 `npm install`，也省掉了「安装失败让发布莫名变红」这一整类问题。

## 发布后核对

```powershell
npm view dsh-connect-qwenwork version --registry https://registry.npmjs.org/
```

或者在 Actions 页面看这次 run。provenance 可以在 npm 包页面看到「Built and signed on GitHub Actions」徽章。

## 从 token 切到 OIDC（可选，包发出去之后）

`--provenance` 已经用 OIDC 做签名，但**认证发布**仍需 token，原因是个先有鸡还是先有蛋的问题：npm 的 trusted publishing 要求先在 npmjs.com 上把「仓库 + 工作流文件」注册成该包的发布者，而**新包还不存在时无法注册**。

所以顺序是：先用 token 发出 `0.1.0` → 然后到
`https://www.npmjs.com/package/dsh-connect-qwenwork/access` 绑定
`tang-bugu/dsh-connect-qwenwork` + `.github/workflows/release.yml` → 之后可以把工作流里的
`NODE_AUTH_TOKEN` 和 `npm publish` 的 token 认证删掉，改由 OIDC 直接换 token，再吊销 `NPM_TOKEN`。

## 常见失败

| 报错 | 原因 | 处理 |
|---|---|---|
| `npm ERR! 403 ... bypass 2fa` | token 没勾 Bypass 2FA，或权限是 Read-only | 重建 token，两处都查 |
| `tag/version mismatch` | 手改了 `package.json` 的 version 但没打 tag，或反过来 | 用 `npm version x.y.z`，别手改 |
| `must run on a tag` | 在 Actions 页面选了分支重跑 | 重跑时选 `v*` tag |
| `E409` / 版本已存在 | 同一版本发了第二次 | `npm version patch` 升版本 |
| `EPERM ... npm-cache` | 本机 npm 缓存目录不可写 | 加 `$env:npm_config_cache="$env:TEMP\dsh-npm-cache"` |

## 注意：本机 profile 仍是旧装法

自动化只负责把包发到 npm。本机 profile 仍是 `file:` 安装（见 `docs/INSTALL.md`），
**没有**跟着版本走。要换成 npm 版本：

```powershell
dsh plugin --profile desktop add dsh-connect-qwenwork
```

⚠️ 从 `file:` 切走前先备份工作区源码——按 `docs/INSTALL.md` 的记录，
`file:` 状态下跑 `dsh plugin remove` 会清空源目录。
