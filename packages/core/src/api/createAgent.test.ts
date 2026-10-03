/**
 * `createAgent` persiste su configuración en la fila del agente.
 *
 * Hasta 0.1.5 aceptaba `provider`, `model`, `maxIterations`, `workspace` y
 * `systemPrompt` y los descartaba: construía el loop global y corría con lo que
 * hubiera en la base. Estos tests fijan que ahora sí lleguen.
 */

process.env.HIVE_DB_PATH = ":memory:";

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { z } from "zod";
import { closeHiveDb } from "../storage/hivedb";
import { ensureHiveDb } from "../storage/bootstrap";
import { col, fromIndexable } from "../storage/hive";
import { clearAppTools, createAllTools } from "../tools/index";
import { selectTools } from "../agent/tool-selector";
import { loadConfig } from "../config/loader";
import type { AgentDoc, ModelDoc } from "../storage/collections";
import { createAgent } from "./createAgent";
import { defineTool } from "../tools/ToolRegistry";
import { defineSkill } from "../skills/defineSkill";

beforeEach(async () => {
	closeHiveDb();
	clearAppTools();
	await ensureHiveDb();
});

afterEach(() => {
	clearAppTools();
	closeHiveDb();
});

describe("createAgent", () => {
	it("persiste provider, modelo, prompt e iteraciones en la fila del agente", async () => {
		const agent = await createAgent({
			name: "Test Agent",
			provider: "anthropic",
			model: "claude-opus-5",
			systemPrompt: "Sos un asistente de prueba.",
			maxIterations: 7,
			workspace: "/tmp/ws",
		});

		expect(agent.name).toBe("Test Agent");
		expect(agent.id).toBe("test_agent");

		const agentsCol = await col<AgentDoc>("agents");
		const row = (await agentsCol.get("test_agent"))!.doc;

		expect(fromIndexable(row.provider_id)).toBe("anthropic");
		expect(fromIndexable(row.model_id)).toBe("claude-opus-5");
		expect(row.system_prompt).toBe("Sos un asistente de prueba.");
		expect(row.max_iterations).toBe(7);
		expect(row.workspace).toBe("/tmp/ws");
	});

	it("prefija el id del modelo cuando el provider es revendedor", async () => {
		await createAgent({
			name: "reseller",
			provider: "modelscope",
			model: "Qwen-Ambassador/Qwen3.8-Max",
		});

		const agentsCol = await col<AgentDoc>("agents");
		const row = (await agentsCol.get("reseller"))!.doc;

		expect(fromIndexable(row.model_id)).toBe("modelscope/Qwen-Ambassador/Qwen3.8-Max");
	});

	it("activa el modelo elegido, o resolveProviderConfig no encuentra su base_url", async () => {
		await createAgent({ name: "activador", provider: "anthropic", model: "claude-opus-5" });

		const modelsCol = await col<ModelDoc>("models");
		const model = (await modelsCol.get("claude-opus-5"))!.doc;

		expect(model.active).toBe(true);
		expect(model.enabled).toBe(true);
	});

	it("rechaza un modelo que no está en el catálogo", async () => {
		await expect(
			createAgent({ name: "fantasma", provider: "anthropic", model: "claude-que-no-existe" })
		).rejects.toThrow(/no está en el catálogo/);
	});

	it("pide provider cuando se especifica un modelo", async () => {
		// El mismo modelo lo sirven varios providers y la clave del catálogo
		// depende de cuál, así que adivinarlo sería elegir por el usuario.
		await expect(createAgent({ name: "sin-provider", model: "claude-opus-5" })).rejects.toThrow(
			/necesita también `provider`/
		);
	});

	it("registra las tools de la app con su ejecutor, no sólo la declaración", async () => {
		const greet = defineTool({
			name: "greet_person",
			description: "Saluda a alguien",
			schema: z.object({ name: z.string().describe("a quién saludar") }),
			execute: async (args: { name: string }) => `Hola ${args.name}`,
		});

		await createAgent({ name: "con-tools", tools: [greet] });

		const registered = createAllTools(await loadConfig()).find((t) => t.name === "greet_person");
		expect(registered, "la tool no llegó al registry que lee el context compiler").toBeDefined();
		expect(registered!.parameters.properties).toHaveProperty("name");
		expect(registered!.parameters.required).toEqual(["name"]);
		expect(await registered!.execute({ name: "Ana" })).toBe("Hola Ana");
	});

	it("deja la tool de la app descubrible por búsqueda de capacidad", async () => {
		// El loadout inicial es mínimo a propósito; el resto se encuentra vía
		// `search_knowledge`, que corre sobre el índice BM25. Si createAgent no
		// siembra la fila en `tools` y no reindexa, la tool tiene ejecutor pero el
		// modelo no se entera de que existe.
		const weather = defineTool({
			name: "get_weather",
			description: "Consulta el clima actual de una ciudad. Sinónimos: tiempo, temperatura, pronóstico",
			schema: z.object({ city: z.string() }),
			execute: async (a: { city: string }) => `Soleado en ${a.city}`,
		});

		await createAgent({ name: "descubrible", tools: [weather] });

		const found = await selectTools("clima de una ciudad", undefined, 5);
		expect(found.map((t) => t.name)).toContain("get_weather");
	});

	it("reusa la fila al recrear un agente con el mismo nombre", async () => {
		const first = await createAgent({ name: "estable", provider: "anthropic", model: "claude-opus-5" });
		const second = await createAgent({ name: "estable", provider: "anthropic", model: "claude-sonnet-5" });

		expect(second.id).toBe(first.id);

		const agentsCol = await col<AgentDoc>("agents");
		const all = (await agentsCol.scan({})).filter((e) => e.id === "estable");
		expect(all).toHaveLength(1);
		expect(fromIndexable(all[0].doc.model_id)).toBe("claude-sonnet-5");
	});
});

describe("defineTool / defineSkill", () => {
	it("siguen siendo funciones de declaración puras", () => {
		const tool = defineTool({
			name: "greet",
			description: "Says hello",
			execute: async (args: { name: string }) => `Hello ${args.name}`,
		});
		expect(tool.name).toBe("greet");

		const skill = defineSkill({
			name: "greeting-skill",
			description: "Greeting skill",
			steps: [{ action: "greet", instruction: "Say hello" }],
		});
		expect(skill.name).toBe("greeting-skill");
	});
});
