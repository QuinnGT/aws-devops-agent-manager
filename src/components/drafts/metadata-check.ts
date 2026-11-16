import { Ajv2020, type ValidateFunction } from "ajv/dist/2020";
import { ANNOTATION_KEYWORDS, describeSchemaErrors, type JsonSchema } from "@/server/validation/schemas";
import type { ValidationResult } from "@/server/validation/types";

/**
 * The draft editor's in-browser metadata check (draft-editor.md, "When it
 * runs"): the same Ajv options and messages as the server's
 * validateDraftAsset, so a result reads the same before and after save.
 * Unit-tested.
 */

let ajv: Ajv2020 | undefined;
const cache = new Map<string, ValidateFunction>();

function compile(schema: JsonSchema): ValidateFunction {
  const key = JSON.stringify(schema);
  let fn = cache.get(key);
  if (!fn) {
    if (!ajv) {
      ajv = new Ajv2020({ allErrors: true, verbose: true, strict: true, strictTypes: false, strictTuples: false });
      for (const keyword of ANNOTATION_KEYWORDS) ajv.addKeyword({ keyword, schemaType: "string" });
    }
    fn = ajv.compile(schema);
    cache.set(key, fn);
  }
  return fn;
}

/** Codes of the server results this check replaces while the user edits. */
export const METADATA_CODES = ["metadata.schema", "metadata.recommendation"] as const;

function run(schema: JsonSchema | null, metadata: Record<string, unknown>, level: "error" | "warning", code: string): ValidationResult[] {
  if (!schema) return [];
  const validate = compile(schema);
  if (validate(metadata)) return [];
  return describeSchemaErrors(validate.errors, schema).map((i) => {
    const path = i.path ? `metadata.${i.path}` : "metadata";
    const message = i.message.startsWith(i.path) && i.path ? `metadata.${i.message}` : i.message;
    return { level, code, message, path };
  });
}

export function checkMetadata(schemas: { error: JsonSchema | null; warning: JsonSchema | null }, metadata: Record<string, unknown>): ValidationResult[] {
  return [...run(schemas.error, metadata, "error", METADATA_CODES[0]), ...run(schemas.warning, metadata, "warning", METADATA_CODES[1])];
}

/** Server results from the last save, with their metadata checks replaced by the live ones. */
export function mergeValidation(saved: readonly ValidationResult[], live: readonly ValidationResult[]): ValidationResult[] {
  return [...saved.filter((r) => !(METADATA_CODES as readonly string[]).includes(r.code)), ...live];
}
