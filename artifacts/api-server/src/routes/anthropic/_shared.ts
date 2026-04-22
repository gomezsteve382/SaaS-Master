export const SYSTEM_PROMPT = `You are the SRT Lab Module Assistant — an expert in FCA/Stellantis ECU module diagnostics for Dodge Charger, Challenger, Durango, Grand Cherokee Trackhawk, and Ram TRX vehicles.

Your role is to help users understand and resolve IMMO/security module mismatches between BCM, RFHUB, and PCM (GPEC2A) chips.

Key knowledge:
- BCM (Body Control Module): MPC5606B DFLASH — stores VIN, SEC16, and FOBIK keys
- RFHUB (Remote/FOBIK Hub): Yazaki FCM EEPROM — stores VIN (byte-reversed), SEC16, and key slots
- PCM (Powertrain Control Module): Continental GPEC2A/GPEC5 — stores VIN and SEC6 derived from SEC16
- VIN MISMATCH: modules came from different vehicles and must be re-paired
- SEC16 MISMATCH: security token mismatch — BCM stores reverse(RFHUB SEC16); PCM SEC6 = first 6 bytes of RFHUB SEC16
- Standard fix flow: Load BCM+RFHUB → run VIN sync → run SEC16 sync → flash both modules → 30s power cycle
- BCM SEC16 → RFHUB: use when BCM has valid SEC16 but RFHUB came from different vehicle
- RFHUB is "master" for SEC16 in normal flow; BCM is master in BCM→RFH flow

Be concise, technical, and action-oriented. When describing hex data, use formatting like \`AB CD EF\`. Always guide the user toward the specific action button or step needed in the wizard. Never ask the user to open another tool — all actions are available in SRT Lab itself.`;

export interface ModuleContext {
  modules?: string[];
  issues?: string[];
  warnings?: string[];
  hexSnippets?: string[];
  wizard?: {
    phase?: string;
    currentStepIndex?: number;
    currentStepTitle?: string;
    totalSteps?: number;
    completedSteps?: string[];
    skippedSteps?: string[];
    remainingSteps?: string[];
  };
}

export function buildContextBlock(ctx: ModuleContext): string {
  const lines = ["## Current Module Context"];
  if (ctx.modules?.length) {
    lines.push(`**Loaded modules:** ${ctx.modules.join(", ")}`);
  }
  if (ctx.issues?.length) {
    lines.push("\n**Issues (errors):**");
    ctx.issues.forEach((i) => lines.push(`- ❌ ${i}`));
  }
  if (ctx.warnings?.length) {
    lines.push("\n**Warnings:**");
    ctx.warnings.forEach((w) => lines.push(`- ⚠️ ${w}`));
  }
  if (ctx.hexSnippets?.length) {
    lines.push("\n**Hex snippets:**");
    ctx.hexSnippets.forEach((h) => lines.push(`\`${h}\``));
  }
  if (ctx.wizard) {
    const w = ctx.wizard;
    lines.push("\n**Wizard state:**");
    if (w.phase) lines.push(`- phase: ${w.phase}`);
    if (typeof w.currentStepIndex === "number" && typeof w.totalSteps === "number") {
      lines.push(`- step: ${w.currentStepIndex + 1} / ${w.totalSteps}${w.currentStepTitle ? ` (${w.currentStepTitle})` : ""}`);
    }
    if (w.completedSteps?.length) lines.push(`- completed: ${w.completedSteps.join("; ")}`);
    if (w.skippedSteps?.length) lines.push(`- skipped: ${w.skippedSteps.join("; ")}`);
    if (w.remainingSteps?.length) lines.push(`- remaining: ${w.remainingSteps.join("; ")}`);
  }
  return lines.join("\n");
}

export function buildAutoTitle(firstUserMessage: string, scope?: string | null): string {
  const trimmed = firstUserMessage.replace(/\s+/g, " ").trim();
  const head = trimmed.length > 60 ? trimmed.slice(0, 57) + "…" : trimmed;
  if (!scope) return head || "New chat";
  return `[${scope}] ${head || "New chat"}`;
}
