# Docker

This project ships two separate Compose stacks. They are NOT layered; each runs on its own.

- Development: `compose.dev.yml` (PostgreSQL). The standalone stack for all local work.
- Production: `compose.yml` (MariaDB). The shipped self-host stack; not for development.

## Development workflow

- Start: `docker compose -f compose.dev.yml up -d` (app at http://localhost:8080)
- Stop: `docker compose -f compose.dev.yml down`
- Run commands: `docker compose -f compose.dev.yml exec -T solder <cmd>` works once the stack is up, e.g. `pnpm test` or `pnpm solder:dev migrate`.
- The `solder` service mounts the source at `/app`, rebuilds the frontend with `vite build --watch` and restarts the server with `tsx watch`; `worker` and `scheduler` also run under `tsx watch`.

## Never do this

- Never run `docker compose up` with no `-f`. That starts the production MariaDB stack.
- Never merge the two files (`-f compose.yml -f compose.dev.yml`). The merge pulls MariaDB and the production
  env-injection block into dev, which runs two databases at once and points the app at the wrong one.
- The dev `solder` service injects no env vars by design; it reads the mounted `.env`, and tests use
  `.env.testing` (a SQLite database per test worker). Do not add an `environment:` block to it.
