import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020";
import { jsonPointerToDotted } from "@/server/validation/schemas";

/**
 * Validation of review output against the profile's JSON Schema (draft
 * 2020-12). The model call itself does not validate, so a near miss still
 * comes back as output with every schema error listed.
 */

let ajvInstance: Ajv2020 | undefined;
const cache = new Map<string, ValidateFunction>();

function ajv(): Ajv2020 {
  ajvInstance ??= new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictTuples: false, strictRequired: false });
  return ajvInstance;
}

/**
 * Compiled validator, cached by schema text. `$id` is dropped before compiling:
 * two policy layers may ship different schemas under the same `$id`, and one
 * Ajv instance accepts each `$id` only once. Throws when the schema is invalid.
 */
export function compileOutputSchema(schema: Record<string, unknown>): ValidateFunction {
  const key = JSON.stringify(schema);
  let fn = cache.get(key);
  if (!fn) {
    const { $id: _id, ...rest } = schema;
    fn = ajv().compile(rest);
    if (cache.size > 50) cache.clear();
    cache.set(key, fn);
  }
  return fn;
}

const MAX_ERRORS = 100;

function describe(e: ErrorObject): string {
  const path = jsonPointerToDotted(e.instancePath);
  const at = path || "(root)";
  const p = e.params as Record<string, unknown>;
  switch (e.keyword) {
    case "required":
      return `${path ? `${path}.` : ""}${String(p.missingProperty)} is required`;
    case "additionalProperties":
      return `${at} has a property the schema does not allow: ${String(p.additionalProperty)}`;
    case "enum":
      return `${at} must be one of: ${((p.allowedValues as unknown[]) ?? []).map(String).join(", ")}`;
    default:
      return `${at} ${e.message ?? "is not valid"}`;
  }
}

/** Every schema error as a readable line; empty when the value is valid. */
export function validateOutput(schema: Record<string, unknown>, value: unknown): string[] {
  const fn = compileOutputSchema(schema);
  if (fn(value)) return [];
  const lines = [...new Set((fn.errors ?? []).map(describe))];
  if (lines.length > MAX_ERRORS) return [...lines.slice(0, MAX_ERRORS), `and ${lines.length - MAX_ERRORS} more errors`];
  return lines;
}
