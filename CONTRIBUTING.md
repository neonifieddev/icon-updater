# Contributing

Use Node.js 24 or newer and install dependencies with `npm ci`.

Before opening a pull request:

```sh
npm run format
npm run lint
npm test
npm run check
```

Keep changes focused. Add regression tests for behavior changes, especially authorization, scheduling, and credential handling. Tests use in-memory SQLite and mock network calls; do not put real API keys in fixtures.

## JavaScript style

Use the project's ESLint and Prettier configuration. The baseline follows the core conventions in the [Google JavaScript Style Guide](https://google.github.io/styleguide/jsguide.html), with Prettier handling formatting. This is a project convention, not strict Google-style certification.

- Two spaces, single quotes, semicolons, and an 80-column formatting target.
- ES modules with named exports. Framework entry points and tool configs may require default exports.
- `camelCase` for functions and local variables; `UPPER_SNAKE_CASE` for shared constants. Keep external API and database field names unchanged.
- Use descriptive names such as `session`, `studio`, and `componentId`. Keep abbreviations for familiar terms such as `id`, `env`, and `url`.
- Prefer `const`, use `let` for reassignment, and never use `var`.
- Use braces on every conditional and loop. Prefer guard clauses to deep nesting and avoid nested ternaries.
- Leave one blank line between functions and logical steps. Keep related declarations together; separate validation, database work, and returns. ESLint enforces the statement spacing, and Prettier preserves it.
- Group imports, constants, helpers, and handlers. Add short section comments only when they help navigate a larger module.
- Keep modules focused. Introduce a helper when it gives repeated or complicated behavior a useful name; avoid layers that only forward arguments.
- Comments explain constraints or tradeoffs. Do not narrate obvious statements.

ESLint checks correctness and control-flow conventions; Prettier owns whitespace and layout. CI runs both. Google's JavaScript guide is archived; this project deliberately stays in JavaScript rather than introducing a TypeScript migration for a style change.

Create a new migration when changing the database schema. Existing migration files may already be applied to live databases.

Use `.dev.vars` and `wrangler.local.jsonc` for local settings. Do not commit credentials, account IDs, database dumps, generated bundles, or diagnostic logs. Confirm the intended Cloudflare account and resources before running remote commands.

Pull requests should explain the behavior change and list the checks run. Include a screenshot for visible panel changes when available. Redact keys, tokens, and private server information.
