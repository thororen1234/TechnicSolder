# Docker Setup

Docker is the recommended way to run Technic Solder. It packages the application and all its dependencies into containers, so there is nothing to install on the host beyond Docker itself.

## Prerequisites

- **Docker Engine** 20.10+ ([install guide](https://docs.docker.com/engine/install/))
- **Docker Compose** v2 (included with Docker Desktop; on Linux, install the [Compose plugin](https://docs.docker.com/compose/install/linux/))
- **Git**

## Quick Start

```bash
git clone https://github.com/TechnicPack/TechnicSolder.git
cd TechnicSolder
docker compose up -d
```

That's it. The first boot takes a minute or two while the image builds and the setup script runs. Once the database passes its health check and the other containers are running, Solder is ready at [http://localhost](http://localhost).

!!! tip "What happens on first boot"
    The entrypoint script (`docker/entrypoint.sh`) runs automatically and handles everything:

    1. Generates an `APP_KEY` on first start (unless you set `APP_KEY` yourself) and saves it in the `storage` volume at `storage/app_key`, so every service shares it
    2. Runs database migrations
    3. Creates the initial admin user if there is no user yet
    4. Starts the Solder web server on port 3000 inside the container, behind the nginx container

    Dependencies and frontend assets are built into the Docker image at build time. Subsequent boots skip the steps that have already been completed, so restarts are fast.

## Initial Admin User

On first boot, an admin user is created with email `admin@example.com` and a randomly generated password printed to the console. Check the container logs to find it:

```bash
docker compose logs solder | grep "Generated password"
```

To set specific credentials, add these to your `.env` file before the first boot:

```bash
SOLDER_INITIAL_ADMIN_EMAIL=admin@example.com
SOLDER_INITIAL_ADMIN_PASSWORD=your-secure-password
```

!!! warning
    Change these credentials immediately after your first login.

## Configuration

Configuration is done through environment variables. You have two options:

1. **Create a `.env` file** in the project root (recommended for most settings)
2. **Override individual variables** directly in `compose.yml` under the `solder` service's `environment` section

The `.env` file is loaded automatically by Docker Compose. Any variables you set there will be substituted into the `compose.yml` environment block.

### Key Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SOLDER_PORT` | `80` | Host port for the nginx container |
| `APP_URL` | `http://localhost` | Public URL where Solder is accessible |
| `APP_TIMEZONE` | `UTC` | Application timezone |
| `DB_DATABASE` | `solder` | MariaDB database name |
| `DB_USERNAME` | `solder` | MariaDB username |
| `DB_PASSWORD` | `solder` | MariaDB password |
| `SOLDER_REPO_LOCATION` | `/var/www/mods.example.com/` | Path or URL to your mod repository |
| `SOLDER_MIRROR_URL` | `http://mods.example.com/` | Public URL for mod downloads |
| `SOLDER_CORS_ORIGINS` | `*` | Allowed CORS origins |
| `SOLDER_ADVANCED_MODE` | `false` | Show advanced build UI settings; does not gate the API or saved overrides |
| `MAIL_ENABLED` | `false` | Enable email functionality |
| `QUEUE_CONNECTION` | `redis` | `redis` runs imports, exports and update checks in the worker container; `sync` runs them in the web request |
| `CURSEFORGE_API_KEY` | | Required to import mods and modpacks from CurseForge |

!!! note
    For a complete list of all environment variables and what they do, see the [Configuration reference](configuration.md).

### Example `.env` File

```bash
SOLDER_PORT=8080
APP_URL=https://solder.example.com
DB_PASSWORD=a-strong-database-password
SOLDER_MIRROR_URL=https://mods.example.com/
SOLDER_REPO_LOCATION=https://mods.example.com/
```

After changing environment variables, restart the stack to apply them:

```bash
docker compose up -d
```

## Architecture

The Docker stack consists of six containers:

| Container | Image | Role |
|-----------|-------|------|
| **nginx** | `nginx` | Reverse proxy on `SOLDER_PORT`, forwards requests to `solder:3000` (`docker/default.conf`) |
| **solder** | Built from `docker/Dockerfile` | Node.js application server, listening on port 3000 |
| **worker** | Same image as solder | Background worker for modpack imports, exports and update checks (`node dist/worker.js`) |
| **scheduler** | Same image as solder | Runs scheduled tasks such as the nightly mod update check (`node dist/scheduler.js`) |
| **mysql** | `mariadb` | MariaDB database with a health check |
| **redis** | `valkey/valkey` | Valkey (Redis-compatible) for caching, sessions, and queues |

The solder container depends on mysql (waits for its health check to pass) and redis (waits for it to start). The nginx container depends on solder. This ensures everything starts in the correct order.

### Data Persistence

- **Database files** are stored in `./docker/mysql/` on the host
- **Storage** (logs, waiting imports, finished exports and the generated `APP_KEY`) is kept in the named `storage` volume, mounted at `/app/storage`

The application itself lives in the image; the source directory is not mounted.

!!! note "Mod repository"
    If `SOLDER_REPO_LOCATION` is a filesystem path, mount that directory into the `solder` and `worker` containers at the same path. If you upload or import mods through Solder, it must be writable by uid 1000 (the image's `node` user).

!!! warning
    Do not delete the `docker/mysql/` directory unless you want to lose your database. Back it up regularly.

## Common Operations

### View Logs

```bash
# All containers
docker compose logs -f

# Specific container
docker compose logs -f solder
docker compose logs -f nginx
docker compose logs -f mysql
```

### Restart the Stack

```bash
docker compose restart
```

Or to fully recreate containers (e.g. after changing `compose.yml`):

```bash
docker compose up -d
```

### Open a Shell

```bash
docker compose exec solder bash
```

### Run Solder Commands

```bash
docker compose exec solder node dist/cli.js <command>
```

For example:

```bash
# Run any pending database migrations
docker compose exec solder node dist/cli.js migrate

# Check every modpack's latest build for mod updates now
docker compose exec solder node dist/cli.js check-updates
```

### Stop the Stack

```bash
docker compose down
```

!!! note
    `docker compose down` stops and removes containers but does **not** delete the database files in `docker/mysql/`. Your data is preserved.

### Rebuild the Image

If the Dockerfile changes (e.g. after a Solder update), rebuild with:

```bash
docker compose build --no-cache
docker compose up -d
```

## Updating Solder

To update to the latest version:

```bash
git pull
docker compose build --no-cache
docker compose up -d
```

The setup script will automatically run any new database migrations on boot.

## Development Setup

For development, use `compose.dev.yml`, which mounts your checkout into the containers, rebuilds the frontend and restarts the server when files change, keeps `node_modules` in a named volume (so it doesn't conflict with your host) and uses PostgreSQL instead of MariaDB:

```bash
docker compose -f compose.dev.yml up -d
```

The development stack is accessible on port **8080** by default. See [Contributing](../contributing.md) for details.

## HTTPS and Reverse Proxies

The default Docker setup serves Solder over HTTP on the configured `SOLDER_PORT`. For HTTPS, place a reverse proxy (such as [Caddy](https://caddyserver.com/), [Traefik](https://traefik.io/), or nginx with certbot) in front of the stack and set `APP_URL` to your `https://` address.

!!! tip
    If your reverse proxy terminates TLS, make sure it passes the `X-Forwarded-Proto` header so Solder knows the original request was HTTPS.

## Running the Image on Its Own (Kubernetes)

The Solder image runs as the non-root `node` user (uid 1000) and serves the whole app, including its static files, on port **3000**. It does not include a web server, so put your own reverse proxy or ingress in front of it (see `docker/default.conf` for the nginx settings the Compose stack uses, including the upload size and timeouts).

Serve the mod repository from a separate web server or container.

Run the worker and scheduler as extra containers from the same image, with the same environment, the mod repository volume, and a volume for `/app/storage` shared with the web container (uploaded imports and finished exports are passed between them there, and the generated `APP_KEY` is stored there unless you set `APP_KEY`). Pass their commands as arguments to the image's entrypoint (`args` in Kubernetes, not `command`) so they pick up the same `APP_KEY`:

| Container | Arguments | User |
|-----------|---------|------|
| web | (none) | `node` (1000) |
| worker | `node dist/worker.js` | `node` (1000) |
| scheduler | `node dist/scheduler.js` | `node` (1000) |

`GET /up` returns 200 once the app is running, for readiness and liveness probes. Migrations run before the server starts, so allow a few minutes on startup.
