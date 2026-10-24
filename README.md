Technic Solder
=============

[![License](https://img.shields.io/github/license/TechnicPack/TechnicSolder)](LICENSE)

[![Latest Release](https://img.shields.io/github/v/release/TechnicPack/TechnicSolder)](https://github.com/TechnicPack/TechnicSolder/releases/latest) [![Build Status](https://github.com/TechnicPack/TechnicSolder/actions/workflows/tests.yml/badge.svg?branch=main)](https://github.com/TechnicPack/TechnicSolder/actions/workflows/tests.yml)

Join us on [Discord][discord]!

What is Solder?
--------------

Technic Solder is an API that sits between a modpack repository and the launcher. It allows you to easily manage multiple modpacks in one single location. It's the same API we use to distribute our modpacks!

Using Solder also means your packs will download each mod individually. This means the launcher can check MD5's against each version of a mod and if it hasn't changed, use the cached version of the mod instead. What does this mean? Small incremental updates to your modpack doesn't mean redownloading the whole thing every time!

Solder also interfaces with the Technic Platform using an API key you can generate through your account there. When Solder has this key it can directly interact with your Platform account. When creating new modpacks you will be able to import any packs you have registered in your Solder install. It will also create detailed mod lists on your Platform page! (assuming you have the respective data filled out in Solder). Neat huh?

Requirements
-------------

* [Node.js](https://nodejs.org/) 22 or higher
* [pnpm](https://pnpm.io/installation) (via corepack: `corepack enable`)
* A MySQL, MariaDB, PostgreSQL or SQLite database
* Redis (optional; needed for background jobs and for sharing cache and sessions between processes)

You can find commands for this in the [getting started page](https://docs.solder.io/getting-started/#requirements).

Installation/Updating Solder
-------------

Refer to our documentation here: <https://docs.solder.io/>

If there is any missing/incorrect info, please post an issue on our [issue tracker](https://github.com/TechnicPack/TechnicSolder/issues)

Using Docker
-------------

See the [Docker setup guide](https://docs.solder.io/getting-started/docker/) for full instructions.

Quick start:

```bash
git clone https://github.com/TechnicPack/TechnicSolder.git
cd TechnicSolder
docker compose up -d
```

Troubleshooting
---------------

If you are having issues and can't seem to figure out what's going on, join our [development Discord server][discord].

[discord]: https://discord.gg/0XSjZibQg6yguy1x
