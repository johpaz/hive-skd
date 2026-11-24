import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_PDF_INPUT_BYTES,
  MAX_PDF_PAGES_PER_REQUEST,
  MAX_XLSX_INPUT_BYTES,
  MAX_XLSX_ROWS_PER_SHEET,
  MAX_XLSX_SHEETS,
  OFFICE_PROCESSING_TIMEOUT_MS,
} from "../packages/core/src/tools/office/security-limits.ts";

const root = process.cwd();
const read = (file: string) => readFileSync(join(root, file), "utf8");
const readJson = (file: string) => JSON.parse(read(file)) as Record<string, any>;

describe("guardrails de plataforma y documentación", () => {
  test("mantiene Bun y TypeScript alineados entre paquetes, plantilla y CI", () => {
    const rootPackage = readJson("package.json");
    const corePackage = readJson("packages/core/package.json");
    const templatePackage = readJson("packages/cli/templates/hive-app/package.json");

    expect(rootPackage.engines.bun).toBe(">=1.4.4");
    expect(templatePackage.engines.bun).toBe(">=1.4.4");
    expect(rootPackage.devDependencies.typescript).toBe("7.0.2");
    expect(corePackage.peerDependencies.typescript).toBe("^7.0.2");

    for (const workflow of [
      ".github/workflows/ci.yml",
      ".github/workflows/publish.yml",
      ".github/workflows/version-bump.yml",
    ]) {
      expect(read(workflow)).toContain('bun-version: "1.4.4"');
    }
  });

  test("publica las guías que enlaza el README", () => {
    const rootPackage = readJson("package.json");
    expect(rootPackage.files).toContain("docs");
    expect(rootPackage.files).toContain("SECURITY.md");
    expect(read("README.md")).toContain("docs/UPGRADING.md");
    expect(read("README.md")).toContain("docs/SECURITY-GUARDRAILS.md");
  });

  test("documenta los límites Office con los valores implementados", () => {
    const guardrails = read("docs/SECURITY-GUARDRAILS.md");

    expect(MAX_PDF_INPUT_BYTES).toBe(25 * 1024 * 1024);
    expect(MAX_XLSX_INPUT_BYTES).toBe(15 * 1024 * 1024);
    expect(MAX_PDF_PAGES_PER_REQUEST).toBe(200);
    expect(MAX_XLSX_SHEETS).toBe(50);
    expect(MAX_XLSX_ROWS_PER_SHEET).toBe(10_000);
    expect(OFFICE_PROCESSING_TIMEOUT_MS).toBe(30_000);

    for (const documentedValue of [
      "25 MiB",
      "15 MiB",
      "200 páginas",
      "50 hojas",
      "10.000 filas por hoja",
      "30 segundos",
    ]) {
      expect(guardrails).toContain(documentedValue);
    }
  });
});
