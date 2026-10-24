# Bare-Metal Installation

!!! tip "Docker is the recommended approach"
    The fastest way to get Solder running is with Docker. See the [Docker setup guide](docker.md) for a streamlined installation that handles dependencies, migrations, and initial setup automatically.

This guide walks through installing Technic Solder directly on a Linux server.

!!! warning
    Solder must be installed on a server that is always running and online. If your Solder instance is not reachable, your modpack will not be available in the Technic Launcher.

!!! note
    Running Solder on Windows is not supported and no help will be provided.

## Requirements

- **Git**
- **Node.js >= 22** ([nodejs.org](https://nodejs.org/))
- **pnpm** ([pnpm.io](https://pnpm.io/installation)), easiest through corepack, which ships with Node.js
- **A MariaDB, MySQL, PostgreSQL, or SQLite database**
- **Redis** (optional; needed for background jobs, and to share the cache and sessions between processes)

### Example: Ubuntu 24.04

```bash
# Node.js 22 from NodeSource: https://github.com/nodesource/distributions
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install git nodejs

# Use the pnpm version pinned in Solder's package.json
sudo corepack enable
```

## Installing Solder

Clone the repository and install dependencies:

```bash
git clone https://github.com/TechnicPack/TechnicSolder.git
cd TechnicSolder
pnpm install --frozen-lockfile
```

## Configuring Solder

Solder is configured through a `.env` file. Create one from the example:

```bash
cp .env.example .env
```

Open `.env` in your text editor and update the variables listed below. Leave any variables not in this table at their default values.

| Variable | Description |
|----------|-------------|
| `APP_URL` | The URL where Solder will be accessible (e.g. `https://solder.example.com`). |
| `DB_CONNECTION` | Database type: `mariadb`, `mysql`, `pgsql`, or `sqlite`. |
| `DB_HOST` | Database server IP. Use `127.0.0.1` if running on the same server. |
| `DB_PORT` | Database port. `3306` for MySQL/MariaDB, `5432` for PostgreSQL. |
| `DB_DATABASE` | Name of your database. For SQLite, the path to the database file, relative to the Solder directory (e.g. `storage/solder.sqlite`). |
| `DB_USERNAME` | Database username. |
| `DB_PASSWORD` | Database password. |
| `CACHE_STORE` | Cache backend. Use `redis` (recommended) if you have a Redis server; any other value keeps the cache in memory. |
| `SESSION_DRIVER` | Session backend. Use `redis` if you have a Redis server; any other value keeps sessions in memory, so everyone is logged out when Solder restarts. |
| `REDIS_HOST` | Redis server IP (if using Redis). |
| `REDIS_PASSWORD` | Redis password, if one is set. |
| `REDIS_PORT` | Redis server port (default `6379`). |
| `SOLDER_REPO_LOCATION` | Path or URL to your mod repository (see below). |
| `SOLDER_MIRROR_URL` | Web-accessible URL to your mod repository (see below). |
| `SOLDER_MD5_CONNECT_TIMEOUT` | Seconds to wait before giving up on a remote MD5 checksum calculation. |

### Repository location and mirror URL

- **`SOLDER_REPO_LOCATION`** points to where your mod files are stored. If Solder is on the same server as your mod repository, use the absolute filesystem path (e.g. `/var/www/mods/`). This is faster because MD5 checksums are calculated locally. If your mods are hosted elsewhere, use the web-accessible URL instead. A trailing slash is recommended but will be added automatically if omitted.

- **`SOLDER_MIRROR_URL`** is the web-accessible URL that players' launchers will use to download mods (e.g. `https://mods.example.com/`). If you used a URL for the repo location, you can use the same value here. A trailing slash is recommended but will be added automatically if omitted.

## Build Solder

Build the frontend assets (into `public/build`), generate the Prisma database clients, and compile the server into `dist/`:

```bash
pnpm run build
```

## Generate Application Key

Solder requires an encryption key to function. Generate one:

```bash
pnpm solder key:generate
```

This prints a new key. Copy it into the `APP_KEY` value in your `.env` file.

!!! warning
    Don't change this key later: it decrypts stored two-factor authentication secrets.

## Database Setup

Create a database for Solder. The default `DB_DATABASE` in `.env.example` is `solder`. Use any name as long as it matches `DB_DATABASE` in your `.env`. SQLite needs no setup; the database file is created automatically.

Instructions for creating the database vary by database server and are not covered here.

Once your database is ready, run the migration to create all required tables:

```bash
pnpm solder migrate
```

## Initial Setup

After migrating, run the setup command to create the initial admin user:

```bash
pnpm solder setup
```

This will interactively prompt for an email and password. Pass `--username=name` to choose the admin's username.

In non-interactive mode (`--no-interaction` or `-n`, e.g. in scripts), a random password is generated and printed to the console. You can provide credentials via environment variables instead:

```bash
SOLDER_INITIAL_ADMIN_EMAIL=admin@example.com
SOLDER_INITIAL_ADMIN_PASSWORD=your-secure-password
```

!!! warning
    Change these credentials immediately after your first login.

## Starting Solder

Start the web server:

```bash
pnpm start
```

Solder listens on port `3000` by default (set `PORT` to change it) and serves its static files from `public/` itself. Use a process manager such as systemd or pm2 to keep it running and start it on boot.

## Web Server Configuration

Put a web server (nginx, Apache, or Caddy) in front of Solder as a reverse proxy to `http://127.0.0.1:3000`. It handles HTTPS and the large uploads used by modpack imports.

See [Example Web Server Configs](../guides/web-server-configs.md) for complete nginx, Apache, and Caddy configuration examples.

### File permissions

The user running Solder needs:

- **Read** access to the entire Solder directory
- **Read and write** access to `storage/`
- **Read and write** access to the mod repository, if you upload or import mods through Solder

```bash
# Example: set ownership to a dedicated solder user
sudo chown -R solder:solder /path/to/TechnicSolder/storage
```

### HTTPS

If you use HTTPS (recommended), make sure `APP_URL` in your `.env` starts with `https://`.

!!! warning
    If Solder is behind a load balancer or reverse proxy that terminates TLS (e.g. Cloudflare), make sure it forwards the `X-Forwarded-Proto` header. See the [web server configs guide](../guides/web-server-configs.md) for details.

## Background Jobs

Modpack imports, exports and build update checks can take several minutes for large packs. By default
(`QUEUE_CONNECTION=sync`) they run inside the web request, so the page waits until they finish.

To run them in the background with a progress page, set `QUEUE_CONNECTION=redis` in `.env` (this needs Redis, so
set `CACHE_STORE=redis` and `SESSION_DRIVER=redis` too) and keep a worker running, for example with systemd or pm2:

```bash
pnpm worker
```

Restart the worker after updating Solder so it loads the new code.

Solder also checks every modpack's latest build for mod updates each night at 04:00 (in `APP_TIMEZONE`; turn this off
with `SOLDER_SCHEDULED_UPDATE_CHECKS=false`) and cleans up abandoned imports daily. Keep the scheduler running for this:

```bash
pnpm scheduler
```

To run the update check once by hand, use `pnpm solder check-updates`.

Set `SOLDER_DISCORD_WEBHOOK` to post the results (and finished imports, published builds and repository problems) to a Discord channel.

To get them as direct messages instead, create an application in the [Discord Developer Portal](https://discord.com/developers/applications), copy its bot token into `SOLDER_DISCORD_BOT_TOKEN` and add the bot to a server you're in (Discord only lets bots message users they share a server with). Then turn on Developer Mode in Discord, right-click your name, choose **Copy User ID** and put it in `SOLDER_DISCORD_USER_ID`. Separate several IDs with commas. Use **Send test message** under Settings to check it works.

## Keeping Solder Updated

Solder's dependencies are frequently updated. Set up a cron job (or similar) to keep them current:

```bash
cd /path/to/TechnicSolder && git pull && pnpm install --frozen-lockfile && pnpm run build && pnpm solder migrate
```

Then restart Solder (and the worker and scheduler, if you run them). See [Updating Solder](../guides/updating.md) for details.
