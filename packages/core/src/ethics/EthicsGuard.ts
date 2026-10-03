/**
 * EthicsGuard — capa de reglas de calidad de respuesta sobre el system prompt.
 *
 * Lee las reglas `category: "response_quality"` de la colección `playbook`.
 * Hasta 0.1.5 esta clase recibía un handle de SQLite y armaba SQL a mano
 * (incluyendo un JOIN contra la tabla virtual `playbook_fts`); esas tablas ya no
 * existen. Ahora la fuente es HiveDB, igual que para el resto del catálogo.
 *
 * Nota: la ética "constitucional" de un agente no pasa por acá — vive en la
 * colección `ethics` y la ensambla `agent/prompt-builder.ts` como primera
 * sección del prompt. Este guard es un complemento opcional para hosts que
 * quieran inyectar reglas aprendidas por ACE.
 */

import { col } from "../storage/hive";
import type { PlaybookDoc } from "../storage/collections";

export interface EthicsRule {
	id: string;
	rule: string;
	category: string;
	applicable_to: string | null;
	helpful_count: number;
	active: boolean;
}

const RESPONSE_QUALITY = "response_quality";

function byUsefulness(a: EthicsRule, b: EthicsRule): number {
	return b.helpful_count - a.helpful_count;
}

export class EthicsGuard {
	/**
	 * Reglas activas de calidad de respuesta.
	 *
	 * Con `agentRole` filtra por las que lo declaran en `applicable_to`; si
	 * ninguna coincide devuelve todas, para no dejar al agente sin capa por un
	 * `applicable_to` mal cargado.
	 *
	 * `userId` acota lo aprendido a quien corresponde: entran las globales
	 * (`user_id === ""`, sembradas con el producto) y las que salieron de las
	 * trazas de ese mismo usuario. Omitirlo deja sólo las globales.
	 */
	async getRules(agentRole?: string, userId?: string): Promise<EthicsRule[]> {
		const playbookCol = await col<PlaybookDoc>("playbook");
		const all = (await playbookCol.scan({}))
			.map((e) => ({
				id: e.id,
				rule: e.doc.rule,
				category: e.doc.category,
				applicable_to: e.doc.applicable_to,
				helpful_count: e.doc.helpful_count ?? 0,
				active: e.doc.active,
				user_id: e.doc.user_id ?? "",
			}))
			.filter((r) => r.active && r.category === RESPONSE_QUALITY)
			.filter((r) => r.user_id === "" || r.user_id === (userId ?? ""))
			.sort(byUsefulness);

		if (!agentRole) return all;

		const matching = all.filter((r) => (r.applicable_to ?? "").includes(agentRole));
		return matching.length > 0 ? matching : all;
	}

	injectIntoPrompt(systemPrompt: string, rules: EthicsRule[]): string {
		if (rules.length === 0) return systemPrompt;
		const ethicsSection = rules.map((r) => `- ${r.rule}`).join("\n");
		return `${systemPrompt}\n\n## Reglas de Calidad de Respuesta\n${ethicsSection}`;
	}

	async hasEthicsLayer(): Promise<boolean> {
		return (await this.getRules()).length > 0;
	}
}
