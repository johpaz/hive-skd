/**
 * Delegación asíncrona: el resumen que recibe el coordinador al cerrar el turno trae el aviso
 * del oráculo (`verification`) de cada entrega, con la instrucción de no afirmarla como comprobada.
 */

process.env.HIVE_DB_PATH = ":memory:";

import { afterAll, beforeAll, expect, test } from "bun:test";
import { ensureHiveDb } from "../packages/core/src/storage/bootstrap";
import { closeHiveDb } from "../packages/core/src/storage/hivedb";
import {
  recordDelegationOutcome,
  registerDelegatedTask,
  sealDelegationGroup,
  setDelegationSummaryEnqueuer,
} from "../packages/core/src/gateway/delegation-groups";
import { describeVerification } from "../packages/core/src/agent/oracle-checks";

let summaries: string[] = [];

beforeAll(async () => {
  closeHiveDb();
  await ensureHiveDb();
  setDelegationSummaryEnqueuer(async (_group, content) => { summaries.push(content); return { id: "job-1" }; });
});
afterAll(() => { setDelegationSummaryEnqueuer(null); closeHiveDb(); });

async function finish(turnId: string, result: Record<string, unknown>) {
  summaries = [];
  await registerDelegatedTask({ turnId, taskId: "t1", threadId: "h1" });
  await sealDelegationGroup(turnId);
  await recordDelegationOutcome({ turnId, taskId: "t1", jobId: "j1", workerId: "especialista", taskName: "Responder", ok: true, result });
  return summaries[0] ?? "";
}

test("una entrega sin respaldo del oráculo llega al coordinador marcada, con la instrucción de ser honesto", async () => {
  const verification = describeVerification({ corrections: 2, unsatisfied: true });
  const prompt = await finish("turno-sin-respaldo", { content: "No tengo eso documentado.", checks: { status: "unchecked", summary: "-" }, verification });
  expect(prompt).toContain('verification.status="unsupported"');
  expect(prompt).toContain('"status":"unsupported"');
  expect(prompt).toContain("No la presentes como un hecho comprobado");
});

test("una entrega que el oráculo no cuestionó no trae verification", async () => {
  const prompt = await finish("turno-ok", { content: "Hive SDK es un framework.", checks: { status: "unchecked", summary: "-" } });
  expect(prompt).toContain('"verification":null');
});
