import { listModelIds } from "../gateway.js"
import { buildModel, type ConfigModel } from "../model.js"
import { buildIndex, lookupInIndex, type ModelsDevApi } from "../modelsdev.js"
import { applyModelOverride, overrideFor, type ModelOverrides } from "../overrides.js"

export async function discoverGatewayModels(input: {
  baseURL: string
  apiKey?: string
  providerNpm?: string
  catalog: ModelsDevApi
  overrides: ModelOverrides
}): Promise<Record<string, ConfigModel>> {
  const ids = await listModelIds(input.baseURL, input.apiKey)
  const index = buildIndex(input.catalog)
  const models: Record<string, ConfigModel> = {}
  for (const id of ids) {
    const override = overrideFor(input.overrides, id)
    const hit = lookupInIndex(index, id, override?.provider)
    models[id] = applyModelOverride(buildModel(id, hit, input.baseURL, input.providerNpm), override, id)
  }
  return models
}
