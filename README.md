# 🗺️ Updater

A Discord bot for scheduling the main icon of a Roblox experience. Open `/panel`, connect a studio, add a game, and upload your countdown artwork.

Runs on Cloudflare Workers with D1, Workers KV, and the Images binding. It uses Discord interactions over HTTP, so no persistent Discord connection or always-on PC is needed.

## Using the panel

| Action           | What it does                                                      |
| ---------------- | ----------------------------------------------------------------- |
| Studios          | Connect a Roblox API key, replace it, or disconnect a studio      |
| Add game         | Save a universe ID; the name is fetched from Roblox               |
| Overlays         | Upload a transparent square PNG for each countdown stage          |
| Preview          | See the combined icon without changing Roblox                     |
| Update now       | Apply one selected stage after processing and approval            |
| Schedule         | Attach a base icon and choose a launch date, time, and UTC offset |
| Status           | Check preparation, moderation, and verified updates               |
| Cancel countdown | Stop future updates and keep the current icon                     |

Countdown stages: **24h · 12h · 6h · 3h · 2h · 1h · 30m · 15m · NOW**.

Use square PNG overlays with transparent backgrounds. Base icons accept PNG or JPEG. Inputs are limited to 5 MB and 2048 × 2048; output is 512 × 512. Overlays cover the full canvas, with transparent areas revealing the base image.

Each Discord server has separate studios, games, and overlays. Administrators can manage their server's configuration; each private panel can only be operated by the person who opened it. Panels expire after 24 hours.

## Setup

### Requirements

- Node.js 24 or newer for local tools and tests
- A Discord application and bot token
- A Cloudflare account with Workers, D1, KV, and Images access
- A Roblox account authorized to manage the target experiences and assets

### 1. Install and configure

```sh
npm ci
```

Copy `.dev.vars.example` to `.dev.vars`, and `wrangler.jsonc` to `wrangler.local.jsonc`. Both local files are ignored by Git. The npm scripts automatically use `wrangler.local.jsonc` when present; the committed config is a template for fresh installations and CI.

In the [Discord Developer Portal](https://discord.com/developers/applications), create an application and bot. Fill in:

| Setting                  | Where                                             |
| ------------------------ | ------------------------------------------------- |
| `DISCORD_TOKEN`          | `.dev.vars` only                                  |
| `DISCORD_APPLICATION_ID` | Both local files                                  |
| `DISCORD_PUBLIC_KEY`     | Both local files                                  |
| `DISCORD_GUILD_ID`       | `.dev.vars`; server used for command registration |
| `ALLOWED_GUILD_IDS`      | Both local files; comma-separated server IDs      |

Keep `ALLOW_SERVER_ADMINS=true` to allow server administrators. `ALLOWED_USER_IDS` optionally allows specific users; Discord's command permissions must also grant them access. An empty server allowlist denies access.

Invite the app with the `bot` and `applications.commands` scopes. Give it View Channels, Send Messages, and Attach Files in the channel where it will be used. It does not need Administrator permission or privileged Gateway intents.

### 2. Create Cloudflare resources

```sh
npx wrangler login
node scripts/wrangler.js d1 create icon-countdown
node scripts/wrangler.js kv namespace create FILES
```

Set the returned D1 database ID and KV namespace ID in `wrangler.local.jsonc`. If you have multiple Cloudflare accounts, add the intended `account_id` to that file. Keep the `DB`, `FILES`, and `IMAGES` binding names unchanged.

```sh
npm run db:remote
node scripts/setup-encryption.js --upload
node scripts/wrangler.js secret put DISCORD_TOKEN
npm run check
npm run deploy
```

The encryption script generates a random `STUDIO_ENCRYPTION_KEY`, saves it in `.dev.vars`, and uploads it as a Worker secret. Back up this key securely: replacing it makes existing encrypted studio credentials unreadable. The Discord token command prompts for the token. Values in `.dev.vars` are not automatically deployed.

### 3. Connect Discord

Set **Interactions Endpoint URL** in the Developer Portal to the deployed Worker's URL followed by `/interactions`:

```text
https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/interactions
```

Then register the command:

```sh
npm run register
```

Registration creates `/panel` and removes only this project's retired commands. Other application commands are preserved. To add another server, invite the bot, add its ID to `ALLOWED_GUILD_IDS`, deploy, and register with that server's `DISCORD_GUILD_ID`.

### 4. Connect Roblox

Create a key in [Creator Dashboard](https://create.roblox.com/dashboard/credentials) with access to the intended experiences and these permissions:

| Scope                    | Purpose                                          |
| ------------------------ | ------------------------------------------------ |
| `asset:read`             | Read place assets, uploads, and moderation state |
| `asset:write`            | Upload images and update the root place icon     |
| `universe:read`          | Resolve the experience name and root place       |
| `legacy-universe:manage` | Inspect localized icon overrides                 |

Group resources also require the appropriate permissions on the account creating the key. See [Roblox API keys](https://create.roblox.com/docs/cloud/auth/api-keys).

Use `/panel` → **Studios** → **Connect studio**, then **Add game**. Keys are encrypted with AES-GCM, bound to the server and studio, and never shown in responses. The Discord form submits privately, but the input is not a masked password field.

## Scheduling and limits

Schedule at least 15 minutes ahead, or more than 24 hours ahead for the full countdown. Dates need a UTC offset for the launch date. Late starts include the currently applicable stage and future stages; expired stages are not replayed.

- Up to 10 studios and 25 games per server
- Up to 3 active schedules across the deployment
- One active schedule per universe
- Cron checks roughly once a minute
- Images must pass Roblox moderation before being applied
- The NOW icon remains until another update replaces it

This changes the **main square experience icon**, using an image asset upload followed by a root-place asset PATCH with `updateMask=icon`. Localized icon overrides are checked but never changed. Conflicting overrides must be removed in Creator Dashboard first.

A successful update requires matching root-place metadata and public game/image renders. Processing, moderation, and caching can delay visibility. Cancellation does not undo a request already sent to Roblox or restore a previous icon.

D1 stores jobs, operations, retries, and notification state. KV stores immutable input images and generated icons, so replacing an overlay does not change an existing countdown. Jobs resume after Worker restarts, retry temporary failures, and skip outdated stages. A database lease prevents normal overlapping scheduler runs.

There is no automatic storage cleanup. Uploaded files and history accumulate. A crash between an accepted Roblox upload and saving its operation ID can leave an extra image asset on retry.

## Hosting costs

The bot uses no R2 bucket and does not change your Cloudflare plan. Check the account's plans and quotas before deployment. Application limits do not cap an account's bill, and free-tier limits can interrupt processing.

See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/), and [Images pricing](https://developers.cloudflare.com/images/pricing/).

## Development

```sh
npm test
npm run lint
npm run format:check
npm run check
npm run db:local
npm run dev
```

Run `npm run format` to format the code and `npm run lint` to check it. CI runs lint, formatting checks, tests, and a Worker build on Node.js 24. It does not deploy or require production credentials. Naming and structure conventions are documented in [CONTRIBUTING.md](CONTRIBUTING.md#javascript-style).

Tests use in-memory SQLite with the actual migrations and mocked external services. They cover server isolation, credential encryption, signature verification, scheduling, cancellation, and main-icon verification. Compositing also needs a real Images binding; local emulation may not support every operation. Use separate development resources for remote testing.

| Directory                                 | Contents                                                     |
| ----------------------------------------- | ------------------------------------------------------------ |
| `src/worker.js`                           | Discord request verification and HTTP responses              |
| `src/panel.js`, `src/panel-components.js` | Panel navigation and forms                                   |
| `src/commands.js`                         | Overlay, preview, schedule, status, and cancellation actions |
| `src/connections.js`                      | Studio credentials and legacy configuration import           |
| `src/scheduler.js`                        | Persisted preparation and application jobs                   |
| `src/roblox.js`, `src/game-names.js`      | Roblox API calls and name resolution                         |
| `migrations/`                             | D1 schema migrations; add new files for future changes       |
| `scripts/`                                | Deployment tools, encryption setup, command registration     |
| `test/`                                   | Automated tests                                              |

`Set-RobloxGameIcon.ps1` is a separate PowerShell 7 utility. It requires an explicit `-RootPlaceId`, an image path or asset ID, and `ROBLOX_API_KEY` in the environment. It verifies place metadata; the bot additionally verifies the public icon render.

### Existing installations

The optional `ROBLOX_API_KEY`, `ALLOWED_UNIVERSE_IDS`, and `UNIVERSE_ROOT_PLACES` settings support importing the original single-game setup. Import is limited to the first allowed server. New installations can leave them empty and connect studios through the panel.

## Repository hygiene

Keep `.dev.vars`, `wrangler.local.jsonc`, database exports, and diagnostic logs out of commits. The committed examples contain no deployment-specific IDs or credentials. See [CONTRIBUTING.md](CONTRIBUTING.md) for checks before opening a pull request.

No open-source license has been selected for this repository.
