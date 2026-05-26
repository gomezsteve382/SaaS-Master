/**
 * env.ts — Typed environment variable accessors for server-side code.
 * All values are read from process.env at runtime.
 */
export const ENV = {
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL || "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY || "",
  jwtSecret: process.env.JWT_SECRET || "",
  oauthServerUrl: process.env.OAUTH_SERVER_URL || "",
  databaseUrl: process.env.DATABASE_URL || "",
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT) || 3001,
};
