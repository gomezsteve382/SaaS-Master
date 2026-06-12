import { MemoryRecord } from "./types.js";
import { makeId } from "./id.js";
import { LocalDatabase } from "./localDatabase.js";

export class MemoryStore {
  private readonly records: MemoryRecord[] = [];

  constructor(private readonly db?: LocalDatabase) {
    if (db) this.records.push(...db.listMemories());
  }

  add(scope: string, content: string, importance = 1): MemoryRecord {
    const existing = this.records.find((record) => record.scope === scope && record.content === content);
    if (existing) return existing;

    const record: MemoryRecord = {
      id: makeId("mem"),
      scope,
      content,
      importance,
      createdAt: new Date().toISOString()
    };
    this.records.unshift(record);
    this.db?.upsertMemory(record);
    return record;
  }

  list(): MemoryRecord[] {
    const records = this.db ? this.db.listMemories() : this.records;
    return [...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  search(scopes: string[], query: string, limit = 6): MemoryRecord[] {
    const source = this.db ? this.db.listMemories() : this.records;
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return source
      .filter((record) => scopes.includes(record.scope))
      .map((record) => {
        const text = record.content.toLowerCase();
        const score = terms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0) + record.importance;
        return { record, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => item.record);
  }
}
