import { DatabaseAdapter, GoatmezDatabaseShape, emptyDatabase, normalizeDatabase } from "./databaseAdapter.js";

export class MemoryDatabaseAdapter implements DatabaseAdapter {
  readonly name = "memory";
  private db: GoatmezDatabaseShape = emptyDatabase();

  read(): GoatmezDatabaseShape {
    return normalizeDatabase(JSON.parse(JSON.stringify(this.db)) as GoatmezDatabaseShape);
  }

  write(next: GoatmezDatabaseShape): void {
    this.db = normalizeDatabase(JSON.parse(JSON.stringify(next)) as GoatmezDatabaseShape);
  }
}
