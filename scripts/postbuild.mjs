// Make the CLI entry executable when running from a local checkout
// (npm sets the bit itself on install).
import { chmodSync } from "node:fs";

chmodSync(new URL("../dist/cli/index.js", import.meta.url), 0o755);
