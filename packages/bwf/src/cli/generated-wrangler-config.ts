import { readFileSync } from 'node:fs';
import { parse } from 'jsonc-parser';
import type { ParseError } from 'jsonc-parser';
import { isJsonObject } from './json-value.ts';
import type { JsonObject } from './json-value.ts';

/** Parse JSON/JSONC text with an optional BOM; undefined unless it is one valid object. */
export function parseJsoncObject(text: string): JsonObject | undefined {
  const errors: Array<ParseError> = [];
  const parsed: unknown = parse(text.replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isJsonObject(parsed)) {
    return undefined;
  }
  return parsed;
}

/** Parse a generated Wrangler JSON/JSONC config without accepting a partial parse. */
export function readGeneratedWranglerConfigFile(path: string): JsonObject {
  const parsed = parseJsoncObject(readFileSync(path, 'utf8'));
  if (!parsed) {
    throw new Error('Invalid Wrangler JSON/JSONC config.');
  }
  return parsed;
}
