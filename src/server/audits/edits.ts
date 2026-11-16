import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020";
import type { AuditProfile } from "@/server/policy/sections/audits";

/**
 * Edits a person makes to a finding before accepting it. Pure. Only the
 * extractor's `editable` fields can change, and each value must pass the
 * output schema's own definition of that property (for an array extractor,
 * the property of the array's items).
 */

type Json = Record<string, unknown>;
type Extractor = AuditProfile["findings"][number];

const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

function resolveRef(root: Json, node: unknown): unknown {
  if (!isObj(node) || typeof node.$ref !== "string") return node;
  const ref = node.$ref;
  if (!ref.startsWith("#/")) return node;
  let cur: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    cur = isObj(cur) ? cur[key] : undefined;
  }
  return cur ?? node;
}

/** The schema object of the items an extractor reads: the root for "$", else the array's `items`. */
export function itemSchemaOf(root: Json, extractor: Pick<Extractor, "from">): Json | null {
  if (extractor.from === "$") return root;
  const props = isObj(root.properties) ? root.properties : null;
  const arr = resolveRef(root, props?.[extractor.from]);
  const items = isObj(arr) ? resolveRef(root, arr.items) : null;
  return isObj(items) ? items : null;
}

/** Property definitions of `fields` in the item schema; a field the schema does not describe is left out. */
export function propertySchemas(root: Json, extractor: Pick<Extractor, "from">, fields: readonly string[]): Record<string, Json> {
  const item = itemSchemaOf(root, extractor);
  const props = item && isObj(item.properties) ? item.properties : {};
  const out: Record<string, Json> = {};
  for (const f of fields) {
    const p = resolveRef(root, props[f]);
    if (isObj(p)) out[f] = p;
  }
  return out;
}

let ajvInstance: Ajv2020 | undefined;
const ajv = () => (ajvInstance ??= new Ajv2020({ allErrors: true, strict: false }));
const cache = new Map<string, ValidateFunction>();

function validatorFor(prop: Json, defs: unknown): ValidateFunction {
  const schema = isObj(defs) ? { ...prop, $defs: defs } : prop;
  const key = JSON.stringify(schema);
  let fn = cache.get(key);
  if (!fn) {
    fn = ajv().compile(schema);
    if (cache.size > 200) cache.clear();
    cache.set(key, fn);
  }
  return fn;
}

function errorText(e: ErrorObject): string {
  const at = e.instancePath ? ` (at ${e.instancePath})` : "";
  if (e.keyword === "enum") return `must be one of: ${(e.params as { allowedValues: unknown[] }).allowedValues.map((v) => JSON.stringify(v)).join(", ")}${at}`;
  if (e.keyword === "maxLength") return `must be at most ${(e.params as { limit: number }).limit} characters${at}`;
  if (e.keyword === "minItems") return `needs at least ${(e.params as { limit: number }).limit} item(s)${at}`;
  if (e.keyword === "maxItems") return `takes at most ${(e.params as { limit: number }).limit} item(s)${at}`;
  return `${e.message ?? "is not valid"}${at}`;
}

export interface EditCheck {
  ok: boolean;
  errors: { field: string; message: string }[];
  /** The finding's values with the edits applied (only when ok) */
  values: Json | null;
  /** Fields whose value actually changed */
  changed: string[];
}

/** Check edits against the extractor and the output schema, and apply them to `current`. */
export function checkEdits(root: Json | null, extractor: Pick<Extractor, "from" | "editable" | "label">, current: Json, edits: Json): EditCheck {
  const errors: EditCheck["errors"] = [];
  const fields = Object.keys(edits);
  if (!fields.length) return { ok: false, errors: [{ field: "", message: "There is nothing to change." }], values: null, changed: [] };
  const props = root ? propertySchemas(root, extractor, extractor.editable) : {};
  for (const f of fields) {
    if (!extractor.editable.includes(f)) {
      errors.push({ field: f, message: `${f} can't be edited on a ${extractor.label.toLowerCase()} finding.` });
      continue;
    }
    const prop = props[f];
    if (!prop) {
      errors.push({ field: f, message: `The output schema does not describe ${f}, so the edit can't be checked.` });
      continue;
    }
    const validate = validatorFor(prop, root?.$defs);
    if (!validate(edits[f])) for (const e of validate.errors ?? []) errors.push({ field: f, message: `${f} ${errorText(e)}` });
  }
  if (errors.length) return { ok: false, errors, values: null, changed: [] };
  const values: Json = { ...current };
  const changed: string[] = [];
  for (const f of fields) {
    if (JSON.stringify(current[f]) !== JSON.stringify(edits[f])) changed.push(f);
    values[f] = structuredClone(edits[f]);
  }
  return { ok: true, errors: [], values, changed };
}

/** Enum values of a property (or of its array items), for filters and edit forms; null when it is free text. */
export function enumOf(prop: Json | undefined, root?: Json): unknown[] | null {
  if (!prop) return null;
  if (Array.isArray(prop.enum)) return prop.enum;
  const items = root ? resolveRef(root, prop.items) : prop.items;
  if (isObj(items) && Array.isArray(items.enum)) return items.enum;
  return null;
}
