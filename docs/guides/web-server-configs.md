# Web Server Configuration

This guide provides nginx, Apache, and Caddy configurations for both the Solder application and the mod repository.

!!! info "Docker users can skip this"
    If you are running Solder with Docker, the bundled web server is already configured. These examples are only needed for bare-metal installations.

## Solder Application

Solder runs its own HTTP server (`pnpm start`, port `3000` by default) and serves its static files itself, so the web server only needs to reverse-proxy every request to it. Allow large request bodies and long timeouts: modpack imports upload large archives, and importing or exporting a pack downloads every mod. The nginx config used by the Docker stack is in `docker/default.conf`.

=== "nginx"

    ```nginx
    server {
        listen 80;
        listen [::]:80;
        server_name solder.example.com;

        access_log /var/log/nginx/solder.example.com_access.log;
        error_log  /var/log/nginx/solder.example.com_error.log;

        # Modpack archives can be large, and importing or exporting one downloads every mod
        client_max_body_size 512m;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;

        location / {
            proxy_pass http://127.0.0.1:3000;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_set_header X-Forwarded-Host $host;
            # Stream uploads to Solder instead of buffering them on disk first
            proxy_request_buffering off;
        }
    }
    ```

=== "Apache"

    Requires `mod_proxy` and `mod_proxy_http`:

    ```bash
    sudo a2enmod proxy proxy_http headers
    sudo systemctl restart apache2
    ```

    ```apache
    <VirtualHost *:80>
        ServerName solder.example.com
        ServerAdmin admin@example.com

        # Modpack archives can be large, and importing or exporting one downloads every mod
        LimitRequestBody 536870912
        ProxyTimeout 3600

        ProxyPreserveHost On
        ProxyPass        / http://127.0.0.1:3000/
        ProxyPassReverse / http://127.0.0.1:3000/
        RequestHeader set X-Forwarded-Proto expr=%{REQUEST_SCHEME}

        ErrorLog ${APACHE_LOG_DIR}/solder_error.log
        CustomLog ${APACHE_LOG_DIR}/solder_access.log combined
    </VirtualHost>
    ```

=== "Caddy"

    ```caddy
    solder.example.com {
        request_body {
            max_size 512MB
        }

        reverse_proxy 127.0.0.1:3000 {
            transport http {
                read_timeout 3600s
                write_timeout 3600s
            }
        }
    }
    ```

    Caddy's `reverse_proxy` forwards the `Host`, `X-Forwarded-For` and `X-Forwarded-Proto` headers automatically. Caddy also provisions and renews TLS certificates automatically; see the [HTTPS](#https) section below.

## Mod Repository

The repository server block serves mod zip files as static downloads. The nginx config enables directory listing so you can browse available files; Apache achieves the same with `+Indexes`.

=== "nginx"

    ```nginx
    server {
        listen 80;
        listen [::]:80;
        server_name repo.example.com;

        access_log /var/log/nginx/repo.example.com_access.log;
        error_log  /var/log/nginx/repo.example.com_error.log;

        root /var/www/repo;

        location / {
            try_files $uri $uri/ =404;
            autoindex on;
            autoindex_exact_size off;
            autoindex_localtime on;
        }

        # Deny access to hidden files (except .well-known for ACME challenges)
        location ~ /\.(?!well-known).* {
            deny all;
            access_log off;
            log_not_found off;
            return 404;
        }
    }
    ```

=== "Apache"

    ```apache
    <VirtualHost *:80>
        ServerName repo.example.com
        ServerAdmin admin@example.com
        DocumentRoot /var/www/html/repo/

        <Directory /var/www/html/repo>
            Options +Indexes +FollowSymLinks
            AllowOverride All
            Require all granted
        </Directory>

        ErrorLog ${APACHE_LOG_DIR}/solder_repo_error.log
        CustomLog ${APACHE_LOG_DIR}/solder_repo_access.log combined
    </VirtualHost>
    ```

=== "Caddy"

    ```caddy
    repo.example.com {
        root * /var/www/repo
        file_server browse
    }
    ```

    The `browse` argument enables directory listing, equivalent to nginx's `autoindex on` or Apache's `+Indexes`.

## Apache Modules

The Apache configuration above requires these modules:

1. **`mod_proxy`** and **`mod_proxy_http`** — forward requests to Solder's HTTP server.
2. **`mod_headers`** — sets the `X-Forwarded-Proto` header so Solder knows whether the original request used HTTPS.

`mod_proxy_http` adds the `X-Forwarded-For` and `X-Forwarded-Host` headers itself. All three modules are enabled in the vhost setup instructions above.

## HTTPS

All production deployments should use HTTPS.

### Caddy

Caddy provisions and renews TLS certificates from Let's Encrypt automatically — no extra steps are needed. As long as your domain's DNS points to the server, Caddy handles everything when you use a domain name in your Caddyfile (as shown in the examples above).

If Caddy is running behind another reverse proxy or load balancer, see the [Reverse Proxy / Load Balancer](#reverse-proxy-load-balancer) section below.

### Certbot / Let's Encrypt

The simplest option is to use [Certbot](https://certbot.eff.org/) to obtain a free TLS certificate from Let's Encrypt:

```bash
# nginx
sudo certbot --nginx -d solder.example.com -d repo.example.com

# Apache
sudo certbot --apache -d solder.example.com -d repo.example.com
```

Certbot will automatically modify your server blocks / vhosts to listen on port 443 and redirect HTTP to HTTPS.

### Reverse Proxy / Load Balancer

If Solder sits behind a reverse proxy or load balancer that terminates TLS, the application itself runs on plain HTTP but needs to know that external traffic is encrypted. Configure two things:

1. **Set `APP_URL` to `https://`** in your `.env` file:

    ```ini
    APP_URL=https://solder.example.com
    ```

2. **Tell Solder that HTTPS is active.** If the TLS-terminating proxy sits in front of your nginx or Apache, pass its `X-Forwarded-Proto` header on instead of replacing it with the local scheme. In nginx, change the header line in the Solder server block:

    ```nginx
    proxy_set_header X-Forwarded-Proto https;
    ```

    For Apache, change the `RequestHeader` line inside your `<VirtualHost>` block:

    ```apache
    RequestHeader set X-Forwarded-Proto https
    ```

!!! tip
    Make sure your reverse proxy forwards the `X-Forwarded-For` and `X-Forwarded-Proto` headers so Solder can correctly detect the client IP and protocol. Solder trusts these proxy headers, so don't expose port 3000 directly to the internet.
