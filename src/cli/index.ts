#!/usr/bin/env node
import { main } from "./main.js";

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
