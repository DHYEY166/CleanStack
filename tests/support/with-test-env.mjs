#!/usr/bin/env node
// Run a command with the integration/e2e environment (tests/support/test-env.mjs).
//   node tests/support/with-test-env.mjs next build
import { spawn } from "node:child_process";
import { testEnv } from "./test-env.mjs";

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) { console.error("usage: with-test-env.mjs <command> [args...]"); process.exit(2); }
const child = spawn(cmd, args, { stdio: "inherit", env: { ...process.env, ...testEnv() }, shell: process.platform === "win32" });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
