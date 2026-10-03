process.env.HIVE_DB_PATH = ":memory:";

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { CronScheduler } from "./CronScheduler";
import { closeHiveDb } from "../storage/hivedb";
import { ensureHiveDb } from "../storage/bootstrap";
import { col } from "../storage/hive";
import type { CronJobDoc } from "../storage/collections";

// `new CronScheduler(db, handler)` pasó a `new CronScheduler(handler)`: los jobs
// viven en la colección `cronJobs` de HiveDB y el scheduler la abre solo, así
// que ya no recibe un handle de base.

async function jobDoc(id: string): Promise<CronJobDoc> {
  const e = await (await col<CronJobDoc>("cronJobs")).get(id);
  if (!e) throw new Error(`no existe el job ${id}`);
  return e.doc;
}

/** Un job recurrente que no llega a dispararse solo durante el test. */
async function crearJob(s: CronScheduler, handlerFalla = false) {
  const { id } = await s.create({
    name: "prueba",
    task: "no importa",
    task_type: "recurring",
    cron_expression: "0 4 1 1 *", // una vez al año
    timezone: "UTC",
  } as any);
  await s.deactivate(id);
  return id;
}

beforeEach(async () => {
  closeHiveDb();
  await ensureHiveDb();
});

afterEach(() => {
  closeHiveDb();
});

describe("CronScheduler", () => {
  it("creates a scheduler instance with a handler", () => {
    const scheduler = new CronScheduler(async () => ({ success: true }));
    expect(scheduler).toBeDefined();
  });
});

describe("contadores bajo ejecuciones solapadas", () => {
  // Dos corridas del mismo job pueden solaparse: `protect` es opcional
  // y, además, la puesta al día por misfire llama a `execute()` en paralelo con
  // el job ya activado. Si el incremento se calcula fuera del reintento por
  // conflicto de versión, ambas leen el mismo valor y una escritura se pierde.

  it("cuenta los dos errores de dos corridas concurrentes", async () => {
    const s = new CronScheduler(async () => {
      // Ceder el turno adentro del handler es lo que garantiza el solapamiento:
      // sin esto las dos corridas se serializarían y el test pasaría igual con
      // el bug presente.
      await new Promise((r) => setTimeout(r, 10));
      return { success: false, error: "explotó" };
    });
    const id = await crearJob(s);

    await Promise.all([(s as any).execute(id), (s as any).execute(id)]);

    expect((await jobDoc(id)).error_count).toBe(2);
  });

  it("cuenta las dos corridas exitosas", async () => {
    const s = new CronScheduler(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { success: true, response: "ok" };
    });
    const id = await crearJob(s);

    await Promise.all([(s as any).execute(id), (s as any).execute(id)]);

    expect((await jobDoc(id)).run_count).toBe(2);
  });

  it("el umbral de auto-pausa se alcanza aunque las corridas se solapen", async () => {
    // La consecuencia real del contador perdido: un job que falla siempre nunca
    // llega a los 5 errores y se queda reintentando para siempre.
    const s = new CronScheduler(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { success: false, error: "explotó" };
    });
    const id = await crearJob(s);

    for (let i = 0; i < 3; i++) {
      await Promise.all([(s as any).execute(id), (s as any).execute(id)]);
    }

    const doc = await jobDoc(id);
    expect(doc.error_count).toBeGreaterThanOrEqual(5);
    expect(doc.status).toBe("paused");
  });
});
