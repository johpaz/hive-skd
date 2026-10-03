import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as process from "node:process";

const HIVE_CONFIG = `{
  "name": "my-hive-agent",
  "version": "0.1.0",
  "type": "module",
  "dependencies": {
    "@johpaz/hive-sdk": "latest"
  }
}
`;

const HIVE_AGENT_TS = `import { createAgent, defineTool } from "@johpaz/hive-sdk";

const myTool = defineTool({
  name: "hello",
  description: "Say hello",
  execute: async (args: { name?: string }) => {
    return { greeting: \`Hello, \${args.name ?? "world"}!\` };
  },
});

const agent = await createAgent({
  name: "my-agent",
  model: "gpt-5.6-luna",
  provider: "openai",
  tools: [myTool],
});

console.log("Agent ready:", agent.name);
`;

async function runInit() {
	const targetDir = process.argv[3] || process.cwd();

	if (existsSync(join(targetDir, "hive.json"))) {
		console.error("A hive project already exists in this directory.");
		process.exit(1);
	}

	writeFileSync(join(targetDir, "hive.json"), HIVE_CONFIG.trim());
	writeFileSync(join(targetDir, "hive.agent.ts"), HIVE_AGENT_TS.trim());

	console.log(`\nInitialized Hive project in ${targetDir}`);
	console.log("\nFiles created:");
	console.log("  hive.json       - Project configuration");
	console.log("  hive.agent.ts   - Agent definition");
	console.log("\nNext steps:");
	console.log("  Run: hive run");
}

runInit();
