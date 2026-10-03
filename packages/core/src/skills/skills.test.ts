/**
 * El catálogo de skills bundled se genera desde los SKILL.md de `skills/bundled/`
 * con `bun run skills:bundle`. Hasta 0.1.5 el SDK traía 44 skills copiadas a
 * mano, 21 de las cuales invocaban tools que ya no existen (`voice_*`,
 * `meeting_transcription`, `canvas_*`, `code_*`, `project_*`): el selector se
 * las podía ofrecer al modelo y la ejecución moría sin ejecutor.
 */

import { describe, it, expect } from "bun:test";
import { BUNDLED_SKILLS_DATA } from "./bundled-data.generated";
import { createAllTools } from "../tools/index";
import { loadConfig } from "../config/loader";

describe("Bundled skills", () => {
  it("incluye las skills web y de browser", () => {
    const names = BUNDLED_SKILLS_DATA.map((s) => s.name);
    expect(names).toContain("web_research");
    expect(names).toContain("browser_scrape");
    expect(names).toContain("browser_automate");
  });

  it("no arrastra las skills retiradas", () => {
    const names = BUNDLED_SKILLS_DATA.map((s) => s.name);
    for (const retired of [
      "web_browser_research",
      "voice_input",
      "voice_output",
      "voice_assistant",
      "meeting_transcription",
      "canvas_report",
      "canvas_dashboard",
      "code_review",
      "code_generate",
      "project_planner",
      "busqueda_fts5",
      "ai_coder",
      "data_analyst",
    ]) {
      expect(names, `la skill retirada "${retired}" volvió al bundle`).not.toContain(retired);
    }
  });

  it("cada skill declara sólo tools que existen en el registry", async () => {
    const available = new Set(createAllTools(await loadConfig()).map((t) => t.name));

    const dangling = BUNDLED_SKILLS_DATA.flatMap((skill) =>
      (skill.tools ?? [])
        .filter((tool) => !available.has(tool))
        .map((tool) => `${skill.name} → ${tool}`)
    );

    expect(dangling, `skills apuntando a tools inexistentes:\n${dangling.join("\n")}`).toEqual([]);
  });

  it("toda skill tiene nombre, descripción y categoría", () => {
    for (const skill of BUNDLED_SKILLS_DATA) {
      expect(skill.name, "skill sin nombre").toBeTruthy();
      expect(skill.description, `${skill.name} sin descripción`).toBeTruthy();
      expect(skill.category, `${skill.name} sin categoría`).toBeTruthy();
    }
  });
});
