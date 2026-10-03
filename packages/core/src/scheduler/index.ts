/**
 * Scheduler — cron sobre HiveDB, con motor propio y sin dependencias.
 *
 * Soporta jobs recurrentes y de una sola vez. La persistencia pasó de SQLite a
 * las colecciones `cronJobs` / `taskRuns` de HiveDB en 0.1.5, y el motor pasó de
 * `croner` a `./cron` —sólo `setTimeout` e `Intl` del runtime— en 0.3.0.
 */

export { CronScheduler } from "./CronScheduler";

// El motor por separado, para quien quiera calcular o validar sin montar un
// scheduler: una UI que muestra "próximas corridas" mientras se escribe la
// expresión, por ejemplo.
export {
  Cron,
  parseCronExpression,
  isValidCronExpression,
  nextOccurrence,
  toWallClock,
  toInstant,
  assertTimeZone,
  type CronOptions,
  type CronFunction,
  type CronFields,
  type NextOccurrenceOptions,
  type WallClock,
} from "./cron/index";
// `executeScheduledTask` dejó de ser público: la ejecución entra por
// `createTaskHandler()`, que es lo que el scheduler engancha.
export { createTaskHandler, notifyTaskCompletion, setSchedulerForCleanup } from "./integration";
export type {
  CronJob,
  TaskRun,
  CreateCronJobInput,
  UpdateCronJobInput,
  CronJobStatus,
  CronJobExecutionHandler,
  CronJobExecutionResult,
  TaskType,
  TaskStatus,
  TaskRunStatus,
} from "./types";
