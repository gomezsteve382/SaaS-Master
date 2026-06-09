import { z } from "zod";
import { notifyOwner } from "./notification";
import { invokeLLM } from "./llm";
import { adminProcedure, publicProcedure, router } from "./trpc";

export const systemRouter = router({
  health: publicProcedure
    .input(
      z.object({
        timestamp: z.number().min(0, "timestamp cannot be negative"),
      })
    )
    .query(() => ({
      ok: true,
    })),

  analyzeKeyPhoto: publicProcedure
    .input(
      z.object({
        imageBase64: z.string(),
        prompt: z.string().max(2000),
      })
    )
    .mutation(async ({ input }) => {
      const response = await invokeLLM({
        messages: [
          {
            role: "system",
            content: `You are an expert automotive key programmer assistant. You extract transponder key data from programmer screenshots (Autel IM608, Xhorse, etc). You MUST return ONLY the hex values in the exact format requested. Do not add explanations or extra text. If you cannot read a value clearly, return UNKNOWN for that field.`,
          },
          {
            role: "user",
            content: [
              {
                type: "image_url" as const,
                image_url: {
                  url: input.imageBase64,
                  detail: "high" as const,
                },
              },
              {
                type: "text" as const,
                text: input.prompt,
              },
            ],
          },
        ],
      });
      const content = response?.choices?.[0]?.message?.content || "";
      return content;
    }),
  notifyOwner: adminProcedure
    .input(
      z.object({
        title: z.string().min(1, "title is required"),
        content: z.string().min(1, "content is required"),
      })
    )
    .mutation(async ({ input }) => {
      const delivered = await notifyOwner(input);
      return {
        success: delivered,
      } as const;
    }),
});
