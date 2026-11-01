#!/usr/bin/env node
// Entry point for the `taigent` bin and `npm run taigent`. In the repository Node >= 24 runs the TypeScript
// sources directly; installed under node_modules, where Node strips no types, it runs the build in dist/.
const installed = import.meta.url.includes('/node_modules/');
const { main } = await import(installed ? '../dist/cli.js' : '../src/cli.ts');

process.exitCode = await main(process.argv.slice(2));
