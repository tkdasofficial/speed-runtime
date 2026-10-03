// Fetches one project's source from the Speed API, builds it in an isolated temp workspace
// (WORK_ROOT/{userId}/{projectId}), and posts the static output (or a failure) back.
// Only this fixed pipeline runs: npm install --ignore-scripts, then vite build. Project-supplied scripts are never executed.
import { mkdir, writeFile, readFile, readdir, rm, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const { BUILD_ID, PROJECT_ID, USER_ID, API_URL, BUILD_TOKEN, WORK_ROOT } = process.env;
const ID = /^[\w-]{1,64}$/;
if (![BUILD_ID, PROJECT_ID, USER_ID].every((v) => ID.test(v ?? "")) || !/^https:\/\//.test(API_URL ?? "") || !BUILD_TOKEN || !WORK_ROOT) {
  console.error("Invalid build inputs"); process.exit(1);
}
const auth = { Authorization: `Bearer ${BUILD_TOKEN}` };
const base = `${API_URL}/runtime`;
const ws = path.resolve(WORK_ROOT, USER_ID, PROJECT_ID);
const out = path.resolve(WORK_ROOT, USER_ID, `${PROJECT_ID}.out`);

const safe = (p) => typeof p === "string" && p.length <= 400 && !p.startsWith("/") && !p.includes("\\") && !/^[a-zA-Z]:/.test(p) && !/[\u0000-\u001f]/.test(p) && p.split("/").every((s) => s && s !== "." && s !== "..");
const inside = (root, p) => { const r = path.resolve(root, p); return r.startsWith(root + path.sep) ? r : null; };

async function report(body) {
  const res = await fetch(`${base}/result/${PROJECT_ID}/${BUILD_ID}`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  console.log(`result → ${res.status} ${(await res.text()).slice(0, 300)}`);
}
function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ws, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, CI: "1", NODE_ENV: "development" }, maxBuffer: 64 * 1024 * 1024, timeout: 8 * 60_000 });
  const log = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  process.stdout.write(log.slice(-20000));
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed:\n${log.trim().slice(-3000)}`);
}
async function walk(dir, rel = "") {
  const items = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name, full = path.join(dir, e.name);
    if (e.isDirectory()) items.push(...(await walk(full, r)));
    else if (e.isFile()) items.push({ path: r, content: (await readFile(full)).toString("base64") });
  }
  return items;
}

try {
  const res = await fetch(`${base}/source/${PROJECT_ID}/${BUILD_ID}`, { headers: auth });
  if (!res.ok) throw new Error(`Source download failed (${res.status})`);
  const src = await res.json();
  if (src.framework !== "react-vite" || !Array.isArray(src.files)) throw new Error("Unsupported project");
  await rm(ws, { recursive: true, force: true }); await mkdir(ws, { recursive: true });
  for (const f of src.files) {
    const dest = safe(f.path) && inside(ws, f.path);
    if (!dest) throw new Error(`Unsafe path rejected: ${String(f.path).slice(0, 100)}`);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, f.encoding === "base64" ? Buffer.from(f.content, "base64") : f.content);
  }
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"]);
  run("npx", ["--no-install", "vite", "build", "--base=./", "--outDir", out, "--emptyOutDir"]);
  if (!(await stat(path.join(out, "index.html")).catch(() => null))) throw new Error("Build produced no index.html");
  const files = await walk(out);
  console.log(`built ${files.length} files`);
  await report({ ok: true, files });
} catch (e) {
  console.error(e.message);
  await report({ ok: false, error: e.message.slice(0, 4000) }).catch(() => {});
  process.exitCode = 1;
} finally {
  await rm(ws, { recursive: true, force: true }); await rm(out, { recursive: true, force: true });
}
