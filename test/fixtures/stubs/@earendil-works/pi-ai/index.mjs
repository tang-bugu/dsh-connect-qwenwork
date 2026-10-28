// 极简 pi-ai 桩：只提供本插件用到的三个入口，形状与真实包一致。
export function createProvider(input) {
  return {
    id: input.id,
    name: input.name,
    baseUrl: input.baseUrl,
    auth: input.auth,
    getModels: () => input.models,
    getAllModels: () => input.models,
    __api: input.api,
  }
}
