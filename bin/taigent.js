#!/usr/bin/env node
// Entry point for the `taigent` bin and `npm run taigent`. Node >= 24 runs the TypeScript sources directly.
import { main } from '../src/cli.ts';

process.exitCode = await main(process.argv.slice(2));
