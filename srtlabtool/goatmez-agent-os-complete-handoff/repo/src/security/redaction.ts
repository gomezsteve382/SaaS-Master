const SECRET_KEY_PATTERN = /(api[_-]?key|token|secret|password|credential|bearer|authorization|private[_-]?key)/i;

export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "****";
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
}

export function isSensitiveKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return value.length > 12 ? maskSecret(value) : "****";
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") return redactObject(value as Record<string, unknown>);
  return value;
}

export function redactObject<T extends Record<string, unknown>>(input: T): T {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    output[key] = isSensitiveKey(key) ? redactValue(value) : redactAny(value);
  }
  return output as T;
}

export function redactAny<T>(input: T): T {
  if (Array.isArray(input)) return input.map((item) => redactAny(item)) as T;
  if (input && typeof input === "object") return redactObject(input as Record<string, unknown>) as T;
  return input;
}
