# Troubleshooting

## Checking Logs

The first step when debugging any issue is to check the logs.

**Solder log** -- the main application log lives at (it is also written to the console):

```
storage/logs/solder.log
```

In Docker, you can tail it directly:

```bash
docker compose exec solder tail -f storage/logs/solder.log
```

**Docker container logs** -- to see stdout/stderr output from the Solder containers:

```bash
docker compose logs -f solder worker scheduler
```

**Enable debug mode** -- for more detailed error messages, set `APP_DEBUG=true` in your `.env` file:

```dotenv
APP_DEBUG=true
```

!!! danger
    Never leave `APP_DEBUG=true` in production. Debug mode exposes sensitive information including environment variables, database credentials, and full stack traces to anyone who triggers an error.

## Common Issues

### Permission Errors in `storage/`

Solder writes logs, waiting imports and finished exports to `storage/`. If it fails with `EACCES` errors, make sure the user running Solder (the one running `pnpm start` and `pnpm worker`) owns that directory:

```bash
sudo chown -R solder:solder /path/to/TechnicSolder/storage
```

!!! note "Docker"
    In Docker, `storage/` is a named volume owned by the image's `node` user, so you should not need to fix its permissions manually. The mod repository is different: if you mount it into the `solder` and `worker` containers for uploads or imports, it must be writable by uid 1000.

### "MD5 hashing failed"

When adding or rehashing a mod version, Solder computes an MD5 checksum of the zip file. If this fails, check the following:

- **`SOLDER_REPO_LOCATION` is incorrect** -- this must point to the directory (or URL) that contains your mod files. Include a trailing slash.
- **`SOLDER_MIRROR_URL` doesn't match the actual download URL** -- the mirror URL is what the launcher uses to download files. It must be publicly accessible and point to the same repository.
- **Solder can't read the mod files** -- ensure the user running Solder has read access to the repository directory (in Docker, it must be mounted into the `solder` and `worker` containers).
- **The file doesn't exist at the expected path** -- Solder expects mod files at:

    ```
    [repo]/mods/[slug]/[slug]-[version].zip
    ```

    For example, if `SOLDER_REPO_LOCATION=/var/www/repo/`, a mod with slug `buildcraft` at version `7.1.23` should be at:

    ```
    /var/www/repo/mods/buildcraft/buildcraft-7.1.23.zip
    ```

### Connection Issues in Docker

If the application fails to connect to the database or cache, start by checking that all containers are running:

```bash
docker compose ps
```

All services should show a status of `Up` or `healthy`.

- **Database not ready** -- the Solder container waits for the database health check to pass before starting the application. If migrations fail on first boot, restart the stack with `docker compose down && docker compose up -d`.
- **Redis/Valkey connection refused** -- verify the `redis` service is running with `docker compose ps`. If using a custom Redis host, make sure `REDIS_HOST` and `REDIS_PORT` in your `.env` match the actual service.

### "Cannot find module" Errors

If you see errors about missing modules or the Prisma client after updating or changing branches, reinstall the dependencies and rebuild:

```bash
pnpm install --frozen-lockfile
pnpm run build
```

In Docker, rebuild the image:

```bash
docker compose up -d --build
```
