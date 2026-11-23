export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | ReadonlyArray<JsonValue> | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isJsonArray(value: unknown): value is ReadonlyArray<JsonValue> {
  return Array.isArray(value);
}
