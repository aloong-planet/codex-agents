export type WorkflowFileSearchPlan = {
  nameTerms: string[];
  pathTerms: string[];
  contentTerms: string[];
};

const GROUP_KEYS = ["nameTerms", "pathTerms", "contentTerms"] as const;
const MAX_TERMS_PER_GROUP = 8;
const MAX_TERM_BYTES = 128;
const MAX_TOTAL_BYTES = 500;

export function parseWorkflowFileSearchPlan(value: unknown): WorkflowFileSearchPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("workflow_file_search_plan_invalid");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== GROUP_KEYS.length ||
      GROUP_KEYS.some((key) => !Object.hasOwn(record, key))) {
    throw new Error("workflow_file_search_plan_invalid");
  }
  const plan = Object.fromEntries(GROUP_KEYS.map((key) => {
    const raw = record[key];
    if (!Array.isArray(raw) || raw.length > MAX_TERMS_PER_GROUP) {
      throw new Error("workflow_file_search_plan_invalid");
    }
    const terms = Array.from(new Set(raw.map((item) => {
      if (typeof item !== "string") throw new Error("workflow_file_search_plan_invalid");
      const term = item.normalize("NFKC").trim();
      if (!term || Buffer.byteLength(term, "utf8") > MAX_TERM_BYTES) {
        throw new Error("workflow_file_search_plan_invalid");
      }
      return term;
    })));
    return [key, terms];
  })) as WorkflowFileSearchPlan;
  if (GROUP_KEYS.every((key) => plan[key].length === 0) ||
      Buffer.byteLength(JSON.stringify(plan), "utf8") > MAX_TOTAL_BYTES) {
    throw new Error("workflow_file_search_plan_invalid");
  }
  return plan;
}
