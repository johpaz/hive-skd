import { afterAll, beforeAll, expect, test } from "bun:test"
import { createAgent } from "../packages/core/src/api/createAgent"
import { getBrowserService } from "../packages/core/src/tools/web/browser-service"
import { col } from "../packages/core/src/storage/hive"
import { closeHiveDb } from "../packages/core/src/storage/hivedb"

const prev = process.env.HIVE_DB_PATH
beforeAll(() => { process.env.HIVE_DB_PATH = ":memory:" })
afterAll(async () => {
  await closeHiveDb()
  if (prev === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = prev
})

test("seed: minimal no siembra especialistas del catálogo y browser: false apaga el navegador", async () => {
  await createAgent({ name: "lean", seed: "minimal", browser: false })
  const agents = await (await col<{ id: string; source?: string }>("agents")).scan({})
  expect(agents.filter((a) => a.doc.source === "catalog")).toHaveLength(0)
  expect(getBrowserService()?.isAvailable()).toBe(false)
})
