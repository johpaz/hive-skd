/** `HIVE_LOG_LEVEL` manda sobre el nivel de la configuración. */
import { afterEach, describe, expect, test } from "bun:test";
import { Logger } from "../packages/core/src/utils/logger";

const previous = process.env.HIVE_LOG_LEVEL;
afterEach(() => { if (previous === undefined) delete process.env.HIVE_LOG_LEVEL; else process.env.HIVE_LOG_LEVEL = previous; });

const logs = (logger: Logger, level: "debug" | "info" | "warn" | "error") => (logger as unknown as { shouldLog(l: string): boolean }).shouldLog(level);

describe("HIVE_LOG_LEVEL", () => {
  test("sin la variable rige el nivel dado (info por defecto)", () => {
    delete process.env.HIVE_LOG_LEVEL;
    const logger = new Logger({ console: false });
    expect(logs(logger, "info")).toBe(true);
    expect(logs(logger, "debug")).toBe(false);
  });

  test("warn silencia info y debug pero no warn", () => {
    process.env.HIVE_LOG_LEVEL = "warn";
    const logger = new Logger({ console: false, level: "debug" });
    expect(logs(logger, "info")).toBe(false);
    expect(logs(logger, "warn")).toBe(true);
  });

  test("debug muestra todo", () => {
    process.env.HIVE_LOG_LEVEL = "DEBUG";
    expect(logs(new Logger({ console: false }), "debug")).toBe(true);
  });

  test("un valor desconocido se ignora", () => {
    process.env.HIVE_LOG_LEVEL = "ruidoso";
    expect(logs(new Logger({ console: false }), "info")).toBe(true);
  });
});
