import type { Config } from "../config/loader"
import type { Tool } from "../tools/types"
import * as filesystem from "../tools/filesystem/index"
import { webSearchTool } from "../tools/web/web-search"
import { webFetchTool } from "../tools/web/web-fetch"
import * as cli from "../tools/cli/index"
import * as office from "../tools/office/index"
import * as api from "../tools/api/index"

/**
 * Reconstruct only stateless tools inside worker realms.
 *
 * Importing the complete tool registry pulls process-local services (including
 * HiveDB) into tool-worker.js even though those tools are always executed by
 * RPC on the main thread. Keeping this registry explicit makes the worker
 * bundle platform-neutral and prevents native bindings from leaking into it.
 */
export function createWorkerTools(_config: Config): Tool[] {
  return [
    ...filesystem.createTools(),
    webSearchTool,
    webFetchTool,
    ...cli.createTools(),
    ...office.createTools(),
    ...api.createTools(),
  ]
}
