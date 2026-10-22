<?php

namespace App\Mods;

/**
 * A mod (or mod loader) as returned by a ModProvider, with its importable versions.
 *
 * Each entry in $versions is keyed by a provider-specific version key and holds:
 * - url: download URL of the file
 * - filename: file name to store inside the Solder zip
 * - label: human readable version name (falls back to the key)
 * - gameVersions: list of Minecraft versions the file supports
 * - loaders: list of mod loaders the file supports (lowercase)
 * - versionType: "release", "beta" or "alpha"
 * - folder: optional folder inside the Solder zip, overriding the provider default
 * - sha1: optional checksum to verify the download against
 */
class ImportedModData
{
    public $id;

    public $slug;

    public $name;

    public $summary;

    public $authors;

    public $thumbnailUrl;

    public $thumbnailDesc;

    public $websiteUrl;

    /** Optional name shown in search results instead of $name, e.g. "Fabric Loader 1.20.1". */
    public ?string $displayName = null;

    /** Optional summary shown in search results instead of $summary. */
    public ?string $displaySummary = null;

    /** @var array<string, object> */
    public $versions = [];
}
