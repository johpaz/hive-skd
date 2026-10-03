import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as process from "node:process";

async function runAddTool() {
  const toolName = process.argv[3];

  if (!toolName) {
    console.error("Usage: hive add-tool <name>");
    process.exit(1);
  }

  const toolsDir = join(process.cwd(), "src", "tools");
  const filePath = join(toolsDir, `${toolName}.ts`);

  if (existsSync(filePath)) {
    console.error(`Tool '${toolName}' already exists.`);
    process.exit(1);
  }

  mkdirSync(toolsDir, { recursive: true });

  const content = `import { defineTool } from "@johpaz/hive-sdk";

export const ${toolName} = defineTool({
  name: "${toolName}",
  description: "Description of what ${toolName} does.",
  // Los argumentos en JSON Schema: es lo que ve el modelo y con lo que se valida la llamada.
  parameters: {
    type: "object",
    properties: {
      input: { type: "string", description: "What the tool receives." },
    },
    required: ["input"],
  },
  execute: async (args: { input: string }) => {
    // TODO: implement tool logic
    return { result: args.input };
  },
});
`;

  writeFileSync(filePath, content);
  console.log(`✅ Created tool: ${filePath}`);
}

runAddTool();
