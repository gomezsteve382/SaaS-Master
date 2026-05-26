/**
 * SRT Lab Swarm — barrel export
 */
export { SPECIALIST_AGENTS, ALL_AGENTS, VENOM_SYSTEM_PROMPT, getAgentById } from "./agents.js";
export type { SwarmAgent } from "./agents.js";
export { runSwarm } from "./coordinator.js";
export type { SwarmEvent } from "./coordinator.js";
export { registerAgentMCPRoutes } from "./mcp-agents.js";
