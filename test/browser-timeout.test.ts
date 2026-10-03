import { expect, test } from "bun:test"
import { withTimeout } from "../packages/core/src/tools/web/browser-service"

test("withTimeout devuelve el resultado si llega a tiempo", async () => {
  expect(await withTimeout(Promise.resolve(7), 100, "x")).toBe(7)
})

test("withTimeout rechaza cuando la operación tarda más que el timeout", async () => {
  const slow = new Promise((resolve) => setTimeout(resolve, 500))
  await expect(withTimeout(slow, 30, "El script")).rejects.toThrow(/El script superó el timeout de 30ms/)
})
