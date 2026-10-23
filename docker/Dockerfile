FROM node:24.21.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS assets

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY vite.config.js ./
COPY resources/ resources/
RUN pnpm run build

FROM php:8.5-fpm@sha256:f665ad19c093eee54db3a03c89102d6828b1bbf4f327689e5947a8686c6585a1

RUN apt-get update && apt-get install -y \
    nginx \
    unzip \
    libzip-dev \
    libpq-dev \
    && rm /etc/nginx/sites-enabled/default \
    && ln -sf /dev/stdout /var/log/nginx/access.log \
    && ln -sf /dev/stderr /var/log/nginx/error.log \
    && docker-php-ext-install bcmath pdo_mysql pdo_pgsql zip \
    && pecl install redis \
    && docker-php-ext-enable redis \
    && rm -rf /var/lib/apt/lists/* \
    && echo 'memory_limit = 256M' > /usr/local/etc/php/conf.d/memory.ini \
    && printf 'upload_max_filesize = 512M\npost_max_size = 512M\n' > /usr/local/etc/php/conf.d/uploads.ini

COPY --from=composer:2.10.3@sha256:af98f42dfff7c68ba8d53c2164fd9fde1087b7d449514baa38c418b1f6bc4bac /usr/bin/composer /usr/bin/composer

WORKDIR /var/www/html

COPY . .

COPY --from=assets /app/public/build public/build

RUN composer install --no-dev --optimize-autoloader

RUN chown -R www-data:www-data storage bootstrap/cache

COPY docker/nginx.conf /etc/nginx/conf.d/solder.conf

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 80: the built-in nginx. 9000: PHP-FPM, for running your own web server in front instead.
EXPOSE 80 9000

CMD ["/entrypoint.sh"]
