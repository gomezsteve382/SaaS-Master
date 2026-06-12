import { DatabaseAdapter } from "./databaseAdapter.js";
import { JsonDatabaseAdapter } from "./jsonDatabaseAdapter.js";
import { MemoryDatabaseAdapter } from "./memoryDatabaseAdapter.js";

export function createDatabaseAdapter(): DatabaseAdapter {
  const driver = (process.env.GOATMEZ_DB_DRIVER || "json").toLowerCase();
  if (driver === "json") return new JsonDatabaseAdapter(process.env.GOATMEZ_DB_PATH || ".goatmez/database.json");
  if (driver === "memory") return new MemoryDatabaseAdapter();
  throw new Error(`Unsupported GOATMEZ_DB_DRIVER '${driver}'. Supported drivers: json, memory.`);
}
