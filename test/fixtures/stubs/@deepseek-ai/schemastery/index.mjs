/**
 * `@deepseek-ai/schemastery` 的最小桩。
 *
 * 只实现本插件用到的那几个方法：`z.object` / `z.string` / `z.boolean` /
 * `z.number` / `.default()` / `.volatile()` / `.description()`。
 *
 * 桩的意义是让测试能在没有宿主依赖的机器上跑；它**不**校验数据，因此任何
 * "schema 校验失败"类问题都不会被它发现——那类问题只能靠真实 DSH 验证。
 */

class Schema {
  constructor(type, options = {}) {
    this.type = type
    this.meta = { ...options }
    this.inner = {}
  }

  default(value) {
    this.meta.default = value
    return this
  }

  volatile(value = true) {
    this.meta.volatile = value
    return this
  }

  description(text) {
    this.meta.description = text
    return this
  }

  /** 本插件只做"取默认值 + 展开 live reference"，不实现真正的校验。 */
  resolve(value) {
    if (value === undefined) return this.meta.default
    if (value !== null && typeof value === 'object' && typeof value.get === 'function') return value.get()
    return value
  }
}

function make(type) {
  return (options) => new Schema(type, options)
}

const z = Object.assign(
  (definition) => new Schema('any', { definition }),
  {
    string: () => make('string')(),
    boolean: () => make('boolean')(),
    number: () => make('number')(),
    any: () => make('any')(),
    object: (shape) => {
      const schema = new Schema('object')
      schema.shape = shape
      // 暴露 `.properties` 以兼容按需读取默认值的调用方。
      schema.properties = Object.fromEntries(
        Object.entries(shape).map(([key, sub]) => [key, { default: sub?.meta?.default, type: sub?.type }]),
      )
      return schema
    },
  },
)

export default z
export { z }
