/**
 * The draft editor's Details form, generated from the asset type's metadata
 * JSON Schema (draft-editor.md, "Details card"), so a new asset type needs a
 * schema entry, not new code. Pure; unit-tested.
 */

type Schema = Record<string, unknown>;

export interface ReferenceOption {
  assetId: string;
  name: string;
}

export interface ReferenceRule {
  key: string;
  ref: string;
  assetType: string;
  many: boolean;
  required: boolean;
  options: ReferenceOption[];
}

export type FieldSpec =
  | { kind: "status"; key: string; label: string; hint: string | null }
  | { kind: "agent-types"; key: string; label: string; hint: string | null; options: { id: string; label: string }[] }
  | { kind: "description"; key: string; label: string; hint: string | null; max: number }
  | { kind: "text"; key: string; label: string; hint: string | null }
  | { kind: "list"; key: string; label: string; hint: string | null }
  | { kind: "reference"; key: string; label: string; hint: string | null; rule: ReferenceRule };

export interface ReadOnlyFact {
  key: string;
  label: string;
  value: string;
}

export interface FormInput {
  schema: Schema | null;
  supportsStatus: boolean;
  references: readonly ReferenceRule[];
  agentTypes: readonly { id: string; label: string }[];
  /** Identity keys, skill_type and the type's immutableKeys: shown as read-only facts */
  readOnlyKeys: readonly string[];
  descriptionMax: number;
  /** What the edit rules allow (managed memories: status only) */
  allow: { metadata: boolean; status: boolean };
  metadata: Record<string, unknown>;
}

/** "enable_tools" -> "Enable tools", "memoryStore" -> "Memory store". */
export function sentenceCase(key: string): string {
  const words = key
    .replace(/_id$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  const s = words.join(" ");
  return s ? s[0]!.toUpperCase() + s.slice(1) : key;
}

const isRef = (s: unknown, def: string) => typeof s === "object" && s !== null && (s as Schema).$ref === `#/$defs/${def}`;
const hintOf = (s: Schema) => (typeof s["x-hint"] === "string" ? (s["x-hint"] as string) : null);

function display(value: unknown, agentTypes: FormInput["agentTypes"], refs: readonly ReferenceRule[], key: string): string {
  const rule = refs.find((r) => r.key === key);
  const nameOf = (id: unknown) => (rule ? (rule.options.find((o) => o.assetId === id)?.name ?? String(id)) : String(id));
  const labelOf = (v: unknown) => agentTypes.find((a) => a.id === v)?.label ?? (rule ? nameOf(v) : String(v));
  if (value === undefined || value === null || value === "") return "Not set";
  if (Array.isArray(value)) return value.length ? value.map(labelOf).join(", ") : "None";
  if (typeof value === "object") return JSON.stringify(value);
  if (key === "status") return value === "INACTIVE" ? "Inactive" : value === "ACTIVE" ? "Active" : String(value);
  return labelOf(value);
}

/** Editable fields in schema order, and read-only facts for the rest. */
export function formFromSchema(input: FormInput): { fields: FieldSpec[]; facts: ReadOnlyFact[] } {
  const props = (input.schema?.properties ?? {}) as Record<string, Schema>;
  const fields: FieldSpec[] = [];
  const facts: ReadOnlyFact[] = [];
  for (const [key, prop] of Object.entries(props)) {
    const label = typeof prop.title === "string" ? prop.title : sentenceCase(input.references.find((r) => r.key === key)?.ref ?? key);
    const hint = hintOf(prop);
    const fact = () => facts.push({ key, label, value: display(input.metadata[key], input.agentTypes, input.references, key) });
    if (key === "status") {
      if (!input.supportsStatus) continue;
      if (input.allow.status) fields.push({ kind: "status", key, label: "Status", hint });
      else fact();
      continue;
    }
    if (input.readOnlyKeys.includes(key) || !input.allow.metadata) {
      if (input.metadata[key] !== undefined) fact();
      continue;
    }
    const rule = input.references.find((r) => r.key === key);
    if (rule) {
      fields.push({ kind: "reference", key, label, hint, rule });
    } else if (isRef(prop, "description")) {
      fields.push({ kind: "description", key, label, hint, max: input.descriptionMax });
    } else if (prop.type === "array" && isRef(prop.items, "agentType")) {
      fields.push({ kind: "agent-types", key, label, hint, options: [...input.agentTypes] });
    } else if (prop.type === "array" && typeof prop.items === "object" && (prop.items as Schema).type === "string") {
      fields.push({ kind: "list", key, label, hint });
    } else if (prop.type === "string" || Array.isArray(prop.enum) || isRef(prop, "agentType")) {
      fields.push({ kind: "text", key, label, hint });
    } else if (input.metadata[key] !== undefined) {
      fact();
    }
  }
  return { fields, facts };
}

/** "a, b ,c" -> ["a", "b", "c"]; an empty input removes the key's values. */
export function parseList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

export function listText(value: unknown): string {
  return Array.isArray(value) ? value.map(String).join(", ") : "";
}

/** The field a schema issue belongs to: "agent_types[1]" -> "agent_types", "" -> null. */
export function fieldOfPath(path: string): string | null {
  const m = /^([^.[]+)/.exec(path.replace(/^metadata\.?/, ""));
  return m?.[1] ?? null;
}

/** New metadata and refs after picking referenced assets by name; the app writes their IDs. */
export function setReference(
  metadata: Record<string, unknown>,
  refs: Record<string, string | string[]>,
  rule: Pick<ReferenceRule, "key" | "ref" | "many" | "options">,
  assetIds: readonly string[],
): { metadata: Record<string, unknown>; refs: Record<string, string | string[]> } {
  const names = assetIds.map((id) => rule.options.find((o) => o.assetId === id)?.name).filter((n): n is string => Boolean(n));
  const nextMeta = { ...metadata };
  const nextRefs = { ...refs };
  if (rule.many) {
    nextMeta[rule.key] = [...assetIds];
    nextRefs[rule.ref] = names;
  } else if (assetIds[0]) {
    nextMeta[rule.key] = assetIds[0];
    nextRefs[rule.ref] = names[0] ?? "";
  } else {
    delete nextMeta[rule.key];
    delete nextRefs[rule.ref];
  }
  return { metadata: nextMeta, refs: nextRefs };
}
