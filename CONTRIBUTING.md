# Contributing

## Development

```bash
npm install
npm test
npm run pack:check
```

## Principles

- Do not modify DSH. Integrate through its local Web interface.
- Default deny unknown RPC methods and event types.
- Never commit runtime credentials, sessions, logs, workspaces, or shared data.
- Prefer small modules and node:test coverage.
- Treat all protocol additions as security-sensitive.

## Reporting security issues

Do not open a public issue with exploit details. Contact the maintainers privately first.
