import type { z } from "zod";

export interface PolicySection<S extends z.ZodType> {
  /** File name under a policy directory */
  file: string;
  schema: S;
}

export function defineSection<S extends z.ZodType>(file: string, schema: S): PolicySection<S> {
  return { file, schema };
}
