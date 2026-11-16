import type { z } from "zod";
import { agentTypesSection } from "./agent-types";
import { analyzersSection } from "./analyzers";
import { apiSection } from "./api";
import { assetTypesSection } from "./asset-types";
import { attributionSection } from "./attribution";
import { auditsSection } from "./audits";
import { historyLayoutSection } from "./history-layout";
import { journalImportSection } from "./journal-import";
import { journalsSection } from "./journals";
import { limitsSection } from "./limits";
import { outputRulesSection } from "./output-rules";
import { packageIoSection } from "./package-io";
import { packageLayoutsSection } from "./package-layouts";
import { plansSection } from "./plans";
import { releasesSection } from "./releases";
import { revisionsSection } from "./revisions";
import { rolesSection } from "./roles";
import { syncSection } from "./sync";
import { verifySection } from "./verify";

/**
 * Every policy section: one YAML file in policy/ validated by one Zod schema.
 * Add a new section by adding a file under sections/ and registering it here.
 */
export const policySections = {
  roles: rolesSection,
  agentTypes: agentTypesSection,
  api: apiSection,
  historyLayout: historyLayoutSection,
  assetTypes: assetTypesSection,
  limits: limitsSection,
  packageLayouts: packageLayoutsSection,
  attribution: attributionSection,
  sync: syncSection,
  journals: journalsSection,
  journalImport: journalImportSection,
  outputRules: outputRulesSection,
  analyzers: analyzersSection,
  plans: plansSection,
  releases: releasesSection,
  packageIo: packageIoSection,
  audits: auditsSection,
  revisions: revisionsSection,
  verify: verifySection,
} as const;

export type PolicySections = typeof policySections;
export type Policy = { [K in keyof PolicySections]: z.output<PolicySections[K]["schema"]> };

export { defineSection, type PolicySection } from "./define";
