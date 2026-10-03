import { existsSync, } from "node:fs";
import { join } from "node:path";

async function runCommand() {
	const agentFile = findAgentFile();
	if (!agentFile) {
		console.error("No hive.agent.ts or hive.agent.js found in current directory.");
		console.error("Run 'hive init' to create one.");
		process.exit(1);
	}

	console.log(`Running agent from ${agentFile}...`);
	const agentModule = await import(agentFile);

	if (agentModule.agent) {
		const input = process.argv[3] || process.env.HIVE_INPUT || "Hello!";
		console.log(`\n--- Agent: ${agentModule.agent.name} ---`);
		console.log(`Input: ${input}\n`);

		for await (const event of agentModule.agent.chat(input)) {
			if (event.type === "text") {
				process.stdout.write(event.content);
			} else if (event.type === "tool_call") {
				console.log(`\n[Tool: ${event.name}]`);
			}
		}
		console.log("\n--- Done ---");
	} else {
		console.error("Agent module does not export an 'agent' instance.");
		process.exit(1);
	}
}

function findAgentFile(): string | null {
	const candidates = ["hive.agent.ts", "hive.agent.js", "agent.ts", "agent.js"];
	const cwd = process.cwd();
	for (const name of candidates) {
		const full = join(cwd, name);
		if (existsSync(full)) return full;
	}
	return null;
}

runCommand();
