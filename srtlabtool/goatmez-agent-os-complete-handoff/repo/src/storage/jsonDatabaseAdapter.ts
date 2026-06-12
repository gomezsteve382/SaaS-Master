import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseAdapter, GoatmezDatabaseShape, emptyDatabase, normalizeDatabase } from "./databaseAdapter.js";

export class JsonDatabaseAdapter implements DatabaseAdapter {
  readonly name = "json";

  constructor(private readonly path = ".goatmez/database.json") {}

  private target(): string {
    return join(process.cwd(), this.path);
  }

  read(): GoatmezDatabaseShape {
    try {
      const raw = readFileSync(this.target(), "utf8");
      return normalizeDatabase(JSON.parse(raw) as Partial<GoatmezDatabaseShape>);
    } catch (error: any) {
      if (error?.code === "ENOENT") return emptyDatabase();
      throw error;
    }
  }

  write(next: GoatmezDatabaseShape): void {
    const target = this.target();
    mkdirSync(dirname(target), { recursive: true });
    const clean: GoatmezDatabaseShape = { ...normalizeDatabase(next), version: 4, updatedAt: new Date().toISOString() };
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(clean, null, 2) + "\n", "utf8");
    renameSync(tmp, target);
  }
}
