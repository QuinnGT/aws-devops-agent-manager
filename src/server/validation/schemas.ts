import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020";
import type { Policy } from "@/server/policy";

/**
 * JSON Schema support for asset metadata (asset-types.yaml). One Ajv instance
 * (draft 2020-12), compiled validators cached by schema text.
 *
 * Two definitions are injected from policy so each rule has one source:
 *   #/$defs/agentType    enum of agent type IDs (agent-types.yaml)
 *   #/$defs/description  string, 1 to limits.descriptionMaxChars characters
 * A schema's own `$defs` entries win over the injected ones.
 */

export type SchemaKind = "metadataSchema" | "metadataWarningSchema" | "createSchema";
export type JsonSchema = Record<string, unknown>;

/** Annotation keywords allowed in policy schemas (ignored by validation). */
export const ANNOTATION_KEYWORDS = ["x-hint"] as const;

let ajvInstance: Ajv2020 | undefined;

function ajv(): Ajv2020 {
  if (!ajvInstance) {
    ajvInstance = new Ajv2020({ allErrors: true, verbose: true, strict: true, strictTypes: false, strictTuples: false });
    for (const keyword of ANNOTATION_KEYWORDS) ajvInstance.addKeyword({ keyword, schemaType: "string" });
  }
  return ajvInstance;
}

const cache = new Map<string, ValidateFunction>();

function compile(schema: JsonSchema): ValidateFunction {
  const key = JSON.stringify(schema);
  let fn = cache.get(key);
  if (!fn) {
    fn = ajv().compile(schema);
    if (cache.size > 500) cache.clear();
    cache.set(key, fn);
  }
  return fn;
}

/** Definitions injected into every policy schema. */
export function policyDefs(policy: Pick<Policy, "agentTypes" | "limits">): Record<string, JsonSchema> {
  const max = policy.limits.descriptionMaxChars;
  return {
    agentType: {
      enum: policy.agentTypes.agentTypes.map((a) => a.id),
      "x-hint": `Use one of: ${policy.agentTypes.agentTypes.map((a) => a.id).join(", ")}.`,
    },
    description: {
      type: "string",
      minLength: 1,
      maxLength: max,
      "x-hint": `Use 1 to ${max} characters.`,
    },
  };
}

/** Placeholder definitions used to check a schema compiles when policy is loaded. */
const PLACEHOLDER_DEFS: Record<string, JsonSchema> = {
  agentType: { type: "string" },
  description: { type: "string" },
};

function withDefs(schema: JsonSchema, defs: Record<string, JsonSchema>): JsonSchema {
  const own = (schema.$defs ?? {}) as Record<string, JsonSchema>;
  return { ...schema, $defs: { ...defs, ...own } };
}

/**
 * The schema for one asset type with policy definitions filled in. Use this
 * for generated forms. Returns null when the type has no such schema.
 */
export function resolvedSchema(
  policy: Pick<Policy, "agentTypes" | "limits" | "assetTypes">,
  assetType: string,
  kind: SchemaKind = "metadataSchema",
): JsonSchema | null {
  const entry = policy.assetTypes.assetTypes[assetType];
  const schema = entry?.[kind];
  if (!schema || Object.keys(schema).length === 0) return null;
  return withDefs(schema, policyDefs(policy));
}

/** Compiled validator for an asset type's schema, or null if there is none. */
export function metadataValidator(
  policy: Pick<Policy, "agentTypes" | "limits" | "assetTypes">,
  assetType: string,
  kind: SchemaKind,
): ValidateFunction | null {
  const schema = resolvedSchema(policy, assetType, kind);
  return schema ? compile(schema) : null;
}

/** Throws with Ajv's message when a policy schema is not valid JSON Schema. */
export function assertCompilableSchema(schema: JsonSchema): void {
  if (Object.keys(schema).length === 0) return;
  compile(withDefs(schema, PLACEHOLDER_DEFS));
}

export interface SchemaIssue {
  /** Dotted path under the validated object, for example "agent_types[1]" ("" for the object itself) */
  path: string;
  keyword: string;
  message: string;
}

/**
 * Turn Ajv errors into plain messages. Each message uses the nearest `x-hint`
 * on the failing schema path (for example the hint on `agent_types` for a
 * failed `then: { maxItems: 1 }` under it). Errors with the same path and
 * hint are reported once.
 */
export function describeSchemaErrors(errors: ErrorObject[] | null | undefined, root: JsonSchema): SchemaIssue[] {
  if (!errors?.length) return [];
  const issues: SchemaIssue[] = [];
  const seen = new Set<string>();
  for (const e of errors) {
    let instancePath = e.instancePath;
    let hint = hintAlong(root, e.schemaPath);
    if (e.keyword === "required") {
      const missing = String((e.params as { missingProperty?: string }).missingProperty ?? "");
      instancePath = `${instancePath}/${missing}`;
      const props = (e.parentSchema as JsonSchema | undefined)?.properties as Record<string, JsonSchema> | undefined;
      hint = hintOf(props?.[missing]) ?? hintOf(resolveRef(props?.[missing], root));
    }
    const path = jsonPointerToDotted(instancePath);
    let message: string;
    if (e.keyword === "required") message = `${path} is required${hint ? `. ${hint}` : "."}`;
    else if (e.keyword === "enum" && !hint) {
      const allowed = (e.params as { allowedValues?: unknown[] }).allowedValues ?? [];
      message = `${path || "value"} must be one of: ${allowed.map(String).join(", ")}.`;
    } else message = `${path || "value"}: ${hint ?? `${e.message ?? "is not valid"}.`}`;
    const dedupeKey = `${path}\0${hint ?? e.keyword}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    issues.push({ path, keyword: e.keyword, message });
  }
  return issues;
}

/** The deepest `x-hint` on the way from the root to the schema at schemaPath ("#/properties/a/then/maxItems"). */
function hintAlong(root: JsonSchema, schemaPath: string): string | undefined {
  if (!schemaPath.startsWith("#")) return undefined;
  let node: unknown = root;
  let hint = hintOf(root);
  for (const raw of schemaPath.slice(1).split("/").filter(Boolean)) {
    const part = decodeURIComponent(raw.replace(/~1/g, "/").replace(/~0/g, "~"));
    node = node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined;
    if (node === undefined) break;
    hint = hintOf(node) ?? hint;
  }
  return hint;
}

function hintOf(schema: unknown): string | undefined {
  if (schema && typeof schema === "object" && typeof (schema as JsonSchema)["x-hint"] === "string") {
    return (schema as JsonSchema)["x-hint"] as string;
  }
  return undefined;
}

function resolveRef(schema: JsonSchema | undefined, root: JsonSchema): JsonSchema | undefined {
  const ref = schema?.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/")) return undefined;
  let node: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    node = node && typeof node === "object" ? (node as JsonSchema)[decodeURIComponent(part.replace(/~1/g, "/").replace(/~0/g, "~"))] : undefined;
  }
  return node && typeof node === "object" ? (node as JsonSchema) : undefined;
}

/** "/agent_types/1" -> "agent_types[1]", "/a/b" -> "a.b" */
export function jsonPointerToDotted(pointer: string): string {
  if (!pointer) return "";
  let out = "";
  for (const raw of pointer.slice(1).split("/")) {
    const part = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (/^\d+$/.test(part)) out += `[${part}]`;
    else out += out ? `.${part}` : part;
  }
  return out;
}
