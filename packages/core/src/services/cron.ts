/**
 * Tareas programadas — la API, no la tool.
 *
 * A diferencia de la memoria, acá la implementación ya existía y era buena:
 * `CronScheduler` (`scheduler/CronScheduler.ts`) tiene `create`, `update`,
 * `delete`, `pause`, `resume`, `trigger`, `getHistory` y `listTasks`. El
 * problema era el alcance: sólo se llegaba a ella desde dentro de las ocho
 * `cron*Tool`, con argumentos con forma de LLM.
 *
 * Este servicio es la fachada. Conserva el comportamiento **híbrido** que ya
 * tenían las tools y que hive replica en su ruta HTTP: si hay un scheduler
 * corriendo se delega en él —es quien sabe calcular la próxima ejecución y
 * rearmar los timers—; si no, se opera directo sobre `cronJobs`, para que un
 * proceso que sólo administra tareas (una UI, un script) no necesite levantar
 * el scheduler entero.
 *
 * Un job creado sin scheduler queda persistido y lo recoge el próximo arranque.
 */

import { col } from "../storage/hive";
import type { CronJobDoc, TaskRunDoc } from "../storage/collections";
import { getSchedulerInstance } from "../tools/cron/index";
import { logger } from "../utils/logger";

const log = logger.child("services/cron");

export interface CreateCronInput {
  name: string;
  task: string;
  taskType: "recurring" | "one_shot";
  /** Requerido para `recurring`. */
  cronExpression?: string;
  /** Requerido para `one_shot` (ISO 8601). */
  fireAt?: string;
  timezone?: string;
  agentId?: string | null;
  channel?: string;
  payload?: Record<string, unknown>;
  toolName?: string | null;
  maxRuns?: number | null;
  startAt?: string;
  stopAt?: string;
  domAndDow?: boolean;
}

export interface CronJobSummary {
  id: string;
  name: string;
  task: string;
  taskType: CronJobDoc["task_type"];
  status: CronJobDoc["status"];
  cronExpression: string | null;
  fireAt: string | null;
  nextRun?: string | null;
}

function toSummary(doc: CronJobDoc): CronJobSummary {
  return {
    id: doc.id,
    name: doc.name,
    task: doc.task,
    taskType: doc.task_type,
    status: doc.status,
    cronExpression: doc.cron_expression,
    fireAt: doc.fire_at,
    nextRun: (doc as { next_run?: string | null }).next_run ?? null,
  };
}

async function jobsCol() {
  return col<CronJobDoc>("cronJobs");
}

/** true cuando hay un scheduler vivo capaz de disparar las tareas. */
export function hasScheduler(): boolean {
  return !!getSchedulerInstance();
}

export async function createCronJob(input: CreateCronInput): Promise<CronJobSummary> {
  if (!input.name?.trim()) throw new Error("La tarea necesita un nombre");
  if (input.taskType === "recurring" && !input.cronExpression) {
    throw new Error("Una tarea recurrente necesita `cronExpression`");
  }
  if (input.taskType === "one_shot" && !input.fireAt) {
    throw new Error("Una tarea de una sola vez necesita `fireAt`");
  }

  const timezone = input.timezone ?? "UTC";
  const scheduler = getSchedulerInstance();

  if (scheduler) {
    const res = await scheduler.create({
      name: input.name,
      task: input.task,
      task_type: input.taskType,
      cron_expression: input.cronExpression,
      fire_at: input.fireAt,
      timezone,
      start_at: input.startAt,
      stop_at: input.stopAt,
      dom_and_dow: input.domAndDow,
      agent_id: input.agentId ?? null,
      channel: input.channel,
      payload: input.payload,
      tool_name: input.toolName ?? null,
      max_runs: input.maxRuns ?? null,
    });
    const doc = (await (await jobsCol()).get(res.id))?.doc;
    return doc ? { ...toSummary(doc), nextRun: res.nextRun ?? null } : {
      id: res.id, name: input.name, task: input.task, taskType: input.taskType,
      status: "active", cronExpression: input.cronExpression ?? null,
      fireAt: input.fireAt ?? null, nextRun: res.nextRun ?? null,
    };
  }

  // Sin scheduler: se persiste igual y el próximo arranque la recoge.
  const c = await jobsCol();
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const now = new Date().toISOString();
  const doc = {
    id,
    name: input.name,
    task: input.task,
    task_type: input.taskType,
    cron_expression: input.cronExpression ?? null,
    fire_at: input.fireAt ?? null,
    timezone,
    start_at: input.startAt ?? null,
    stop_at: input.stopAt ?? null,
    dom_and_dow: input.domAndDow ? 1 : 0,
    max_runs: input.maxRuns ?? null,
    agent_id: input.agentId ?? "",
    channel: input.channel ?? "webchat",
    payload_json: JSON.stringify(input.payload ?? { prompt: input.task }),
    tool_name: input.toolName ?? null,
    status: "active",
    created_at: now,
    updated_at: now,
  } as unknown as CronJobDoc;

  await c.put(id, doc, { expectedVersion: 0 });
  log.info(`tarea "${input.name}" creada sin scheduler (${id}) — se activará al próximo arranque`);
  return toSummary(doc);
}

export async function listCronJobs(status?: CronJobDoc["status"]): Promise<CronJobSummary[]> {
  const rows = await (await jobsCol()).scan({});
  return rows
    .map((e) => e.doc)
    .filter((d) => (status ? d.status === status : true))
    .map(toSummary);
}

export async function getCronJob(id: string): Promise<CronJobSummary | null> {
  const entry = await (await jobsCol()).get(id);
  return entry ? toSummary(entry.doc) : null;
}

/** Cambia el estado de una tarea. `false` si no existe. */
async function setStatus(id: string, status: CronJobDoc["status"]): Promise<boolean> {
  const c = await jobsCol();
  const entry = await c.get(id);
  if (!entry) return false;
  await c.put(id, { ...entry.doc, status, updated_at: new Date().toISOString() } as CronJobDoc,
    { expectedVersion: entry.version });
  return true;
}

export interface UpdateCronInput {
  name?: string;
  task?: string;
  cronExpression?: string;
  fireAt?: string;
  timezone?: string;
  channel?: string;
  maxRuns?: number | null;
}

/**
 * Edita una tarea. Con scheduler se delega en él, porque cambiar la expresión
 * cron exige recalcular la próxima ejecución y rearmar el timer — hacerlo sólo
 * en la BD dejaría la tarea corriendo con el horario viejo hasta el reinicio.
 */
export async function updateCronJob(id: string, changes: UpdateCronInput): Promise<CronJobSummary> {
  const scheduler = getSchedulerInstance();

  if (scheduler) {
    const ok = await scheduler.update(id, {
      name: changes.name,
      task: changes.task,
      cron_expression: changes.cronExpression,
      fire_at: changes.fireAt,
      timezone: changes.timezone,
      channel: changes.channel,
      max_runs: changes.maxRuns,
    });
    if (!ok) throw new Error(`No existe la tarea "${id}"`);
  } else {
    const c = await jobsCol();
    const entry = await c.get(id);
    if (!entry) throw new Error(`No existe la tarea "${id}"`);

    const doc = { ...entry.doc, updated_at: new Date().toISOString() } as CronJobDoc;
    if (changes.name !== undefined) doc.name = changes.name;
    if (changes.task !== undefined) doc.task = changes.task;
    if (changes.cronExpression !== undefined) doc.cron_expression = changes.cronExpression;
    if (changes.fireAt !== undefined) doc.fire_at = changes.fireAt;
    if (changes.maxRuns !== undefined) (doc as { max_runs?: number | null }).max_runs = changes.maxRuns;
    await c.put(id, doc, { expectedVersion: entry.version });
  }

  const actualizada = await getCronJob(id);
  if (!actualizada) throw new Error(`No existe la tarea "${id}"`);
  return actualizada;
}

export async function pauseCronJob(id: string): Promise<boolean> {
  const scheduler = getSchedulerInstance();
  if (scheduler) return await scheduler.pause(id);
  return setStatus(id, "paused");
}

export async function resumeCronJob(id: string): Promise<boolean> {
  const scheduler = getSchedulerInstance();
  if (scheduler) return await scheduler.resume(id);
  return setStatus(id, "active");
}

export async function deleteCronJob(id: string): Promise<boolean> {
  const scheduler = getSchedulerInstance();
  if (scheduler) return await scheduler.delete(id);

  const c = await jobsCol();
  if (!(await c.get(id))) return false;
  await c.delete(id);
  return true;
}

/**
 * Dispara la tarea ahora. Requiere scheduler: sin él no hay nada que ejecute,
 * y devolver `true` sería mentir.
 */
export function triggerCronJob(id: string): boolean {
  const scheduler = getSchedulerInstance();
  if (!scheduler) throw new Error("Disparar una tarea requiere un scheduler activo");
  return scheduler.trigger(id);
}

export async function getCronHistory(id: string, limit = 50): Promise<TaskRunDoc[]> {
  const rows = await (await col<TaskRunDoc>("taskRuns")).scan({});
  return rows
    .map((e) => e.doc)
    .filter((r) => (r as { task_id?: string }).task_id === id)
    .sort((a, b) => String((b as { started_at?: string }).started_at ?? "")
      .localeCompare(String((a as { started_at?: string }).started_at ?? "")))
    .slice(0, limit);
}
