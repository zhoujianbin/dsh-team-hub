#!/usr/bin/env node
import { runCli } from "../src/cli.mjs";

runCli(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
