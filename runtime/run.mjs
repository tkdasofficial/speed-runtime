// Speed command runtime: runs exactly one command (install/build/typecheck/lint/test/format/script) for one
// project in a throwaway workspace and reports the real exit code, output and diagnostics to the Speed API.
// The job token can only read this job's project files and post this job's result once.
import { mkdir, writeFile, readFile, rm, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname, resolve, relative } from "node:path";

const { JOB_ID, API_URL, JOB_TOKEN, WORK_ROOT } = process.env;
const ws = resolve(WORK_ROOT || "/tmp/workspace", JOB_ID);
const auth = { Authorization: `Bearer ${JOB_TOKEN}` };
const MAX = 200_000;

async function report(r) {
  const res = await fetch(`${API_URL}/runtime/job/${JOB_ID}/result`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(r) });
  console.log(`reported ${res.status}`);
}

// Child processes get only a minimal env plus the project's own variables (never the job token).
function run(cmd, args, extraEnv = {}, timeoutMs = 8 * 60_000) {
  return new Promise((done) => {
    let out = "";
    const p = spawn(cmd, args, { cwd: ws, env: { PATH: process.env.PATH, HOME: process.env.HOME, CI: "1", NODE_ENV: "development", FORCE_COLOR: "0", ...extraEnv }, shell: false });
    const add = (d) => { out += d.toString(); if (out.length > MAX) out = out.slice(-MAX); };
    p.stdout.on("data", add); p.stderr.on("data", add);
    const t = setTimeout(() => { add(`\n[timed out after ${timeoutMs / 1000}s]`); p.kill("SIGKILL"); }, timeoutMs);
    p.on("close", (code) => { clearTimeout(t); done({ code: code ?? 1, out }); });
    p.on("error", (e) => { clearTimeout(t); done({ code: 127, out: out + String(e) }); });
  });
}

function tsDiagnostics(out) {
  const d = [];
  for (const m of out.matchAll(/^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.+)$/gm)) d.push({ file: m[1], line: +m[2], column: +m[3], severity: m[4], code: m[5], message: m[6] });
  for (const m of out.matchAll(/^(.+?):(\d+):(\d+) - (error|warning) (TS\d+): (.+)$/gm)) d.push({ file: m[1], line: +m[2], column: +m[3], severity: m[4], code: m[5], message: m[6] });
  return d;
}
function buildDiagnostics(out) {
  const d = [];
  for (const m of out.matchAll(/(?:file|File):\s*([^\s:]+):(\d+):(\d+)/g)) d.push({ file: m[1].replace(ws + "/", ""), line: +m[2], column: +m[3], severity: "error" });
  for (const m of out.matchAll(/\[vite\][^\n]*?:\s*(.+)\n[\s\S]{0,200}?file: ([^\s:]+):(\d+):(\d+)/g)) d.push({ file: m[2].replace(ws + "/", ""), line: +m[3], column: +m[4], severity: "error", message: m[1] });
  return d.slice(0, 200);
}

async function walk(dir, acc = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, acc); else acc.push(p);
  }
  return acc;
}

async function main() {
  const src = await fetch(`${API_URL}/runtime/job/${JOB_ID}/source`, { headers: auth });
  if (!src.ok) throw new Error(`source ${src.status}: ${await src.text()}`);
  const { kind, script, files, env = {} } = await src.json();
  await rm(ws, { recursive: true, force: true });
  await mkdir(ws, { recursive: true });
  const original = new Map();
  for (const f of files) {
    const p = resolve(ws, f.path);
    if (!p.startsWith(ws + "/")) continue;
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, f.encoding === "base64" ? Buffer.from(f.content, "base64") : f.content);
    if (f.encoding !== "base64") original.set(f.path, f.content);
  }
  const pkg = existsSync(join(ws, "package.json")) ? JSON.parse(await readFile(join(ws, "package.json"), "utf8")) : null;
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  let log = "";
  const step = async (label, cmd, args, e) => { const r = await run(cmd, args, e); log += `$ ${label}\n${r.out}\n`; return r; };

  if (!pkg && kind !== "format") return report({ ok: false, exitCode: 1, output: "This project has no package.json, so there is nothing to install, build or test.", diagnostics: [] });
  if (pkg) {
    // Install scripts never run (supply-chain safety); test/script kinds run the project's own scripts below.
    const i = await step("npm install --ignore-scripts", "npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"]);
    if (i.code !== 0) return report({ ok: false, exitCode: i.code, output: log, diagnostics: [] });
  }
  let r = { code: 0, out: "" }, diagnostics = [], outFiles;
  switch (kind) {
    case "install": {
      const lock = existsSync(join(ws, "package-lock.json")) ? await readFile(join(ws, "package-lock.json"), "utf8") : null;
      outFiles = lock ? [{ path: "package-lock.json", content: lock }] : [];
      break;
    }
    case "build":
      r = deps.vite ? await step("vite build", "npx", ["--no-install", "vite", "build"], env) : pkg.scripts?.build ? await step("npm run build", "npm", ["run", "build"], env) : { code: 1, out: "No vite dependency and no build script." };
      diagnostics = [...tsDiagnostics(r.out), ...buildDiagnostics(r.out)];
      break;
    case "typecheck": {
      if (!existsSync(join(ws, "tsconfig.json"))) { r = { code: 1, out: "No tsconfig.json — this is not a TypeScript project." }; break; }
      const args = deps.typescript ? ["--no-install", "tsc", "--noEmit", "--pretty", "false"] : ["-y", "-p", "typescript@5", "tsc", "--noEmit", "--pretty", "false"];
      const refs = JSON.parse((await readFile(join(ws, "tsconfig.json"), "utf8")).replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1") || "{}").references;
      r = await step("tsc --noEmit", "npx", refs?.length ? [...args.slice(0, -3), "-b", "--pretty", "false"] : args);
      diagnostics = tsDiagnostics(r.out);
      break;
    }
    case "lint": {
      const cfg = (await readdir(ws)).find((n) => /^(eslint\.config\.(m?js|cjs|ts)|\.eslintrc(\.\w+)?)$/.test(n));
      if (!cfg || !deps.eslint) { r = { code: 1, out: "No ESLint config/dependency in this project. Add eslint and an eslint.config.js to lint." }; break; }
      r = await step("eslint . -f json", "npx", ["--no-install", "eslint", ".", "-f", "json"]);
      try {
        const j = JSON.parse(r.out.slice(r.out.indexOf("[")));
        for (const f of j) for (const m of f.messages) diagnostics.push({ file: relative(ws, f.filePath), line: m.line, column: m.column, severity: m.severity === 2 ? "error" : "warning", code: m.ruleId, message: m.message });
        r.out = `${diagnostics.filter((d) => d.severity === "error").length} errors, ${diagnostics.filter((d) => d.severity === "warning").length} warnings`;
      } catch { /* keep raw output */ }
      break;
    }
    case "test":
      if (!pkg.scripts?.test) { r = { code: 1, out: "package.json has no test script." }; break; }
      r = await step("npm test", "npm", ["test", "--", ...(deps.vitest ? ["--run"] : [])], { ...env, CI: "1" });
      break;
    case "script":
      if (!pkg.scripts?.[script]) { r = { code: 1, out: `package.json has no "${script}" script.` }; break; }
      r = await step(`npm run ${script}`, "npm", ["run", script], env);
      break;
    case "format": {
      r = await step("prettier --write .", "npx", ["-y", "prettier@3", "--write", ".", "--ignore-unknown", "--log-level", "warn"]);
      outFiles = [];
      for (const p of await walk(ws)) {
        const rel = relative(ws, p);
        if (!original.has(rel) || (await stat(p)).size > 2_000_000) continue;
        const now = await readFile(p, "utf8");
        if (now !== original.get(rel)) outFiles.push({ path: rel, content: now });
      }
      log += `\n${outFiles.length} files reformatted\n`;
      break;
    }
    default: r = { code: 1, out: `Unknown job kind ${kind}` };
  }
  if (!log.includes(r.out)) log += r.out;
  await report({ ok: r.code === 0, exitCode: r.code, output: log, diagnostics, ...(outFiles ? { files: outFiles } : {}) });
}

main().catch(async (e) => {
  console.error(e);
  try { await report({ ok: false, exitCode: 1, output: `Runtime error: ${e?.message ?? e}`, diagnostics: [] }); } catch {}
  process.exitCode = 1;
}).finally(() => rm(ws, { recursive: true, force: true }));
