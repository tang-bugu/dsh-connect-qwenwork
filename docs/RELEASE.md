# dsh-connect-qwenwork 发布状态

时间：2026-10-28 11:15（Asia/Shanghai）

## 已完成

| 项目 | 状态 | 位置 |
|---|---|---|
| GitHub 仓库 | 已创建并推送 | https://github.com/tang-bugu/dsh-connect-qwenwork |
| 仓库 topic | 已打（`dsh-plugin` 等 6 个） | 收录硬性要求 |
| 插件市场收录 PR | 已开，PR check 通过 | https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/9980 |
| npm 发布产物 | 已打包并端到端验证 | `npm pack` 120.6 kB / 37 个文件 |

## 发布前修掉的两个真问题

**1. `cordis.patch.yml` 是空的 `[]`，别人装了不会有任何反应。**

这是本次发布最关键的一处修复。原文件注释写的是「bundle patch 层没有被应用」，
所以挂载改由 profile 的用户层承担——但那只对**本机**成立。

用隔离的 `$DSH_HOME` 重测后确认：bundle patch 层是正常工作的，`--dump-config`
里能看到 `# == dsh-connect-qwenwork` 段；真正的区别在于**空列表不含任何
patch**。空 `[]` 与「层失效」在日志上长得一模一样，这正是当初误判的来源。

已改为真正的 insert 条目。验证方式：用 `npm pack` 出来的 tarball 装进一个
干净 profile（用户层 `[]`），启动后 `apply()` 走到 `provider-registered`，
`/plugins/dsh-connect-qwenwork/status` 返回 200，目录 4 个档位齐全。

**2. README 说自己有 146 个用例，实测是 141。**

`cli.test.mjs` 实际只有 2 条用例，文档写了 7 条。收录规则明确说「描述必须属实，
会与代码核对」，所以按实测改正为 141，并把 cli 行的覆盖说明改成实际内容。

## 待你操作

### npm 发布（需要新 token）

`~/.npmrc` 里 registry.npmjs.org 的 token 已失效：

```
$ npm whoami --registry https://registry.npmjs.org/
npm error code E401 ... requires you to be logged in
```

直接 GET `registry.npmjs.org/-/whoami` 也是 401，不是网络问题。补好之后：

```powershell
cd C:\Users\dell\Documents\deepseek-harness\default-workspace\dsh-connect-qwenwork
npm login --registry https://registry.npmjs.org/
npm publish
```

`package.json` 里已写好 `publishConfig.registry` 与 `access: public`，
不需要再加参数。包名 `dsh-connect-qwenwork` 在 npm 上仍未被占用。

> npm 发布后，插件市场的收录会自动升级成「npm 安装」形态：catalog 的
> `probe-npm.mjs` 会从仓库的 `repository` 字段反查 npm 包，只有仓库
> `repository.url` 指回被收录的 repo 才会被采信——这个字段已补好。

### PR 年龄门槛

Submission gate 现在因仓库 0.0 天未过（需满 1 天）。**不需要做任何事**：
`regate.yml` 每 6 小时自动重跑，满 24 小时后会自己变绿。预计
2026-10-29 02:52 UTC 之后。

## 本机当前安装状态未改动

本机 profile 仍是原来的 `file:` 安装，工作区源码与 profile 副本内容一致。
若要换成 GitHub 安装：

```powershell
dsh plugin --profile desktop add github:tang-bugu/dsh-connect-qwenwork
```

⚠️ 但按 `docs/INSTALL.md` 的记录，`file:` 状态下**不要**跑
`dsh plugin remove`——它会把工作区源码目录清空。换装前先备份。
