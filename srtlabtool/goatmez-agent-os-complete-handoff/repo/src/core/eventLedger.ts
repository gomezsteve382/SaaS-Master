import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AgentEvent } from "./types.js";
import { makeId } from "./id.js";

export class EventLedger {
  constructor(private readonly logPath: string = ".goatmez/events.jsonl") {}

  async record(event: Omit<AgentEvent, "id" | "timestamp">): Promise<AgentEvent> {
    const fullEvent: AgentEvent = {
      id: makeId("evt"),
      timestamp: new Date().toISOString(),
      ...event
    };
    const target = join(process.cwd(), this.logPath);
    await mkdir(dirname(target), { recursive: true });
    await appendFile(target, JSON.stringify(fullEvent) + "\n", "utf8");
    return fullEvent;
  }
}
