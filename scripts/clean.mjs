// Cross-platform `rm -rf <dir>` for npm scripts.
import { rmSync } from "node:fs";

for (const dir of process.argv.slice(2)) rmSync(dir, { recursive: true, force: true });
