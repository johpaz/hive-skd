/**
 * createAgent — la puerta de entrada del SDK.
 *
 * Hasta 0.1.5 esta función aceptaba `provider`, `model`, `maxIterations`,
 * `skills` y `workspace` y los descartaba: construía el agent loop global y
 * corría con lo que hubiera en la base. El agente terminaba respondiendo con un
 * modelo que el llamador nunca eligió. Ahora la config se persiste en la fila
 * del agente, que es de donde el loop resuelve provider y modelo.
 */

import type { MCPClientManager } from "../mcp/index";
import type { ToolDefinition } from "../tools/ToolRegistry";
import type { SkillDefinition } from "../skills/defineSkill";
import type { Tool } from "../tools/types";
import { describeInvalidArgs } from "../tools/validate-args";
import type { Provider } from "../agent/providers/index";
import type { ProviderCredentials } from "../agent/llm-client";
import type { JevOption } from "../agent/jev-decisions";
import { logger } from "../utils/logger";

const log = logger.child("api");

export interface AgentConfig {
	name: string;
	/** Id del modelo tal como lo nombra su dueño (ej. "claude-opus-5", "Qwen-Ambassador/Qwen3.8-Max"). */
	model?: string;
	/** Cualquiera de los 16 providers del catálogo. */
	provider?: Provider;
	systemPrompt?: string;
	tools?: ToolDefinition[];
	skills?: SkillDefinition[];
	mcpServers?: Record<string, { command?: string; url?: string; args?: string[]; env?: Record<string, string> }>;
	maxIterations?: number;
	/**
	 * Razonamiento del modelo: `"on"` (por defecto) siempre, `"off"` nunca,
	 * `"auto"` lo decide Jev por turno. Ver `AgentDoc.thinking`.
	 */
	thinking?: "off" | "auto" | "on";
	/** Tope de tokens de salida por llamada. Ver `AgentDoc.max_output_tokens`. */
	maxOutputTokens?: number;
	/**
	 * Llave y URL del proveedor para las llamadas de este agente; reemplazan al
	 * secret store y al entorno. Cada llamada puede traer las suyas.
	 */
	credentials?: ProviderCredentials;
	/** Jev para este agente: `{ apiKey, endpoint?, model? }`, `false` (apagado) o el proveedor `openrouter` por defecto. */
	jev?: JevOption;
	workspace?: string;
	/**
	 * Qué catálogo de fábrica se siembra al crear el agente:
	 *  - `"full"` (por defecto): los especialistas del catálogo y todas sus tools y skills activas.
	 *  - `"minimal"`: sin especialistas, y solo las tools de arranque activas más las que declares en
	 *    `tools`. Es lo que quieres para un agente de una app propia: Jev y el modelo no ven un
	 *    catálogo que no es tuyo, y el prompt es más corto.
	 *
	 * La elección es sobre filas nuevas: lo que un usuario ya activó o apagó en esa base no se pisa.
	 */
	seed?: "full" | "minimal";
	/** `false` no inicia el navegador (Bun.WebView): las tools `browser_*` responden "no disponible". Por defecto `true`. */
	browser?: boolean;
}

export interface Agent {
	readonly name: string;
	readonly id: string;
	readonly config: AgentConfig;
	/**
	 * Con `stream: true` se emiten eventos `token` con los deltas del proveedor
	 * a medida que llegan, además del `text` con la respuesta completa del turno.
	 */
	chat(message: string, opts?: AgentCallOptions): AsyncGenerator<AgentEvent>;
	run(task: string, opts?: Omit<AgentCallOptions, "stream">): Promise<string>;
}

/** Options of one call; they win over the ones given to `createAgent`. */
export interface AgentCallOptions {
	threadId?: string;
	channel?: string;
	stream?: boolean;
	/** Llave y URL del proveedor para esta llamada (p. ej. la de un inquilino). */
	credentials?: ProviderCredentials;
	/** Jev para esta llamada. */
	jev?: JevOption;
}

export type AgentEvent =
	/**
	 * Un fragmento recién llegado del proveedor, para pintar la respuesta
	 * mientras se genera.
	 *
	 * Sólo aparece si se pide `stream: true`. Los proveedores ya emitían estos
	 * deltas —el mecanismo estaba implementado— pero ningún punto de entrada los
	 * pasaba, así que nunca llegaban a nadie: la respuesta aparecía de golpe al
	 * terminar el turno.
	 */
	| { type: "token"; content: string }
	| { type: "text"; content: string }
	| { type: "tool_call"; name: string; args: Record<string, unknown> }
	| { type: "tool_result"; name: string; result: unknown }
	| { type: "done"; response: string; usage?: AgentTurnUsage };

/** What a turn cost: tokens, how many model calls and tool calls it took, and how long. */
export interface AgentTurnUsage {
	inputTokens: number;
	outputTokens: number;
	/** Reasoning tokens (reported by the server, or estimated from the reasoning text). */
	thinkingTokens: number;
	/** Model calls: 1 = answered directly. */
	iterations: number;
	toolCalls: number;
	elapsedMs: number;
}

/** Id estable derivado del nombre, para que dos `createAgent` con el mismo nombre compartan historial. */
function agentIdFrom(name: string): string {
	const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
	return slug || "agent";
}

/**
 * Convierte una tool declarada con `defineTool` al shape que espera el runtime.
 * Los `parameters` ya son JSON Schema: pasan tal cual. Sin ellos la tool queda
 * sin parámetros.
 *
 * Los argumentos se validan antes de ejecutar. Si no cumplen, la tool lanza un
 * error que el runtime devuelve al modelo como resultado (`[Tool Error] …`) con
 * los parámetros que sí existen: así el modelo que escribió `query` donde la tool
 * espera `consulta` puede corregir la llamada en la siguiente iteración, en vez
 * de que la tool corra con un argumento ausente.
 */
function toRuntimeTool(def: ToolDefinition): Tool {
	const parameters = def.parameters ?? { type: "object" as const, properties: {} };
	return {
		name: def.name,
		description: def.description,
		parameters: { type: "object", properties: parameters.properties ?? {}, required: parameters.required ?? [] },
		execute: async (params, config) => {
			const invalid = describeInvalidArgs(def.name, def.parameters, params);
			if (invalid) throw new Error(invalid);
			return def.execute(params, config);
		},
	};
}

export async function createAgent(config: AgentConfig): Promise<Agent> {
	const { ensureHiveDb } = await import("../storage/bootstrap");
	const { col, toIndexable } = await import("../storage/hive");
	const { catalogModelKey } = await import("../storage/model-id");
	const { registerAppTool } = await import("../tools/index");
	const { loadConfig } = await import("../config/loader");
	const { resolveUserId } = await import("../storage/onboarding");
	type AgentDoc = import("../storage/collections").AgentDoc;
	type ModelDoc = import("../storage/collections").ModelDoc;
	type ProviderDoc = import("../storage/collections").ProviderDoc;

	// Abre HiveDB, crea los índices y siembra el catálogo de providers/modelos.
	await ensureHiveDb(config.seed === "minimal" ? { specialists: "none" } : undefined);

	const coreConfig = await loadConfig();

	// Browser automation (Bun.WebView) si está habilitado.
	try {
		const { initializeBrowserService } = await import("../tools/web/browser-service");
		const browserConfig = config.browser === false
			? { ...coreConfig, tools: { ...coreConfig.tools, browser: { ...coreConfig.tools?.browser, enabled: false } } }
			: coreConfig;
		const browserService = initializeBrowserService(browserConfig);
		await browserService.start();
	} catch (err) {
		log.warn(`Browser service initialization skipped: ${(err as Error).message}`);
	}

	// Las tools de la app necesitan dos cosas para ser usables, y hasta 0.1.5 no
	// tenían ninguna:
	//   1. un ejecutor en el registry que arma el context compiler, y
	//   2. una fila en la colección `tools`, que es sobre la que corre la
	//      búsqueda por capacidad.
	// Sin (2) la tool existe pero el modelo no la descubre nunca: el loadout
	// inicial es mínimo a propósito y el resto se encuentra vía `search_knowledge`.
	if (config.tools?.length) {
		type ToolDoc = import("../storage/collections").ToolDoc;
		const toolsCol = await col<ToolDoc>("tools");
		const ts = Date.now();

		for (const tool of config.tools) {
			registerAppTool(toRuntimeTool(tool));
			await toolsCol.put(tool.name, {
				id: tool.name,
				name: tool.name,
				description: tool.description,
				category: tool.category ?? "app",
				enabled: true,
				active: true,
				created_at: ts,
				updated_at: ts,
			});
		}
	}

	// Las skills declaradas seguían el mismo camino que las tools —y hasta acá no
	// lo seguían: `config.skills` estaba tipado y se descartaba en silencio, así
	// que declarar una skill no hacía absolutamente nada. Una skill no necesita
	// ejecutor (es instruccional: metadatos más el cuerpo que se le inyecta al
	// agente), pero sí necesita su fila y su entrada en el índice, o el modelo
	// nunca la descubre.
	if (config.skills?.length) {
		const { createSkill, getSkill, updateSkill } = await import("../services/skills");

		for (const skill of config.skills) {
			// El cuerpo se arma con los pasos declarados: es lo que lee el agente.
			const body = [
				skill.description,
				"",
				...skill.steps.map((s, i) => `${i + 1}. **${s.action}** — ${s.instruction}`),
			].join("\n");

			const campos = {
				name: skill.name,
				description: skill.description,
				category: skill.category,
				body,
				tools: skill.tools,
				triggers: skill.triggers,
				version: skill.version,
			};

			// Idempotente: declarar la misma skill dos veces la actualiza.
			const existente = await getSkill(skill.name);
			if (existente) await updateSkill(skill.name, campos);
			else await createSkill({ id: skill.name, ...campos });
		}
	}

	// ─── Provider y modelo ────────────────────────────────────────────────────
	// El loop los lee de la fila del agente, así que hay que dejarlos escritos.
	const providerId = config.provider ?? "";
	let modelKey = "";

	if (config.model) {
		if (!providerId) {
			throw new Error(
				`createAgent({ model: "${config.model}" }) necesita también \`provider\`: el mismo modelo lo sirven varios providers y la clave del catálogo depende de cuál.`
			);
		}
		modelKey = catalogModelKey(providerId, config.model);

		const modelsCol = await col<ModelDoc>("models");
		const modelEntry = await modelsCol.get(modelKey);
		if (!modelEntry) {
			throw new Error(
				`El modelo "${config.model}" no está en el catálogo de ${providerId}. `
				+ `Agregalo a SEED_DATA.models o elegí uno de los sembrados.`
			);
		}
		// Activarlo, o `resolveProviderConfig` no encuentra base_url ni la key.
		await modelsCol.put(
			modelKey,
			{ ...modelEntry.doc, enabled: true, active: true },
			{ expectedVersion: modelEntry.version }
		);

		const providersCol = await col<ProviderDoc>("providers");
		const providerEntry = await providersCol.get(providerId);
		if (providerEntry) {
			await providersCol.put(
				providerId,
				{ ...providerEntry.doc, enabled: true, active: true },
				{ expectedVersion: providerEntry.version }
			);
		}
	}

	// ─── Fila del agente ──────────────────────────────────────────────────────
	const agentId = agentIdFrom(config.name);
	const agentsCol = await col<AgentDoc>("agents");
	const existing = await agentsCol.get(agentId);
	const now = Date.now();
	const userId = (await resolveUserId({})) || "default";

	await agentsCol.put(
		agentId,
		{
			...(existing?.doc ?? {}),
			id: agentId,
			user_id: existing?.doc.user_id ?? userId,
			name: config.name,
			description: existing?.doc.description ?? null,
			system_prompt: config.systemPrompt ?? existing?.doc.system_prompt ?? null,
			tone: existing?.doc.tone ?? null,
			role: existing?.doc.role ?? "coordinator",
			status: "idle",
			enabled: true,
			provider_id: toIndexable(providerId || null),
			model_id: toIndexable(modelKey || null),
			tools_json: existing?.doc.tools_json ?? null,
			skills_json: existing?.doc.skills_json ?? null,
			parent_id: toIndexable(null),
			max_iterations: config.maxIterations ?? existing?.doc.max_iterations ?? 25,
			thinking: config.thinking ?? existing?.doc.thinking,
			max_output_tokens: config.maxOutputTokens ?? existing?.doc.max_output_tokens ?? null,
			workspace: config.workspace ?? existing?.doc.workspace ?? null,
			lastTraceAt: existing?.doc.lastTraceAt ?? null,
			created_at: existing?.doc.created_at ?? now,
			updated_at: now,
		} as AgentDoc,
		existing ? { expectedVersion: existing.version } : undefined
	);

	// ─── Índice de capacidades ────────────────────────────────────────────────
	// Sin esto el agente queda limitado al loadout mínimo para siempre: el resto
	// de las tools y skills se descubren con `search_knowledge`, que corre sobre
	// el índice BM25, y ese índice no se llena solo. En hive lo hace
	// `gateway/initializer.ts` al arrancar; por la vía del SDK nadie lo llamaba.
	await syncCapabilityIndexes();

	// ─── MCP ──────────────────────────────────────────────────────────────────
	let mcpManager: MCPClientManager | null = null;
	if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
		const { MCPClientManager } = await import("../mcp/index");
		const mcpConfig = {
			servers: Object.fromEntries(
				Object.entries(config.mcpServers).map(([name, serverConfig]) => [
					name,
					{
						transport: (serverConfig.command ? "stdio" : "sse") as "stdio" | "sse",
						command: serverConfig.command,
						url: serverConfig.url,
						args: serverConfig.args ?? [],
						env: serverConfig.env ?? {},
						enabled: true,
					},
				])
			),
		};
		mcpManager = new MCPClientManager(mcpConfig);
		await mcpManager.initialize();
	}

	const { runAgent } = await import("../agent/agent-loop");

	const agente: Agent = {
		name: config.name,
		id: agentId,
		config,
		async *chat(message, opts) {
			const threadId = opts?.threadId ?? crypto.randomUUID();
			let response = "";
			let usage: AgentTurnUsage | undefined;

			// `onToken` es un callback y esto es un generador: los deltas se
			// encolan y se drenan entre chunks. Sin buffer habría que elegir entre
			// perder tokens o bloquear al proveedor mientras el consumidor lee.
			const pendientes: string[] = [];
			const onToken = opts?.stream ? (t: string) => { pendientes.push(t); } : undefined;
			const drenar = function* () {
				while (pendientes.length > 0) {
					yield { type: "token" as const, content: pendientes.shift()! };
				}
			};

			for await (const chunk of runAgent({
				agentId,
				userMessage: message,
				threadId,
				channel: opts?.channel ?? "cli",
				mcpManager,
				userId,
				onToken,
				credentials: opts?.credentials ?? config.credentials,
				jev: opts?.jev !== undefined ? opts.jev : config.jev,
			})) {
				yield* drenar();
				if (chunk.usage) {
					usage = {
						inputTokens: chunk.usage.input_tokens,
						outputTokens: chunk.usage.output_tokens,
						thinkingTokens: chunk.usage.thinking_tokens ?? 0,
						iterations: chunk.usage.iterations ?? 0,
						toolCalls: chunk.usage.tool_calls ?? 0,
						elapsedMs: chunk.usage.elapsed_ms ?? 0,
					};
				}
				for (const msg of chunk.agent?.messages ?? []) {
					if (typeof msg.content === "string" && msg.content) {
						response = msg.content;
						yield { type: "text" as const, content: msg.content };
					}
					for (const tc of msg.tool_calls ?? []) {
						const raw = tc.function?.arguments;
						yield {
							type: "tool_call" as const,
							name: tc.function?.name ?? "unknown",
							args: typeof raw === "string" ? safeParse(raw) : (raw ?? {}),
						};
					}
				}
				for (const msg of chunk.tools?.messages ?? []) {
					yield { type: "tool_result" as const, name: msg.name ?? "unknown", result: msg.content };
				}
			}

			yield* drenar();
			yield { type: "done" as const, response, usage };
		},
		async run(task, opts) {
			// El loop emite el texto acumulado del turno, no deltas: quedarse con el
			// último evento evita duplicar la respuesta al concatenar.
			let response = "";
			for await (const event of agente.chat(task, opts)) {
				if (event.type === "text") response = event.content;
				if (event.type === "done" && event.response) response = event.response;
			}
			return response;
		},
	};

	return agente;
}

function safeParse(raw: string): Record<string, unknown> {
	try {
		return JSON.parse(raw);
	} catch {
		return {};
	}
}

/**
 * Llena el índice BM25 de capacidades (tools, skills, reglas de playbook,
 * agentes del catálogo) sobre el que corre `search_knowledge`.
 *
 * Es el equivalente de lo que hace `gateway/initializer.ts` en hive al arrancar.
 * Los errores no se propagan: sin índice el agente sigue funcionando con el
 * loadout mínimo, y romper `createAgent` por una reindexación sería peor.
 */
export async function syncCapabilityIndexes(): Promise<void> {
	const { syncToolsToIndex, syncSkillsToIndex, syncPlaybookToIndex } = await import(
		"../agent/context-compiler"
	);
	const { syncCatalogAgentsToIndex } = await import("../agent/catalog-selector");

	const results = await Promise.allSettled([
		syncToolsToIndex(),
		syncSkillsToIndex(),
		syncPlaybookToIndex(),
		syncCatalogAgentsToIndex(),
	]);

	for (const result of results) {
		if (result.status === "rejected") {
			log.warn(`Capability index sync failed: ${result.reason}`);
		}
	}
}
