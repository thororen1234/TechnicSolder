# Contributing

## Development Environment

The dev environment uses Docker with PostgreSQL and Redis. It runs on port 8080 to avoid conflicting with a production instance.

### Prerequisites

- Docker and Docker Compose v2
- Git

### Setup

```bash
git clone https://github.com/TechnicPack/TechnicSolder.git
cd TechnicSolder
docker compose -f compose.dev.yml up -d
```

The container entrypoint (`docker/dev-entrypoint.sh`) runs on every start and handles:

1. Installs all pnpm dependencies (including dev dependencies) and generates the Prisma clients
2. On first run only: creates a `.env` from `.env.example` with dev defaults (`APP_ENV=local`, `APP_DEBUG=true`, `DB_CONNECTION=pgsql`, `DB_HOST=postgres`, `CACHE_STORE=redis`, `SESSION_DRIVER=redis`, `QUEUE_CONNECTION=redis`) and generates an `APP_KEY`
3. Runs database migrations
4. Creates the initial admin user if there is no user yet
5. Rebuilds the frontend assets on change (`vite build --watch`) and restarts the server on change (`tsx watch`)

The `worker` and `scheduler` containers also run from the source with `tsx watch`, so they restart when the code changes.

Solder is then available at [http://localhost:8080](http://localhost:8080).

### Create the Admin User

The entrypoint creates an admin user on first boot, with email `admin@example.com` (or `SOLDER_INITIAL_ADMIN_EMAIL`) and a generated password printed to the container logs:

```bash
docker compose -f compose.dev.yml logs solder | grep "Generated password"
```

### How It Differs from Production

| | Production (`compose.yml`) | Development (`compose.dev.yml`) |
|---|---|---|
| Port | 80 | 8080 |
| Database | MariaDB | PostgreSQL |
| Source code | Compiled into the image (`dist/`) | Mounted from your checkout, run with `tsx watch` |
| Dev dependencies | Excluded (`--prod`) | Included |
| `APP_DEBUG` | `false` | `true` |
| `APP_ENV` | `production` | `local` |
| `node_modules` | Inside the image | Named volume (persists across rebuilds) |
| Cache/session | Valkey | Redis |

The named `node_modules` volume means dependencies live inside Docker, not on your host filesystem. This avoids cross-platform issues with native modules. PostgreSQL data is also persisted in a named `postgres_data` volume.

## Common Commands

All commands run inside the container via `docker compose -f compose.dev.yml exec -T solder`:

```bash
# Run the test suite
docker compose -f compose.dev.yml exec -T solder pnpm test

# Run a specific test file
docker compose -f compose.dev.yml exec -T solder pnpm test tests/Feature/build-health.test.ts

# Type checking
docker compose -f compose.dev.yml exec -T solder pnpm typecheck

# Install/update dependencies
docker compose -f compose.dev.yml exec -T solder pnpm install

# Run database migrations
docker compose -f compose.dev.yml exec -T solder pnpm solder:dev migrate

# Open a shell inside the container
docker compose -f compose.dev.yml exec solder bash
```

!!! tip
    You can alias `dc` to `docker compose -f compose.dev.yml` in your shell to save typing.

### Without Docker

You can also run Solder directly with Node.js 22+ and pnpm. After `pnpm install` and creating a `.env`:

```bash
pnpm start:dev   # web server, restarted on change (tsx watch)
pnpm dev         # Vite dev server with hot reload (writes public/hot)
pnpm run build   # build the frontend, generate Prisma clients and compile the server into dist/
```

## Code Layout

| Path | Contents |
|------|----------|
| `src/` | The server: `api/` and `web/` controllers, `models/`, `services/`, `mods/` (mod providers), `jobs/`, `http/` (middleware), `views/` (template helpers) |
| `resources/views/**/*.eta` | Eta templates |
| `resources/js/app.ts`, `resources/css/app.css` | Frontend entry points (Alpine.js, Tailwind CSS) |
| `prisma/` | Prisma schema |
| `src/database/migrations.ts` | Knex migrations, named to match the existing Laravel migrations |

## Testing

Tests use [Vitest](https://vitest.dev/) and live in `tests/Unit` and `tests/Feature` as `*.test.ts` files. Each test worker uses its own SQLite database, configured in `.env.testing`, so they don't touch your development database.

```bash
docker compose -f compose.dev.yml exec -T solder pnpm test
```

## Code Style

Run the type checker before submitting a pull request:

```bash
docker compose -f compose.dev.yml exec -T solder pnpm typecheck
```

### Frontend styles

Shared visual recipes live in `resources/css/app.css` under `@layer components`,
using the `ui-` prefix. Reuse these for controls, labels, checkboxes, buttons,
cards, alerts, table headings/dividers, and the shared blue badge. Keep native
HTML and Alpine bindings in the Eta templates.

```html
<input class="ui-control sm:w-64">
<button type="submit" class="ui-btn ui-btn-danger ui-btn-sm">Delete</button>
<div class="ui-card mt-6">...</div>
```

Keep page-specific spacing, layout, responsive widths, and exceptional states
as Tailwind utilities. Utilities override component-layer styles, including
hover/focus/dark declarations affecting the same property: replace complete
color recipes rather than leaving conflicting base colors behind. Preserve
existing differences such as solid auth buttons, tinted dark-mode admin
buttons, and alerts whose typography belongs to their children.

Do not reuse the forms plugin's `form-*` class names or introduce a template
partial just to wrap a styled native element. Preserve the dark-mode hex
background workaround for 1Password.

After stylesheet or template changes, run `pnpm run build` and update
`public/build` in every running preview/deployment that serves the changed
templates. A container with a separate build volume does not see host-built
assets. Verify both themes and relevant interactive states in the browser;
server tests alone cannot detect missing styles.


## Releases

1. Update `SOLDER_VERSION` in `src/config.ts` and the version example in `docs/api/read/root.md`.
2. Move the pending `CHANGELOG.md` entries under a dated `[X.Y.Z]` heading, leave an empty `[Unreleased]` section, and add the release comparison link.
3. Verify the changes and commit them as `chore: release vX.Y.Z`.
4. Create an **annotated tag** named `vX.Y.Z` with the exact annotation message **`Version X.Y.Z`**. The message is not the tag name or the release notes:

    ```bash
    git tag -a vX.Y.Z -m "Version X.Y.Z"
    ```

    Replace `X.Y.Z` with the release version.

5. Push the release commit and tag. The Release workflow creates the GitHub release using the matching `CHANGELOG.md` section as its release notes.
6. Confirm that the Release workflow succeeds and the published release targets the intended commit.

Do not rewrite or force-update published tags to correct their annotations. Apply corrections to future releases instead.

## Pull Requests

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run `pnpm test` and `pnpm typecheck`
5. Submit a pull request
