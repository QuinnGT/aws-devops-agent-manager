// Bounded smoke test: start the built web server (127.0.0.1 only) and the worker,
// probe them, then stop both. Usage: DATABASE_URL=... node scripts/smoke.mjs [port]
import { spawn, execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const port = process.argv[2] ?? "3999";
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, AUTH_DEV_BYPASS: "true", DAM_HOST: "127.0.0.1", PORT: port };

const web = spawn("pnpm", ["start"], { env, stdio: ["ignore", "pipe", "pipe"] });
const worker = spawn("node", ["dist/worker.mjs"], { env: { ...env, DAM_PROCESS: "worker" }, stdio: ["ignore", "pipe", "pipe"] });
let workerOut = "";
worker.stdout.on("data", (d) => (workerOut += d));
worker.stderr.on("data", (d) => (workerOut += d));
let webOut = "";
web.stdout.on("data", (d) => (webOut += d));
web.stderr.on("data", (d) => (webOut += d));

const results = {};
try {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(base + "/", { redirect: "manual" });
      if (r.status) break;
    } catch {}
    if (web.exitCode !== null) break;
    await sleep(500);
  }
  const home = await fetch(base + "/", { redirect: "manual" }).catch((e) => {
    console.log("web output:\n" + webOut.slice(-3000));
    throw e;
  });
  results["GET /"] = home.status;
  results["home shows local mode"] = (await home.text()).includes("local sign-in bypass");
  results["GET /api/jobs/not-a-uuid"] = (await fetch(base + "/api/jobs/not-a-uuid")).status;
  try {
    results.listener = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" })
      .split("\n")
      .slice(1)
      .filter(Boolean)
      .map((l) => l.split(/\s+/).slice(-2).join(" "));
  } catch {
    results.listener = "lsof failed";
  }
  for (let i = 0; i < 40 && !workerOut.includes("[worker] started"); i++) await sleep(500);
  results.worker = workerOut.split("\n").filter((l) => l.includes("[worker]")).slice(-2);
} finally {
  web.kill("SIGTERM");
  worker.kill("SIGTERM");
}
console.log(JSON.stringify(results, null, 2));
if (results["GET /"] !== 200 || !workerOut.includes("[worker] started")) {
  console.log(webOut.slice(-2000));
  console.log(workerOut.slice(-2000));
  process.exit(1);
}
