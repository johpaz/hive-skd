import { resolvePort } from "../utils/port";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { availableParallelism, homedir } from "node:os";

type LogLevel = "debug" | "info" | "warn" | "error";
type DMPolicy = "open" | "pairing" | "allowlist";
type Transport = "stdio" | "sse" | "websocket" | "http";

export function loadEnv(hiveDir: string): void {
  const envPath = path.join(hiveDir, ".env");
  if (existsSync(envPath)) {
    try {
      const text = readFileSync(envPath, "utf8");
      const lines = text.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;

        const [key, ...valueParts] = trimmed.split("=");
        if (key && valueParts.length > 0) {
          const value = valueParts.join("=").trim().replace(/^['"]|['"]$/g, "");
          const normalizedKey = key.trim();
          // Explicit process environment values (for example the random
          // port assigned by the desktop shell) must take precedence over the
          // persisted .env file. This follows dotenv conventions and prevents
          // a previous CLI port from breaking desktop startup.
          if (process.env[normalizedKey] === undefined) {
            process.env[normalizedKey] = value;
          }
        }
      }
    } catch (e) {
      // Ignore errors loading .env
    }
  }
}

export function getHiveDir(): string {
  // Priority 1: HIVE_HOME explicitly set
  if (process.env.HIVE_HOME) {
    const hiveDir = process.env.HIVE_HOME.startsWith("~")
      ? path.join(homedir(), process.env.HIVE_HOME.slice(1))
      : process.env.HIVE_HOME;
    loadEnv(hiveDir);
    return hiveDir;
  }

  // Priority 2: HIVE_DEV mode defaults (Local folder)
  // Only check process.env.HIVE_DEV directly - don't load from .env files
  // This ensures production mode is the default unless explicitly set
  if (process.env.HIVE_DEV === "1" || process.env.HIVE_DEV === "true") {
    const localDir = path.join(process.cwd(), ".hive-dev");
    loadEnv(localDir);
    return localDir;
  }

  // Priority 3: Default ~/.hive
  const defaultDir = path.join(homedir(), ".hive");
  loadEnv(defaultDir);
  return defaultDir;
}

const expandPath = (p: string): string => {
  if (p.startsWith("~/.hive")) {
    const hiveDir = getHiveDir();
    return p.replace("~/.hive", hiveDir);
  }
  if (p.startsWith("~")) {
    return path.join(homedir(), p.slice(1));
  }
  return p;
};

const expandEnvVars = (value: string): string => {
  return value.replace(/\$\{([^}]+)\}/g, (_, key) => {
    return process.env[key] || "";
  });
};

const expandEnvInObject = <T>(obj: T): T => {
  if (typeof obj === "string") {
    return expandEnvVars(obj) as T;
  }
  if (Array.isArray(obj)) {
    return obj.map(expandEnvInObject) as T;
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = expandEnvInObject(value);
    }
    return result as T;
  }
  return obj;
};

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  rateLimit?: number;
  retries?: number;
  retryDelayMs?: number;
}

interface ToolRestrictions {
  allow?: string[];
  deny?: string[];
}

interface ExecConfig {
  enabled?: boolean;
  allowlist?: string[];
  denylist?: string[];
  timeoutSeconds?: number;
  workDir?: string;
}

interface WebConfig {
  allowlist?: string[];
  denylist?: string[];
  timeoutSeconds?: number;
}

interface BrowserConfig {
  enabled?: boolean;
  headless?: boolean;
  timeoutMs?: number;
  sessionName?: string;
  // Queda un solo backend: Bun.WebView in-process. La clave sobrevive para no
  // romper configs viejas —"agent-browser" se acepta, avisa y usa el WebView—
  // y se puede quitar sin más. Lo pisa HIVE_BROWSER_BACKEND.
  backend?: "agent-browser" | "webview" | "auto";
  // Guarda las cookies para que los logins sobrevivan a un reinicio. Default
  // activo; apagarlo hace que cada arranque empiece sin historia.
  persistSession?: boolean;
}

interface CanvasConfig {
  enabled?: boolean;
  port?: number;
}

interface WorkerPoolConfig {
  enabled?: boolean;
  maxWorkers?: number;
  toolTimeoutMs?: number;
  parallelToolCalls?: boolean;
}

interface SandboxConfig {
  dm?: ToolRestrictions;
  group?: ToolRestrictions;
}

interface ToolsConfig {
  allow?: string[];
  deny?: string[];
  exec?: ExecConfig;
  web?: WebConfig;
  browser?: BrowserConfig;
  canvas?: CanvasConfig;
  workerPool?: WorkerPoolConfig;
  sandbox?: SandboxConfig;
  // Per-tool timeout overrides (ms) keyed by tool name. Falls back to
  // workerPool.toolTimeoutMs when absent. Long-running tools like cli_exec
  // should set a higher value (e.g. 600000 = 10min).
  timeouts?: Record<string, number>;
}

interface ContextConfig {
  maxTokens?: number;
  compactionThreshold?: number;
  minMessagesAfterCompaction?: number;
  maxCompactionRetries?: number;
}

export interface AgentEntry {
  id: string;
  default?: boolean;
  workspace: string;
  description?: string;
}

interface AccountConfig {
  botToken?: string;
  applicationId?: string;
  appToken?: string;
  signingSecret?: string;
  dmPolicy?: DMPolicy;
  allowFrom?: string[];
}

interface ChannelConfig {
  enabled?: boolean;
  accounts?: Record<string, AccountConfig>;
  dmPolicy?: DMPolicy;
  allowFrom?: string[];
  groups?: boolean;
  guilds?: Record<string, unknown>;
  experimental?: boolean;
}

interface PeerMatch {
  kind?: "direct" | "group";
  id?: string;
}

interface BindingMatch {
  channel?: string;
  accountId?: string;
  peer?: PeerMatch;
  guildId?: string;
  teamId?: string;
  roles?: string[];
}

export interface Binding {
  agentId: string;
  match: BindingMatch;
}

export interface MCPServerConfig {
  enabled?: boolean;
  transport: Transport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  reconnect?: {
    enabled?: boolean;
    maxRetries?: number;
    delayMs?: number;
    backoffMultiplier?: number;
  };
}

interface MCPConfig {
  enabled?: boolean;
  servers?: Record<string, MCPServerConfig>;
  healthCheck?: {
    enabled?: boolean;
    intervalSeconds?: number;
  };
}

interface EpisodicMemoryConfig {
  enabled?: boolean;
  provider?: "openai" | "local";
  maxEpisodesPerSession?: number;
}

interface MemoryConfig {
  dbPath?: string;
  notesDir?: string;
  episodic?: EpisodicMemoryConfig;
}

interface CronConfig {
  enabled?: boolean;
  dbPath?: string;
  maxConcurrentJobs?: number;
  timezone?: string;
}

// G9 causal event log (HiveDB): IntentLogged/StateTransition/ToolCall emission
// from agent-loop.ts, consumed by reflector/curator/context-compiler. Off by
// default — each turn adds N+M+1 awaited db.append() calls to the critical path.
interface CausalLogConfig {
  enabled?: boolean;
}

interface RetryConfig {
  maxAttempts?: number;
  initialDelayMs?: number;
  backoffMultiplier?: number;
  maxDelayMs?: number;
}

interface JobRetryConfig {
  // Logical-failure retries (executor returned {ok:false}). Separate from
  // JobDoc.attempts, which only counts crash/lease-expiry reclaims.
  maxRetries?: number;
  initialDelayMs?: number;
  backoffMultiplier?: number;
  maxDelayMs?: number;
  jitter?: number;
}

interface HarnessConfig {
  maxGlobalConcurrency?: number;
  taskTimeoutMs?: number;
  jobLeaseMs?: number;
  runLeaseMs?: number;
  leaseRenewMs?: number;
  jobRetry?: JobRetryConfig;
}

interface HooksConfig {
  scripts?: {
    before_model_resolve?: string;
    before_prompt_build?: string;
    before_tool_call?: string;
    after_tool_call?: string;
    tool_result_persist?: string;
    before_compaction?: string;
    after_compaction?: string;
    message_received?: string;
    message_sending?: string;
    message_sent?: string;
    session_start?: string;
    session_end?: string;
    gateway_start?: string;
    gateway_stop?: string;
  };
}

interface LoggingConfig {
  level?: LogLevel;
  dir?: string;
  maxSizeMB?: number;
  maxFiles?: number;
  redactSensitive?: boolean;
  console?: boolean;
}

interface GatewayConfig {
  host?: string;
  port?: number;
  authToken?: string;
  pidFile?: string;
  tools?: ToolRestrictions;
}

interface ModelsConfig {
  defaultProvider?: "openai" | "anthropic" | "gemini" | "mistral" | "kimi" | "ollama" | "openrouter" | "deepseek" | "hiveagents";
  defaults?: Record<string, string>;
  providers?: Record<string, ProviderConfig>;
}

interface SessionsConfig {
  dir?: string;
  pruneAfterHours?: number;
  maxTranscriptSizeMB?: number;
}

interface SkillsConfig {
  allowBundled?: string[];
  managedDir?: string;
  extraDirs?: string[];
  hotReload?: boolean;
  maxSkillSizeKB?: number;
}

interface SecurityConfig {
  maxMessageLength?: Record<string, number>;
  skillScanning?: boolean;
  warnOnInsecureConfig?: boolean;
  allowedUsers?: string[];
}

export interface UserConfig {
  id: string;
  name: string;
  channels?: Record<string, string>;
}

export interface Config {
  gateway?: GatewayConfig;
  logging?: LoggingConfig;
  user?: UserConfig;
  agent?: {
    defaultAgentId?: string;
    baseDir?: string;
    context?: ContextConfig;
  };
  models?: ModelsConfig;
  sessions?: SessionsConfig;
  agents?: {
    list?: AgentEntry[];
  };
  bindings?: Binding[];
  channels?: Record<string, ChannelConfig>;
  tools?: ToolsConfig;
  skills?: SkillsConfig;
  mcp?: MCPConfig;
  memory?: MemoryConfig;
  cron?: CronConfig;
  causalLog?: CausalLogConfig;
  retry?: RetryConfig;
  harness?: HarnessConfig;
  security?: SecurityConfig;
  hooks?: HooksConfig;
}



function buildDefaultConfig(): Config {
  const hiveDir = getHiveDir();
  return {
    gateway: {
      host: process.env.HIVE_HOST || "127.0.0.1",
      port: resolvePort(process.env.HIVE_PORT, 18790),
      pidFile: path.join(hiveDir, "gateway.pid"),
      authToken: process.env.HIVE_AUTH_TOKEN || undefined,
      tools: {
        allow: ["*"],
        deny: [],
      },
    },
    logging: {
      level: (process.env.HIVE_LOG_LEVEL as any) || "info",
      dir: path.join(hiveDir, "logs"),
      maxSizeMB: 10,
      maxFiles: 5,
      redactSensitive: true,
      console: true,
    },
    agent: {
      defaultAgentId: "main",
      baseDir: path.join(hiveDir, "agents"),
      context: {
        maxTokens: 0,
        compactionThreshold: 0.8,
        minMessagesAfterCompaction: 4,
        maxCompactionRetries: 3,
      },
    },
    models: {
      defaultProvider: "openai",
      defaults: {
        openai: "gpt-4o",
        anthropic: "claude-sonnet-4-20250514",
        ollama: "llama3.2",
        openrouter: "anthropic/claude-sonnet-4",
      },
      providers: {},
    },
    sessions: {
      dir: path.join(hiveDir, "sessions"),
      pruneAfterHours: 24,
      maxTranscriptSizeMB: 50,
    },
    agents: {
      list: [
        {
          id: "main",
          default: true,
          workspace: path.join(hiveDir, "agents", "main", "workspace"),
          description: "Default personal assistant",
        },
      ],
    },
    bindings: [],
    channels: {
      webchat: { enabled: true },
    },
    tools: {
      allow: ["*"],
      deny: [],
      exec: {
        enabled: true,
        allowlist: [],
        denylist: ["rm -rf /", "sudo", "chmod 777", "> /dev/", "mkfs"],
        timeoutSeconds: 30,
        workDir: path.join(homedir(), "exec"), // Points to home for exec by default
      },
      web: {
        allowlist: [],
        denylist: ["file://", "ftp://"],
        timeoutSeconds: 30,
      },
      browser: {
        enabled: true,
        headless: true,
        timeoutMs: 30000,
        sessionName: "hive",
      },
      canvas: {
        enabled: true,
        port: 18793,
      },
      workerPool: {
        enabled: true,
        maxWorkers: Math.min(4, availableParallelism()),
        toolTimeoutMs: 300000,
        parallelToolCalls: true,
      },
      sandbox: {
        dm: { allow: ["*"], deny: [] },
        group: { allow: ["*"], deny: [] },
      },
    },
    skills: {
      allowBundled: [],
      managedDir: path.join(hiveDir, "skills"),
      extraDirs: [],
      hotReload: true,
      maxSkillSizeKB: 100,
    },
    mcp: {
      enabled: true,
      servers: {},
      healthCheck: {
        enabled: true,
        intervalSeconds: 60,
      },
    },
    memory: {
      dbPath: path.join(hiveDir, "memory.db"),
      notesDir: path.join(hiveDir, "agents", "main", "workspace", "memory"),
      episodic: {
        enabled: false,
        provider: "openai",
        maxEpisodesPerSession: 100,
      },
    },
    cron: {
      enabled: true,
      dbPath: path.join(hiveDir, "cron.db"),
      maxConcurrentJobs: 5,
      timezone: "UTC",
    },
    causalLog: {
      enabled: process.env.HIVE_CAUSAL_LOG === "true",
    },
    retry: {
      maxAttempts: 3,
      initialDelayMs: 1000,
      backoffMultiplier: 2,
      maxDelayMs: 30000,
    },
    harness: {
      maxGlobalConcurrency: parseInt(process.env.HIVE_HARNESS_MAX_CONCURRENCY || "4", 10),
      taskTimeoutMs: parseInt(process.env.HIVE_HARNESS_TASK_TIMEOUT_MS || String(30 * 60 * 1000), 10),
      jobLeaseMs: parseInt(process.env.HIVE_HARNESS_JOB_LEASE_MS || String(30 * 60 * 1000), 10),
      runLeaseMs: parseInt(process.env.HIVE_HARNESS_RUN_LEASE_MS || String(2 * 60 * 1000), 10),
      leaseRenewMs: parseInt(process.env.HIVE_HARNESS_LEASE_RENEW_MS || "30000", 10),
      jobRetry: {
        maxRetries: parseInt(process.env.HIVE_HARNESS_JOB_MAX_RETRIES || "3", 10),
        initialDelayMs: parseInt(process.env.HIVE_HARNESS_JOB_RETRY_INITIAL_MS || "1000", 10),
        backoffMultiplier: parseFloat(process.env.HIVE_HARNESS_JOB_RETRY_MULTIPLIER || "2"),
        maxDelayMs: parseInt(process.env.HIVE_HARNESS_JOB_RETRY_MAX_MS || String(5 * 60 * 1000), 10),
        jitter: parseFloat(process.env.HIVE_HARNESS_JOB_RETRY_JITTER || "0.2"),
      },
    },
    security: {
      maxMessageLength: {
        telegram: 4096,
        discord: 2000,
        slack: 40000,
        webchat: 100000,
        whatsapp: 65536,
        // Meta rechaza cualquier `text.body` de más de 4096 caracteres.
        whatsapp_cloud: 4096,
      },
      skillScanning: true,
      warnOnInsecureConfig: true,
    },
    hooks: {
      scripts: {},
    },
  };
}


// deepMerge kept for potential future use
function deepMerge<T extends Record<string, unknown>>(target: T, source: Partial<T>): T {
  const result = { ...target };

  for (const key of Object.keys(source) as (keyof T)[]) {
    const sourceValue = source[key];
    const targetValue = result[key];

    if (
      sourceValue !== undefined &&
      sourceValue !== null &&
      typeof sourceValue === "object" &&
      !Array.isArray(sourceValue) &&
      targetValue !== undefined &&
      targetValue !== null &&
      typeof targetValue === "object" &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMerge(
        targetValue as Record<string, unknown>,
        sourceValue as Record<string, unknown>
      ) as T[keyof T];
    } else if (sourceValue !== undefined) {
      result[key] = sourceValue as T[keyof T];
    }
  }

  return result;
}
export function loadConfig(): Config {
  return buildDefaultConfig();
}

export function expandConfigPath(p: string | undefined): string | undefined {
  if (!p) return undefined;
  return expandPath(p);
}

export { expandPath };
