import { existsSync, } from "node:fs";
import { join } from "node:path";
import * as process from "node:process";
import { copyTemplate } from "./create-app-utils";

async function runCreateApp() {
  const appName = process.argv[3];

  if (!appName) {
    console.error("Usage: hive create-app <name>");
    process.exit(1);
  }

  const targetDir = join(process.cwd(), appName);

  if (existsSync(targetDir)) {
    console.error(`Directory '${appName}' already exists.`);
    process.exit(1);
  }

  console.log(`Creating Hive app '${appName}'...`);

  copyTemplate(targetDir, {
    "{{APP_NAME}}": appName,
  });

  console.log(`\n✅ Created ${appName} in ${targetDir}`);
  console.log("\nNext steps:");
  console.log(`  cd ${appName}`);
  console.log("  bun install");
  console.log("  cp .env.example .env");
  console.log("  bun run dev");
}

runCreateApp();
