import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { atRest, type ExecutorRun, realModelDispatch, realModelScenario, skilledPreset, turns } from "./support/real-model-dispatch.js";

// Skills on the real model (skill-library::REQ-003). Opt-in with the dispatch real-model suite: `pnpm test:dispatch-real-model`
// sets DISPATCH_REAL_MODEL_TEST=1 and runs this file too; without it the scenario is skipped. Real main runs with every platform a
// fixture; the Coordinator, the Team Leaders and the Executors are real. The SKILL.md an Executor's turns carry only says where
// the rule is, and the rule's mark is in that reference file alone: a result that carries it read the file with its own tool.

const REQUEST_WAIT_MS = 1_200_000, REQUEST_LIMIT_MS = 1_320_000;
const PRICING_MARK = "PR-4M8";
const PRICING_SKILL = `---
name: bargain-pricing
description: 回复二手交易买家的议价：先确认成色与配件，再按定价口径给出可接受的价格和理由。
---

# 议价回复

给买家写议价回复前，必须先读本 skill 的 references/pricing.md，按其中的定价口径写回复，并照它要求的格式交回结果。
`;
const PRICING_REFERENCE = `# 定价口径

1. 价格不低于挂牌价的 85%，并说明理由。
2. 回复正文之后单独写一行口径编号：口径 ${PRICING_MARK}。交回的结果里必须原样保留这一行。
`;

describe.skipIf(!realModelDispatch)("skills on the real model", () => {
  it("has an Executor read a file of its skill that its SKILL.md points to, and work by it", () => realModelScenario(
    { id: "profile-skill-file", acceptance: ["skill-library::REQ-003"] }, async (run) => {
      // The skill's folder is outside the granted directory: no file tool of an Executor can read it there.
      const sources = mkdtempSync(join(tmpdir(), "real-model-skill-"));
      try {
        const skilled = await skilledPreset(run, sources, "bargain-pricing", { "SKILL.md": PRICING_SKILL, "references/pricing.md": PRICING_REFERENCE });
        await run.send("om_real_skill_file", "闲鱼上有个买家问那台 Kindle 400 能不能出，我挂的是 550。帮我拟一条回复买家的议价话术，直接在群里回我就行，不用存成文件。");
        const state = await run.until("the request's end", (current) => atRest(current, "om_real_skill_file"), REQUEST_WAIT_MS);
        expect(state.agentDispatch?.jobs).toHaveLength(1);
        const request = state.agentDispatch!.jobs[0]!;
        const chosen = request.assignments.filter(({ profileId }) => profileId === skilled);
        expect(chosen.length, "no Assignment was put on the preset that selects the skill").toBeGreaterThanOrEqual(1);
        const runs = turns(state, "run") as ExecutorRun[];
        for (const assignment of chosen) {
          const own = runs.find(({ input }) => input.assignmentId === assignment.id);
          expect(own?.output?.status).toBe("completed");
          expect(own!.output!.message, "the Executor's result lacks the mark its skill's reference file asks for").toContain(PRICING_MARK);
        }
        expect(request.status).toBe("completed");
      } finally { rmSync(sources, { recursive: true, force: true }); }
    }), REQUEST_LIMIT_MS);
});
