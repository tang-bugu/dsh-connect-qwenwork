# 接入 DSH 的硬约束：宿主提供的包必须静态导入

> 2026-10-26 实测记录。这个坑的症状是「插件装了但模型列表里没有」，**没有任何报错**，
> 所以单独留档。

## 是什么

`src/index.js` 需要四个由**宿主**（DSH 运行时）提供的包：

```js
import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
```

它们**不在** `~/.dsh/profiles/<profile>/node_modules` 里——DSH 从自己的
`app.asar` 内部提供它们。实测在 profile 目录下用原生 Node 解析：

```
@earendil-works/pi-ai     -> ERR_MODULE_NOT_FOUND
@deepseek-ai/dsh-llm      -> ERR_MODULE_NOT_FOUND
@deepseek-ai/dsh-llm-pi-ai-> ERR_MODULE_NOT_FOUND
@deepseek-ai/schemastery  -> OK        （这个确实在 profile 里）
```

## 为什么静态导入可以、动态导入不行

`@deepseek-ai/cordis-plugin-loader` 的 `import()` 实现（asar 内
`cordis-plugin-loader/lib/index.js`）：

```js
import(name, getOuterStack) {
  if (name.startsWith('cordis:')) return this.ctx.loader.builtins[...]
  return composeError(async (info) => {
    info.offset += 3
    if (this.ctx.loader.internal) return await this.ctx.loader.internal.import(name, this.ctx.baseUrl, {})
    else if (name.startsWith('.')) return await import(new URL(name, this.ctx.baseUrl).href)
    else return await import(name)          // ← 原生解析器，找不到 asar 内的包
  }, getOuterStack)
}
```

- **静态 `import`** 在插件模块被加载时解析，走宿主的模块系统（能看见 asar 内的包）；
- **动态 `await import(...)`** 由 Node 原生加载器解析，从插件自身的
  `node_modules` 往上找，找不到就是 `ERR_MODULE_NOT_FOUND`。

## 症状与代价

早期版本为了"宿主缺包时插件仍能挂上"，把四个导入写成惰性 `await import()`
并 `try/catch`。结果：

```
apply() 被调用
  → await import('@earendil-works/pi-ai') 抛出 ERR_MODULE_NOT_FOUND
  → catch 里 log 一行 warn
  → return                      ← provider 从未注册
```

界面上看到的就是「只有 workbuddy，没有千问办公」，而日志里只有一行容易忽略的
warn。**静态导入反而是更诚实的选择**：宿主真缺包时整个模块加载失败，错误是显式的。

参考插件 `dsh-connect-workbuddy` 一直用静态导入——这就是它从没遇到这个问题的原因。

## 测试侧的连带影响

静态导入在**链接阶段**解析，所以任何 `import('./index.js')` 的测试都必须在导入
之前先把桩包链接进 `node_modules`：

- `src/host.test.mjs`：启动时 `execFileSync(node, tools/link-test-stubs.mjs)`
- `src/card.test.mjs`：同上（否则直接 `ERR_MODULE_NOT_FOUND` 崩掉）

两个套件都在结尾 `--clean` 拆除，不留会骗过 `pnpm install` 的空 `node_modules`。

## 怎么验证「真的注册上了」

裸 Node 在 profile 里解析不到这些包，**所以不能用它验证**。唯一可靠的验证是：

1. 重启 DSH，让加载器重新读取 profile；
2. 看模型选择器里有没有「千问办公 (QwenWork)」的四个档位；
3. 或看设置页 Plugins 下有没有本插件的卡片。
