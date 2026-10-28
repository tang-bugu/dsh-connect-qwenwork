# 安装方式：必须 `file:`，不能 `link:`

> 2026-10-26 实测。这两条都会让插件"装了但看不到"，且都没有明显报错。

## 1. 用 `dsh plugin add`，别手改 profile

正确：

```bash
dsh plugin --profile desktop add "file:C:/path/to/dsh-connect-qwenwork"
```

它会把包写进 `dependencies` **并且**追加到 `dsh.profile.bundles`——后者才是
Cordis 树真正读取的列表。手改 `node_modules` 不够。

## 2. `link:` 不行，必须 `file:`

第一次我用 `dsh plugin add <路径>`，pnpm 默认生成了：

```
"dsh-connect-qwenwork": "link:C:/Users/.../dsh-connect-qwenwork"
```

结果是 profile 的 `node_modules/dsh-connect-qwenwork` 是一个 **junction**。
对比同目录下能正常工作的 `dsh-connect-workbuddy`：它是**真实目录**。

差异表现在加载层：symlink 下插件的 `apply()` 从未被调用（追踪日志里一行都没有），
而真实目录安装后能正常走到注册。所以安装必须写成：

```
"dsh-connect-qwenwork": "file:C:/Users/.../dsh-connect-qwenwork"
```

`file:` 会把包**复制**一份进 profile 的 `node_modules`。

## 3. ⚠️ `dsh plugin remove` 会删掉 `file:` 源目录的内容

这是实际发生的破坏，务必知道：

- 用 `file:` 安装后，`dsh plugin remove dsh-connect-qwenwork` 把**工作区里的
  插件源码目录清空了**（`src/`、`lib/`、`package.json` 等全没了，只剩一个空壳）。
- 恢复方法：`file:` 安装会在 profile 里留一份副本，
  `C:\Users\dell\.dsh\profiles\desktop\node_modules\dsh-connect-qwenwork\`
  是完整的，直接复制回去即可：

```powershell
Copy-Item -Path "$profile\node_modules\dsh-connect-qwenwork\*" `
          -Destination "C:\path\to\dsh-connect-qwenwork" -Recurse -Force
```

- **所以在 `file:` 安装状态下，不要用 `dsh plugin remove`。** 要换安装方式时，
  先手工备份源码，或先改成 `link:` 再 remove（`link:` 的 remove 只删链接）。

## 4. 修改代码后要同步进副本

`file:` 是复制而非链接，所以改了工作区源码后，**profile 里的副本不会自动更新**：

```powershell
Copy-Item -Path "$src\src\*" -Destination "$dst\src" -Recurse -Force
Copy-Item -Path "$src\lib\*" -Destination "$dst\lib" -Recurse -Force
Copy-Item -Path "$src\package.json","$src\cordis.patch.yml" -Destination $dst -Force
```

然后重启 DSH。

（如果只是开发调试，用 `link:` 更方便——改完直接重启即可。但 `link:` 目前
会导致加载器不调用 `apply()`，见第 2 条。所以要边改边测，还是得重复上面这步。）

## 5. 排查用追踪日志

`apply()` 每走到一步会写一行到：

```
%TEMP%\dsh-connect-qwenwork-trace\apply.log
```

四种可能的读数：

| 日志内容 | 含义 |
|---|---|
| 文件不存在 / 空 | 模块**没被加载**，或 `apply()` 没被调用 → 查安装与 bundles |
| 只有 `apply-enter` | 加载了，但 `ctx.inject(['llm'])` 没回调 → 宿主没提供 llm 服务 |
| 有 `imports-ok` 无 `provider-registered` | 注册抛出异常 → 查宿主 llm 服务的 API 版本 |
| 有 `provider-registered` | 注册成功 → 模型列表应该能看到，否则是 UI 侧筛选问题 |
