/**
 * AlfaOBD extraction output schema.
 *
 * Single source of truth for the JSON shape every consumer (the
 * extractor, the schema-validation test, and the SRT Lab "AlfaOBD
 * Tables" tab) relies on. Keep this stable — changing it is a breaking
 * contract change for downstream features.
 *
 * The validator below is intentionally tiny (no `ajv` dependency) so
 * the extractor stays self-contained.
 */

export const SCHEMA_VERSION = 1;

/* ── Top-level layout written by the extractor ─────────────────────── */
export const OUTPUT_LAYOUT = {
  manifest:     "manifest.json",
  ecutypesDir:  "ecutypes",       // one <family>.json per ECUTYPE_* family
  handlers:     "handlers.json",
  transports:   "transports.json",
  resources:    "resources.json",
  mediaDir:     "media",          // carved PNG/GIF/JPEG, original logical names
};

/* ── Schemas (declarative; consumed by validate() below) ───────────── */
export const SCHEMAS = {
  manifest: {
    required: [
      "schema_version", "tool", "generated_at", "alfaobd",
      "shfolder", "inputs", "outputs",
    ],
    fields: {
      schema_version: { type: "number", const: SCHEMA_VERSION },
      tool: {
        type: "object",
        required: ["name", "version", "decompiler"],
        fields: {
          name:       { type: "string" },
          version:    { type: "string" },
          decompiler: {
            type: "object",
            required: ["name", "version_command"],
            fields: {
              name:                 { type: "string" },
              version_command:      { type: "string" },
              version_output:       { type: "string",  optional: true },
              /* Resolved version parsed from the decompiler's --version
               * output (e.g. "9.0.0.7833"). The string the pipeline pinned
               * against. Whether the pin was actually enforced for this run
               * (false when the user passed --allow-decompiler-version-mismatch
               * or used a custom decompiler with no explicit pin). Together
               * these three fields are what makes the pin auditable. */
              version_resolved:     { type: "string",  optional: true },
              version_pinned:       { type: "string",  optional: true },
              version_pin_enforced: { type: "boolean", optional: true },
            },
          },
        },
      },
      generated_at: { type: "string" },          // ISO-8601 UTC
      alfaobd: {
        type: "object",
        required: ["sha256", "size_bytes", "file_version", "is_dotnet", "clr_version"],
        fields: {
          sha256:        { type: "string" },
          size_bytes:    { type: "number" },
          file_version:  { type: "string" },     // e.g. "2.5.7.0"
          assembly_name: { type: "string", optional: true },
          is_dotnet:     { type: "boolean" },
          clr_version:   { type: "string" },     // e.g. "v4.0.30319"
          pe_machine:    { type: "string", optional: true },
          pe_timestamp:  { type: "string", optional: true },
        },
      },
      shfolder: {
        type: "object",
        required: ["sha256", "size_bytes", "protected_skip", "protector"],
        fields: {
          sha256:         { type: "string" },
          size_bytes:     { type: "number" },
          protected_skip: { type: "boolean", const: true },
          protector:      { type: "string" },     // "Safengine Shielden v2.3.9.0"
          exports:        { type: "array_of_strings" },
          imports:        { type: "array_of_strings" },
          sections:       {
            type: "array_of_objects",
            optional: true,
            fields: {
              name:    { type: "string" },
              entropy: { type: "number" },
            },
          },
        },
      },
      inputs: {
        type: "object",
        required: ["alfaobd_path", "shfolder_path"],
        fields: {
          alfaobd_path:  { type: "string" },
          shfolder_path: { type: "string" },
        },
      },
      outputs: {
        type: "object",
        required: ["files"],
        fields: {
          files: {
            type: "array_of_objects",
            fields: {
              path:   { type: "string" },
              sha256: { type: "string" },
              bytes:  { type: "number" },
            },
          },
        },
      },
      counts: {
        type: "object",
        optional: true,
        fields: {
          ecutype_families: { type: "number" },
          ecutype_modules:  { type: "number" },
          handlers:         { type: "number" },
          transports:       { type: "number" },
          resources:        { type: "number" },
          media_files:      { type: "number" },
        },
      },
    },
  },

  ecutypeFamily: {
    required: ["schema_version", "family", "modules"],
    fields: {
      schema_version: { type: "number", const: SCHEMA_VERSION },
      family:         { type: "string" },        // e.g. "ECUTYPE_KWP2000"
      source_type:    { type: "string", optional: true },
      modules: {
        type: "array_of_objects",
        fields: {
          ecu_type_id:   { type: "string" },     // e.g. "0x132"
          name:          { type: "string" },     // identifier in code
          display_name:  { type: "string", optional: true },
          protocols:     { type: "array_of_strings", optional: true },
          tx_address:    { type: "string", optional: true },  // canonical "0x7E0"
          rx_address:    { type: "string", optional: true },
          source:        { type: "string", optional: true },  // file:line
        },
      },
    },
  },

  handlers: {
    required: ["schema_version", "handlers"],
    fields: {
      schema_version: { type: "number", const: SCHEMA_VERSION },
      handlers: {
        type: "array_of_objects",
        fields: {
          name:           { type: "string" },     // e.g. "ProcessECUData"
          declaring_type: { type: "string", optional: true },
          source:         { type: "string", optional: true },
          calls:          { type: "array_of_strings", optional: true },
          uds_services:   { type: "array_of_strings", optional: true },
        },
      },
    },
  },

  transports: {
    required: ["schema_version", "transports"],
    fields: {
      schema_version: { type: "number", const: SCHEMA_VERSION },
      transports: {
        type: "array_of_objects",
        fields: {
          kind:    { type: "string" },           // "j2534"|"sae_j2534"|"j2534_sharp"|"serial"|"stn_ftdi"|"bluetooth"|"socket"
          types:   { type: "array_of_strings" }, // managed type names that touch this transport
          version: { type: "string", optional: true },
        },
      },
    },
  },

  resources: {
    required: ["schema_version", "bundles", "media"],
    fields: {
      schema_version: { type: "number", const: SCHEMA_VERSION },
      bundles: {
        type: "array_of_objects",
        fields: {
          name:        { type: "string" },       // e.g. "AlfaOBD_PC.Properties.Resources.resources"
          entry_count: { type: "number", optional: true },
        },
      },
      media: {
        type: "array_of_objects",
        fields: {
          name:       { type: "string" },        // logical resource name
          file:       { type: "string" },        // relative path under media/
          mime:       { type: "string" },        // image/png|image/gif|image/jpeg
          size_bytes: { type: "number" },
          sha256:     { type: "string" },
        },
      },
    },
  },
};

/* ── Validator ─────────────────────────────────────────────────────── */
export function validate(kind, value, path = "$") {
  const schema = SCHEMAS[kind];
  if (!schema) return [`${path}: unknown schema kind '${kind}'`];
  return validateNode(schema, value, path);
}

function validateNode(schema, value, path) {
  const errors = [];
  if (value === undefined || value === null) {
    errors.push(`${path}: missing value`);
    return errors;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${path}: expected object, got ${Array.isArray(value) ? "array" : typeof value}`);
    return errors;
  }
  for (const key of schema.required || []) {
    if (!(key in value)) errors.push(`${path}.${key}: missing required field`);
  }
  for (const [key, spec] of Object.entries(schema.fields || {})) {
    if (!(key in value)) {
      if (!spec.optional && !(schema.required || []).includes(key)) {
        // not required, not optional -> treat as optional
        continue;
      }
      continue;
    }
    errors.push(...checkField(spec, value[key], `${path}.${key}`));
  }
  return errors;
}

function checkField(spec, value, path) {
  const errors = [];
  switch (spec.type) {
    case "string":
      if (typeof value !== "string") errors.push(`${path}: expected string`);
      else if (spec.const !== undefined && value !== spec.const)
        errors.push(`${path}: expected '${spec.const}', got '${value}'`);
      break;
    case "number":
      if (typeof value !== "number" || Number.isNaN(value))
        errors.push(`${path}: expected number`);
      else if (spec.const !== undefined && value !== spec.const)
        errors.push(`${path}: expected ${spec.const}, got ${value}`);
      break;
    case "boolean":
      if (typeof value !== "boolean") errors.push(`${path}: expected boolean`);
      else if (spec.const !== undefined && value !== spec.const)
        errors.push(`${path}: expected ${spec.const}, got ${value}`);
      break;
    case "array_of_strings":
      if (!Array.isArray(value)) { errors.push(`${path}: expected array`); break; }
      value.forEach((v, i) => {
        if (typeof v !== "string")
          errors.push(`${path}[${i}]: expected string, got ${typeof v}`);
      });
      break;
    case "array_of_objects":
      if (!Array.isArray(value)) { errors.push(`${path}: expected array`); break; }
      value.forEach((v, i) => {
        errors.push(...validateNode(spec, v, `${path}[${i}]`));
      });
      break;
    case "object":
      errors.push(...validateNode(spec, value, path));
      break;
    default:
      errors.push(`${path}: schema bug — unknown spec type '${spec.type}'`);
  }
  return errors;
}
