/**
 * Contrato de tipos del SDK para quien lo consume.
 *
 * Se publica como TypeScript, así que el `tsc` del host recompila el código del
 * SDK con la config del host. Dos cosas lo rompían:
 *  - los imports internos con extensión `.ts` (TS5097 en cada uno, ~700 errores)
 *    salvo que el host activara `allowImportingTsExtensions`;
 *  - accesos de índice que `noUncheckedIndexedAccess` marca como posiblemente
 *    `undefined` (87 errores).
 *
 * Aquí se crea un proyecto de consumo mínimo y se comprueba que compila sin
 * errores con la config del README y con la más estricta, **sin** esa opción.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
let dir = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "hive-consumer-"));
  const modules = join(dir, "node_modules");
  mkdirSync(join(modules, "@johpaz"), { recursive: true });
  // El SDK y sus dependencias se resuelven como en un proyecto real.
  symlinkSync(ROOT, join(modules, "@johpaz", "hive-sdk"), "dir");
  symlinkSync(join(ROOT, "node_modules", "@types"), join(modules, "@types"), "dir");
  symlinkSync(join(ROOT, "node_modules", "zod"), join(modules, "zod"), "dir");
  writeFileSync(
    join(dir, "use.ts"),
    [
      'import { z } from "zod";',
      'import { createAgent, defineTool, defineSkill } from "@johpaz/hive-sdk";',
      'import { jevRoute, askJev } from "@johpaz/hive-sdk/agent";',
      'import { agents } from "@johpaz/hive-sdk/services";',
      "export const tool = defineTool({ name: \"x\", description: \"x\", schema: z.object({ q: z.string() }), execute: async ({ q }: { q: string }) => q });",
      "export const skill = defineSkill({ name: \"s\", description: \"s\", steps: [], tools: [], triggers: [] });",
      "export const make = () => createAgent({ name: \"a\", tools: [tool], thinking: \"auto\" });",
      "export const route = () => jevRoute(\"hola\", [{ id: \"a\", description: \"a\" }, { id: \"b\", description: \"b\" }]);",
      "export const ask = askJev;",
      "export const list = () => agents.listAgents();",
    ].join("\n"),
  );
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function typecheck(extra: Record<string, unknown>): Promise<string[]> {
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022", module: "ESNext", moduleResolution: "bundler", lib: ["ES2022"], types: ["bun"],
        strict: true, skipLibCheck: true, noEmit: true, esModuleInterop: true, ...extra,
      },
      include: ["use.ts"],
    }),
  );
  const proc = Bun.spawn([join(ROOT, "node_modules", ".bin", "tsc"), "-p", join(dir, "tsconfig.json")], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  await proc.exited;
  return out.split("\n").filter((line) => line.includes("error TS"));
}

describe("el SDK compila en el proyecto de quien lo usa", () => {
  test("config del README (strict, ES2022, tipos de Bun), sin allowImportingTsExtensions", async () => {
    expect(await typecheck({})).toEqual([]);
  }, 240_000);

  test("config estricta (+ noUncheckedIndexedAccess), sin allowImportingTsExtensions", async () => {
    expect(await typecheck({ noUncheckedIndexedAccess: true })).toEqual([]);
  }, 240_000);
});
