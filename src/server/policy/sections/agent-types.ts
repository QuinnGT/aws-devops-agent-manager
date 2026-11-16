import { z } from "zod";
import { defineSection } from "./define";

/** The API does not list agent types, so they live here. */
export const agentTypesSection = defineSection(
  "agent-types.yaml",
  z.object({
    agentTypes: z
      .array(
        z.object({
          id: z.string(),
          label: z.string(),
          /** Short form for asset names and chips ("Global" gives "Global instructions"); default: label */
          shortLabel: z.string().min(1).optional(),
          /** Shown first in the instruction editor */
          primary: z.boolean().default(false),
        }),
      )
      .min(1),
  }),
);
