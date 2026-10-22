#!/bin/bash
set -e

cd /var/www/html

# Install dependencies if needed (first run)
if [ ! -d vendor ]; then
    composer install --no-dev --no-interaction
fi

# Generate and persist APP_KEY on first run
if [ ! -f .env ]; then
    echo "APP_KEY=" > .env
    php artisan key:generate --force
fi

# Run migrations
php artisan migrate --force -n

# Create default admin user if none exists
php artisan solder:setup --no-interaction

# Warn if frontend assets are missing (e.g. volume-mounted source without a prior build)
if [ ! -d public/build ]; then
    echo "WARNING: public/build/ is missing — frontend assets have not been built."
    echo "Run 'pnpm install --frozen-lockfile && pnpm run build' on the host or inside a Node container."
fi

# Ensure the web server can write to storage and cache
chgrp -R www-data storage bootstrap/cache
find storage bootstrap/cache -type d -exec chmod 775 {} \;
find storage bootstrap/cache -type f -exec chmod 664 {} \;

# Serve the app with nginx on port 80. PHP-FPM also listens on 9000 for setups with their own web server.
# If either stops, stop the other and exit so the container is restarted.
php-fpm &
nginx -g 'daemon off;' &
# Pass stop signals on; the base image stops containers with SIGQUIT, which both shut down gracefully on
for signal in TERM INT QUIT; do
    trap "kill -$signal \$(jobs -p) 2>/dev/null" "$signal"
done
status=0
wait -n || status=$?
kill -TERM $(jobs -p) 2>/dev/null || true
wait
exit $status
