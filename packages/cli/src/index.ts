#!/usr/bin/env node
import { main } from "./main.js";

const code = await main(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  env: process.env,
  onInterrupt: (handler) => {
    process.on("SIGINT", handler);
    return () => process.off("SIGINT", handler);
  },
});
process.exitCode = code;
