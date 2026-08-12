import { ensureSchema } from "./db.js";
import { runIndexer } from "./runIndexer.js";
import { startServer } from "./server.js";

/**
 * Single process: the read API comes up first so it can answer while the chain
 * workers are still connecting, then the indexers start.
 */
async function main() {
  await ensureSchema();
  startServer();
  await runIndexer();
}

main().catch((error: unknown) => {
  console.error("[indexer] fatal", error);
  process.exit(1);
});
