#!/usr/bin/env node
// Stage C live E2E entry point (issue #89). Runs ONLY from the manual s1-3-stagec-e2e workflow.
// Usage: node s1-3-stagec.mjs run --receipt <file>
// Order matters: (1) live D1 schema must verify BEFORE any harness call, because the revoked-grant case issues two
// INSERTs that the triggers must reject; (2) harness matrix; (3) live Cloudflare readback. Fails closed throughout.
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import * as pre from "./s1-3-preflight-lib.mjs";
import { STAGEC, StageCError, runStageC, createHttpHarness, createD1Http, makeCleanup, liveReadbackCase } from "./s1-3-stagec-lib.mjs";

export async function main(argv, env, { fetchImpl = globalThis.fetch, write = (f, t) => writeFileSync(f, t) } = {}) {
  const [cmd, flag, receipt] = argv;
  if (cmd !== "run" || flag !== "--receipt" || !receipt) { console.error("usage: s1-3-stagec.mjs run --receipt <file>"); return 2; }
  const emit = (obj) => { write(receipt, `${JSON.stringify(obj, null, 2)}\n`); return obj; };
  try {
    const sourceSha = env.SOURCE_SHA, runId = env.STAGE_C_RUN_ID;
    const cf = pre.createCloudflareClient({ token: env.CLOUDFLARE_API_TOKEN, accountId: env.CLOUDFLARE_ACCOUNT_ID, fetchImpl });
    const d1 = createD1Http({ token: env.CLOUDFLARE_API_TOKEN, accountId: env.CLOUDFLARE_ACCOUNT_ID, fetchImpl });
    const harness = createHttpHarness({ url: env.STAGE_C_HARNESS_URL, token: env.STAGE_C_HARNESS_TOKEN, runId, fetchImpl });
    const schema = await pre.checkD1Schema(cf);
    if (!schema.ok) {
      emit({ schema: STAGEC.evidenceSchema, mode: "live", ok: false, aborted: "d1_schema_not_verified_no_harness_call_made", source_sha: sourceSha, run_id: runId, schema_check: schema });
      console.error("Stage C aborted: live D1 schema failed verification; no test traffic was sent.");
      return 1;
    }
    const cleanup = env.STAGE_C_CLEANUP_APPROVAL ? makeCleanup({ approval: env.STAGE_C_CLEANUP_APPROVAL, approvalId: env.STAGE_C_CLEANUP_APPROVAL_ID }) : null;
    const evidence = await runStageC({
      harness, d1, runId, sourceSha, cleanup, requiredExtra: ["C09"],
      extraCases: [["C09", "live Cloudflare readback + no public URL", () => liveReadbackCase({ cf, lib: pre, fetchImpl, sourceSha, gatewayWorker: env.STAGE_C_GATEWAY_WORKER || null })]]
    });
    emit({ ...evidence, schema_check: schema });
    console.log(`Stage C ${evidence.ok ? "PASSED" : "FAILED"} (live mode, ${evidence.cases.filter((c) => c.ok).length}/${evidence.cases.length} cases) evidence_sha256=${evidence.evidence_sha256}`);
    for (const w of evidence.warnings) console.log(`::warning::${w}`);
    return evidence.ok ? 0 : 1;
  } catch (e) {
    const code = e instanceof StageCError || e?.name === "CloudflareApiError" ? e.code : "unexpected_error";
    emit({ schema: STAGEC.evidenceSchema, mode: "live", ok: false, aborted: code });
    console.error(`Stage C aborted: ${code}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = await main(process.argv.slice(2), process.env);
