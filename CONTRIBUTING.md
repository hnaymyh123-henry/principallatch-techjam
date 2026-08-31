# Contributing

Keep changes focused, reproducible, and suitable for a three-day student
hackathon.

## Setup

```bash
npm ci
npm run check
```

The deterministic middleware proof needs no model credential:

```bash
npm run verify:demo
```

For the judged container-based Agent execution, follow
[docs/LOCAL_POC.md](docs/LOCAL_POC.md). Never commit a populated `.env`.

## Validate

```bash
npm run check
npm run verify:demo
```

## Pull requests

- Explain the behavior and reason for the change.
- Add tests for API, lifecycle, persistence, or Runtime changes.
- Update English documentation and `.env.example` when configuration changes.
- Use GitHub Flavored Markdown and relative repository links.
- Never commit credentials, local state, workspaces, generated mock content, or
  build output.
- Report security issues according to [SECURITY.md](SECURITY.md).
