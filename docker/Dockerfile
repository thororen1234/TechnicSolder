FROM node:24.15.0-slim AS assets
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install
COPY vite.config.js ./
COPY resources/ resources/
RUN npm run build

FROM php:8.5-fpm
RUN apt-get update && apt-get install -y \
    unzip \
    libzip-dev \
    libpq-dev \
    && docker-php-ext-install bcmath pdo_mysql pdo_pgsql zip \
    && pecl install redis \
    && docker-php-ext-enable redis \
    && rm -rf /var/lib/apt/lists/* \
    && echo 'memory_limit = 256M' > /usr/local/etc/php/conf.d/memory.ini

COPY --from=composer:latest /usr/bin/composer /usr/bin/composer

WORKDIR /var/www/html

COPY . .

COPY --from=assets /app/public/build public/build

RUN composer install --no-dev --optimize-autoloader

RUN chown -R www-data:www-data storage bootstrap/cache

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

CMD ["/entrypoint.sh"]