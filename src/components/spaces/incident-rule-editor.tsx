"use client";

import { useMemo, useState } from "react";
import { Checkbox } from "@/components/common/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { compileIncidentRegex, extractIncidentId, type IncidentIdTaskFields } from "@/server/spaces/incident-id";
import { INCIDENT_ID_FIELDS, type IncidentIdField, type IncidentIdRule } from "@/server/spaces/settings-schema";
import { CheckField, Field, selectClass } from "./field";

/** Build a task whose chosen field holds the sample, so the tester runs the same code as the server. */
function sampleTask(field: IncidentIdField, sample: string): IncidentIdTaskFields {
  switch (field) {
    case "title":
      return { title: sample };
    case "description":
      return { description: sample };
    case "reference.referenceId":
      return { reference: { referenceId: sample } };
    case "reference.title":
      return { reference: { title: sample } };
  }
}

/**
 * Incident ID rule fields for the space settings form, with a live tester.
 * Field names: incidentIdRule.enabled, incidentIdRule.regex, incidentIdRule.field.
 */
export function IncidentRuleEditor({ rule, errors }: { rule: IncidentIdRule | null; errors: Record<string, string> }) {
  const [enabled, setEnabled] = useState(rule !== null);
  const [regex, setRegex] = useState(rule?.regex ?? "");
  const [field, setField] = useState<IncidentIdField>(rule?.field ?? "title");
  const [samples, setSamples] = useState("");

  const compiled = useMemo(() => (regex ? compileIncidentRegex(regex) : null), [regex]);
  const results = useMemo(() => {
    const lines = samples.split(/\r?\n/).filter((l) => l.trim() !== "").slice(0, 50);
    return lines.map((line) => ({ line, id: extractIncidentId({ regex, field }, sampleTask(field, line)) }));
  }, [samples, regex, field]);

  return (
    <div className="space-y-4">
      <CheckField
        id="incidentIdRule.enabled"
        label="Extract an incident ID from each investigation"
        control={<Checkbox id="incidentIdRule.enabled" name="incidentIdRule.enabled" checked={enabled} onCheckedChange={(v) => setEnabled(v === true)} />}
      />
      <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
        <Field
          id="incidentIdRule.regex"
          label="Pattern to find the ID"
          hint="Written as a JavaScript regular expression, like the example in the box. The ID is the part inside (?<id>...) if there is one, otherwise the first part in parentheses, otherwise the whole match."
          error={errors["incidentIdRule.regex"] ?? (enabled && compiled && !compiled.ok ? compiled.error : undefined)}
        >
          <Input
            id="incidentIdRule.regex"
            name="incidentIdRule.regex"
            value={regex}
            onChange={(e) => setRegex(e.target.value)}
            disabled={!enabled}
            placeholder="\[(?<id>INC-\d+)\]"
            className="font-mono"
            spellCheck={false}
            autoComplete="off"
          />
        </Field>
        <Field id="incidentIdRule.field" label="Task field" error={errors["incidentIdRule.field"]}>
          <select
            id="incidentIdRule.field"
            name="incidentIdRule.field"
            value={field}
            onChange={(e) => setField(e.target.value as IncidentIdField)}
            disabled={!enabled}
            className={selectClass}
          >
            {INCIDENT_ID_FIELDS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field id="incident-samples" label="Try it" hint="Paste sample values for the chosen field, one per line. Nothing here is saved.">
        <Textarea
          id="incident-samples"
          value={samples}
          onChange={(e) => setSamples(e.target.value)}
          rows={4}
          className="font-mono text-xs"
          placeholder={"[INC-4821] Checkout latency in us-west-2\nDatabase failover alarm"}
          spellCheck={false}
        />
      </Field>
      {results.length > 0 ? (
        <table className="w-full text-sm" aria-label="Incident IDs found in the samples">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th scope="col" className="py-1 pr-4 font-medium">
                Sample
              </th>
              <th scope="col" className="py-1 font-medium">
                Incident ID
              </th>
            </tr>
          </thead>
          <tbody>
            {results.map((r, i) => (
              <tr key={i} className="border-t">
                <td className="max-w-md truncate py-1 pr-4 font-mono text-xs">{r.line}</td>
                <td className="py-1 font-mono text-xs">{r.id ?? <span className="text-muted-foreground">No match</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
