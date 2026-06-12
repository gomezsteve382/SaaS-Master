// Runtime Zod schemas (`zod.object` constants) for the OpenAPI spec.
// Generated TS types live at `@workspace/api-zod/types` (subpath).
// Avoids TS2308 collisions on `*Body` identifiers that appear in
// both modules.
export * from "./generated/api";
// NOTE: `./generated/types` is intentionally NOT re-exported here — its
// orval-generated `*Body`/`*Response` type aliases collide (TS2308) with the
// Zod schema constants above. Consume those types via the `@workspace/api-zod/types`
// subpath instead (see `exports` in package.json).
