#!/usr/bin/env node
import { runCli } from '../src/cli.mjs';

try {
  runCli(process.argv.slice(2));
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
