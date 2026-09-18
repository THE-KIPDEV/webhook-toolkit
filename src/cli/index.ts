#!/usr/bin/env node
import { main } from "./main.js";

// `whtk sign … | head` closes stdout early: that is the reader's choice, not a crash.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });
}

main().then(
  (code) => {
    process.exitCode = code;
    // Let stdout drain, then make sure lingering keep-alive sockets do not hold the process.
    setTimeout(() => process.exit(code), 1000).unref();
  },
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
