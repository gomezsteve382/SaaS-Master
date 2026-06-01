import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

import { conversations } from "./conversations";

export const conversationToolCalls = pgTable("conversation_tool_calls", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  messageId: integer("message_id"),
  toolName: text("tool_name").notNull(),
  module: text("module").notNull().default(""),
  toolArgs: text("tool_args").notNull().default("{}"),
  resultPreview: text("result_preview").notNull().default(""),
  bytesReturned: integer("bytes_returned").notNull().default(0),
  durationMs: integer("duration_ms").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const insertConversationToolCallSchema = createInsertSchema(conversationToolCalls).omit({
  id: true,
  createdAt: true,
});

export type ConversationToolCall = typeof conversationToolCalls.$inferSelect;
export type InsertConversationToolCall = z.infer<typeof insertConversationToolCallSchema>;
