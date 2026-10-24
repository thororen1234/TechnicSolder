#!/bin/sh
set -e

cd /app

pnpm install --frozen-lockfile
pnpm run prisma:generate

# Generate .env for development if it doesn't exist
if [ ! -f .env ]; then
    cp .env.example .env
    sed -i 's/^APP_ENV=.*/APP_ENV=local/' .env
    sed -i 's/^APP_DEBUG=.*/APP_DEBUG=true/' .env
    sed -i 's/^DB_CONNECTION=.*/DB_CONNECTION=pgsql/' .env
    sed -i 's/^DB_HOST=.*/DB_HOST=postgres/' .env
    sed -i 's/^DB_PORT=.*/DB_PORT=5432/' .env
    sed -i 's/^DB_DATABASE=.*/DB_DATABASE=solder/' .env
    sed -i 's/^DB_USERNAME=.*/DB_USERNAME=solder/' .env
    sed -i 's/^DB_PASSWORD=.*/DB_PASSWORD=solder/' .env
    sed -i 's/^REDIS_HOST=.*/REDIS_HOST=redis/' .env
    sed -i 's/^CACHE_STORE=.*/CACHE_STORE=redis/' .env
    sed -i 's/^SESSION_DRIVER=.*/SESSION_DRIVER=redis/' .env
    sed -i 's/^QUEUE_CONNECTION=.*/QUEUE_CONNECTION=redis/' .env
    sed -i "s|^APP_KEY=.*|APP_KEY=$(pnpm --silent solder:dev key:generate)|" .env
fi

pnpm solder:dev migrate
pnpm solder:dev setup --no-interaction

mkdir -p storage/mods

# Rebuild the frontend on change in the background, and restart the server on change
pnpm exec vite build --watch &
exec pnpm start:dev
