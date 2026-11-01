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
