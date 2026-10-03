process.env.HIVE_DB_PATH = ":memory:";

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { EthicsGuard } from "./EthicsGuard";
import { closeHiveDb } from "../storage/hivedb";
import { ensureHiveDb } from "../storage/bootstrap";
import { col } from "../storage/hive";
import { toIndexable } from "../storage/hive";
import type { PlaybookDoc } from "../storage/collections";

async function addRule(id: string, rule: string, category: string, opts?: {
	applicableTo?: string;
	helpfulCount?: number;
	active?: boolean;
	userId?: string;
}) {
	const playbookCol = await col<PlaybookDoc>("playbook");
	const now = Date.now();
	await playbookCol.put(id, {
		id,
		rule,
		category,
		user_id: opts?.userId ?? "",
		applicable_to: opts?.applicableTo ?? null,
		helpful_count: opts?.helpfulCount ?? 0,
		harmful_count: 0,
		active: opts?.active ?? true,
		source_reflection_id: toIndexable(null),
		created_at: now,
		updated_at: now,
	});
}

beforeEach(async () => {
	closeHiveDb();
	await ensureHiveDb();
});

afterEach(() => {
	closeHiveDb();
});

describe("EthicsGuard", () => {
	it("sólo devuelve reglas de response_quality activas", async () => {
		await addRule("rq-1", "Verificá las fuentes antes de responder", "response_quality");
		await addRule("rq-2", "Regla apagada", "response_quality", { active: false });
		await addRule("otra", "Usá web_search para noticias", "tool_selection");

		const rules = await new EthicsGuard().getRules();

		expect(rules.map((r) => r.id)).toEqual(["rq-1"]);
	});

	it("ordena por helpful_count descendente", async () => {
		await addRule("poco", "poco útil", "response_quality", { helpfulCount: 1 });
		await addRule("mucho", "muy útil", "response_quality", { helpfulCount: 9 });

		const rules = await new EthicsGuard().getRules();

		expect(rules.map((r) => r.id)).toEqual(["mucho", "poco"]);
	});

	it("filtra por agentRole cuando alguna regla lo declara", async () => {
		await addRule("para-coord", "regla del coordinador", "response_quality", {
			applicableTo: JSON.stringify(["coordinator"]),
		});
		await addRule("para-worker", "regla del worker", "response_quality", {
			applicableTo: JSON.stringify(["worker"]),
		});

		const rules = await new EthicsGuard().getRules("coordinator");

		expect(rules.map((r) => r.id)).toEqual(["para-coord"]);
	});

	it("cae a todas las reglas si ninguna declara ese rol", async () => {
		// Sin esto, un `applicable_to` mal cargado dejaría al agente sin capa
		// de calidad en vez de con una de más.
		await addRule("generica", "regla general", "response_quality", {
			applicableTo: JSON.stringify(["worker"]),
		});

		const rules = await new EthicsGuard().getRules("coordinator");

		expect(rules.map((r) => r.id)).toEqual(["generica"]);
	});

	it("injectIntoPrompt agrega las reglas y conserva el prompt original", async () => {
		await addRule("rq-1", "Verificá las fuentes", "response_quality");

		const guard = new EthicsGuard();
		const result = guard.injectIntoPrompt("Eres un asistente.", await guard.getRules());

		expect(result).toContain("Eres un asistente.");
		expect(result).toContain("## Reglas de Calidad de Respuesta");
		expect(result).toContain("- Verificá las fuentes");
	});

	it("injectIntoPrompt devuelve el prompt intacto sin reglas", () => {
		expect(new EthicsGuard().injectIntoPrompt("Eres un asistente.", [])).toBe("Eres un asistente.");
	});

	it("hasEthicsLayer refleja si hay reglas cargadas", async () => {
		const guard = new EthicsGuard();
		expect(await guard.hasEthicsLayer()).toBe(false);

		await addRule("rq-1", "Verificá las fuentes", "response_quality");
		expect(await guard.hasEthicsLayer()).toBe(true);
	});
});
