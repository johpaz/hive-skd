/**
 * Configuración inicial de la colmena — elegir qué agentes se siembran.
 *
 * `seedAllData()` es todo o nada: siembra las 8 personas del catálogo en cada
 * arranque, con sus tools y skills, quiera el usuario o no. Para un producto
 * donde cada quien arma su enjambre eso es demasiado: alguien que sólo quiere un
 * investigador web se lleva el ingeniero de software y el operador de navegador.
 *
 * Este módulo permite elegir. Y lo que hace no es "sembrar sólo lo de este
 * agente", que es el error obvio: **las tools se comparten**. `web_fetch` lo
 * declaran el investigador web y el operador de navegador; `fs_*`, el operador
 * de archivos y el ingeniero. Se siembra la **unión** de lo que requieren los
 * agentes elegidos, más las `MINIMAL_TOOLS` que el coordinador necesita siempre.
 *
 * Y al revés: **desactivar un agente no borra nada**. Las filas de `tools` y
 * `skills` son globales y compartidas; borrar las de uno rompería a otro. Se
 * marca el agente y se recalcula la unión.
 */

import { col } from "../storage/hive";
import type { AgentDoc, ToolDoc, SkillDoc } from "../storage/collections";
import {
  CATALOG_AGENT_IDS, createSeedCatalogAgents, requiredCapabilitiesFor, listCatalogPersonas,
} from "../agent/agent-catalog";
import { MINIMAL_TOOLS } from "../agent/minimal-loadout";
import { expandToolAllowlist } from "../agent/delegation-runtime";
import { syncToolCatalogToIndex } from "../agent/tool-selector";
import { syncSkillsToIndex } from "../agent/skill-selector";
import { logger } from "../utils/logger";

const log = logger.child("services/setup");

export { listCatalogPersonas, CATALOG_AGENT_IDS };

export interface SeedPlan {
  /** Agentes de catálogo que quedarán activos. */
  agents: string[];
  /** Tools que hacen falta: unión de las de los agentes + las mínimas. */
  tools: string[];
  /** Skills que hacen falta: unión de las de los agentes. */
  skills: string[];
}

/**
 * Calcula qué haría falta sembrar para un conjunto de agentes, sin tocar nada.
 *
 * Existe separado de `applySeedPlan` para que una UI pueda mostrar "esto es lo
 * que se va a instalar" antes de que el usuario confirme.
 */
export function planSeedFor(agentIds: string[]): SeedPlan {
  const { toolPatterns, skills } = requiredCapabilitiesFor(agentIds);

  // Los patrones se expanden contra el registro vivo: `fs_*` no es una tool,
  // son varias, y hay que sembrarlas todas.
  const delCatalogo = expandToolAllowlist(toolPatterns);

  // Las mínimas van siempre: son la competencia del coordinador —delegar,
  // buscar, avisar— y sin ellas no hay colmena, haya los agentes que haya.
  const tools = [...new Set([...MINIMAL_TOOLS, ...delCatalogo])];

  return { agents: [...new Set(agentIds)], tools, skills };
}

/**
 * Deja activo exactamente el conjunto de agentes pedido.
 *
 * Las tools y skills que no hagan falta se **desactivan**, nunca se borran: otro
 * agente —o uno que el usuario active mañana— puede necesitarlas, y una fila
 * borrada habría que volver a sembrarla desde el código.
 */
export async function applySeedPlan(agentIds: string[]): Promise<SeedPlan> {
  const plan = planSeedFor(agentIds);
  const elegidos = new Set(plan.agents);
  const necesarias = new Set(plan.tools);
  const skillsNecesarias = new Set(plan.skills);

  // ── Agentes ────────────────────────────────────────────────────────────────
  const agentsCol = await col<AgentDoc>("agents");
  const semillas = createSeedCatalogAgents();
  for (const semilla of semillas) {
    const quiere = elegidos.has(semilla.id);
    const existente = await agentsCol.get(semilla.id);

    if (!existente) {
      // Los no elegidos no se crean: sembrarlos apagados llenaría la lista de
      // agentes que el usuario nunca pidió.
      if (!quiere) continue;
      await agentsCol.put(semilla.id, semilla, { expectedVersion: 0 });
      continue;
    }
    if (existente.doc.enabled !== quiere) {
      await agentsCol.put(semilla.id, { ...existente.doc, enabled: quiere, updated_at: Date.now() },
        { expectedVersion: existente.version });
    }
  }

  // ── Tools ──────────────────────────────────────────────────────────────────
  const toolsCol = await col<ToolDoc>("tools");
  let encendidas = 0, apagadas = 0;
  for (const entry of await toolsCol.scan({})) {
    const debeEstar = necesarias.has(entry.doc.name);
    if (entry.doc.active === debeEstar) continue;
    await toolsCol.put(entry.id, { ...entry.doc, active: debeEstar, updated_at: Date.now() },
      { expectedVersion: entry.version });
    debeEstar ? encendidas++ : apagadas++;
  }

  // ── Skills ─────────────────────────────────────────────────────────────────
  const skillsCol = await col<SkillDoc>("skills");
  for (const entry of await skillsCol.scan({})) {
    const debeEstar = skillsNecesarias.has(entry.doc.id) || skillsNecesarias.has(entry.doc.name);
    if (entry.doc.active === debeEstar) continue;
    await skillsCol.put(entry.id, { ...entry.doc, active: debeEstar, updated_at: Date.now() },
      { expectedVersion: entry.version });
  }

  await syncToolCatalogToIndex().catch((e) => log.warn(`no pude reindexar tools: ${(e as Error).message}`));
  await syncSkillsToIndex().catch((e) => log.warn(`no pude reindexar skills: ${(e as Error).message}`));

  log.info(
    `colmena configurada: ${plan.agents.length} agente(s), ` +
    `${plan.tools.length} tool(s) activas (+${encendidas}/-${apagadas})`,
  );
  return plan;
}

/**
 * Activa varios agentes del catálogo de una vez y siembra lo que les falte.
 *
 * Recalcula la unión con los que ya estaban: activar uno nunca puede apagar las
 * tools de otro. Existe en plural porque activarlos de a uno recalcularía y
 * reescribiría el catálogo entero una vez por agente — al armar un enjambre de
 * cinco especialistas, cinco pasadas sobre todas las tools y skills.
 */
export async function enableCatalogAgents(agentIds: string[]): Promise<SeedPlan> {
  const activos = await listEnabledCatalogAgents();
  return applySeedPlan([...new Set([...activos, ...agentIds])]);
}

/**
 * Activa un agente del catálogo y siembra lo que le falte.
 */
export async function enableCatalogAgent(agentId: string): Promise<SeedPlan> {
  return enableCatalogAgents([agentId]);
}

/** Lo que falta activar para que un conjunto de agentes pueda trabajar. */
export interface ActivationGap {
  /** Agentes de catálogo pedidos que hoy están apagados. */
  agents: string[];
  /** Tools que necesitan y hoy están inactivas. */
  tools: string[];
  /** Skills que necesitan y hoy están inactivas. */
  skills: string[];
  /** Miembros que no son del catálogo: traen sus propias tools, no se siembran. */
  nonCatalog: string[];
}

/**
 * Qué habría que encender para estos agentes, **sin encender nada**.
 *
 * Es el `planSeedFor` de un cambio concreto: devuelve el faltante contra lo que
 * ya está activo, no el conjunto entero. Una UI lo usa para mostrar "esto se va
 * a activar" antes de que el usuario confirme, que es la diferencia entre que
 * el usuario decida y que el sistema decida por él.
 */
export async function planActivationFor(agentIds: string[]): Promise<ActivationGap> {
  const catalogo = new Set<string>(CATALOG_AGENT_IDS);
  const delCatalogo = [...new Set(agentIds.filter((id) => catalogo.has(id)))];
  const nonCatalog = [...new Set(agentIds.filter((id) => !catalogo.has(id)))];

  const activos = await listEnabledCatalogAgents();
  const apagados = delCatalogo.filter((id) => !activos.includes(id));

  if (apagados.length === 0) {
    return { agents: [], tools: [], skills: [], nonCatalog };
  }

  // El faltante se calcula contra la unión final —los que ya estaban más los
  // nuevos—, no sólo contra los nuevos: una tool que ya está activa porque otro
  // agente la usa no es algo que "se vaya a activar", y listarla haría que la
  // UI le prometa al usuario cambios que no van a ocurrir.
  const plan = planSeedFor([...new Set([...activos, ...delCatalogo])]);

  const toolsCol = await col<ToolDoc>("tools");
  const tools: string[] = [];
  for (const nombre of plan.tools) {
    const entry = await toolsCol.get(nombre);
    if (!entry?.doc.active) tools.push(nombre);
  }

  const skillsCol = await col<SkillDoc>("skills");
  const activas = new Set<string>();
  for (const entry of await skillsCol.scan({})) {
    if (entry.doc.active) { activas.add(entry.doc.id); activas.add(entry.doc.name); }
  }
  const skills = plan.skills.filter((s) => !activas.has(s));

  return { agents: apagados, tools, skills, nonCatalog };
}

/**
 * Desactiva un agente del catálogo.
 *
 * Las tools que compartía con otros siguen activas — es la razón de recalcular
 * la unión en vez de quitar las suyas.
 */
export async function disableCatalogAgent(agentId: string): Promise<SeedPlan> {
  const activos = await listEnabledCatalogAgents();
  return applySeedPlan(activos.filter((id) => id !== agentId));
}

/** Los agentes de catálogo actualmente habilitados. */
export async function listEnabledCatalogAgents(): Promise<string[]> {
  const c = await col<AgentDoc>("agents");
  const ids: string[] = [];
  for (const id of CATALOG_AGENT_IDS) {
    const entry = await c.get(id);
    if (entry?.doc.enabled) ids.push(id);
  }
  return ids;
}
