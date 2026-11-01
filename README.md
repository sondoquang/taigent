# taigent

Headless toolkit for driving Taiga from AI agents: declarative manifests in git, applied by the `taigent`
CLI with a plan → review → apply workflow.

```sh
npm install
npm run taigent -- plan --project <slug>
npm run taigent -- apply --project <slug> --yes
npm test && npm run typecheck
```

See [docs/cli.md](docs/cli.md) for environment variables, manifest layout, JSON output and exit codes.

To use the Taigent agent skills (`taiga-*` and the `ask-taigent` router) in another project, run at its root:

```sh
npx skills add sondoquang/taigent
npm install -D github:sondoquang/taigent
```

Then, to check the
`TAIGA_*` variables, the CLI and the Taiga MCP server, run the `taiga-setup` skill (`/taiga-setup` in Claude Code,
`$taiga-setup` in Codex); details in
[docs/cli.md § Using the skills in another project](docs/cli.md#using-the-skills-in-another-project). Not sure
which skill or step fits? Ask `ask-taigent` (`/ask-taigent`, `$ask-taigent`).
