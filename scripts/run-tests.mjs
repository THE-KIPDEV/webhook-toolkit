// Runs every compiled test file with the built-in node:test runner.
// Explicit file paths (instead of globs) keep this working on Node 18.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../.test-dist/test", import.meta.url));

function collect(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return collect(full);
    return name.endsWith(".test.js") ? [full] : [];
  });
}

const files = collect(root).sort();
if (files.length === 0) {
  console.error("No compiled tests found. Run `npm test` (the pretest step compiles them).");
  process.exit(1);
}
// --test-timeout exists from Node 20.11; older runtimes rely on per-test timeouts.
const [major, minor] = process.versions.node.split(".").map(Number);
const timeout = major > 20 || (major === 20 && minor >= 11) ? ["--test-timeout=60000"] : [];
const res = spawnSync(process.execPath, ["--test", ...timeout, ...files], { stdio: "inherit" });
process.exit(res.status ?? 1);
