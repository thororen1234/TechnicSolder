#!/bin/sh
set -e

cd /app

# Without arguments: migrate, create the first admin user and serve the web app.
# With arguments (the worker and scheduler services): run that command with the same APP_KEY.

if [ -z "$APP_KEY" ]; then
    # Generate an APP_KEY on first run and keep it in the storage volume. Set APP_KEY yourself to keep an
    # existing install's key: it decrypts stored two-factor secrets.
    if [ ! -f storage/app_key ]; then
        if [ "$#" -gt 0 ]; then
            # Let the web service generate it, so every service shares one key
            echo "Waiting for the solder service to generate APP_KEY..."
            while [ ! -s storage/app_key ]; do sleep 1; done
        else
            node dist/cli.js key:generate > storage/app_key.tmp
            mv storage/app_key.tmp storage/app_key
            echo "Generated APP_KEY and saved it to storage/app_key"
        fi
    fi
    APP_KEY=$(cat storage/app_key)
    export APP_KEY
fi

if [ "$#" -gt 0 ]; then
    exec "$@"
fi

node dist/cli.js migrate

# Create the default admin user if there is no user yet
node dist/cli.js setup --no-interaction

exec node dist/main.js
