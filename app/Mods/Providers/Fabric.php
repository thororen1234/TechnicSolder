<?php

namespace App\Mods\Providers;

use App\Mods\ImportedModData;
use App\Mods\ModProvider;

/**
 * Fabric Loader, packaged for Technic as bin/version.json (the launcher profile from Fabric Meta).
 *
 * Each Minecraft version is a search result; its versions are the loader builds for that game version.
 */
class Fabric extends ModProvider
{
    public static function name(): string
    {
        return 'Fabric';
    }

    protected static function apiUrl(): string
    {
        return 'https://meta.fabricmc.net/v2';
    }

    protected static function zipFolder(): string
    {
        return 'bin';
    }

    protected static function useRawVersion(): bool
    {
        return true;
    }

    protected static function slug(): string
    {
        return 'fabric-loader';
    }

    protected static function authors(): string
    {
        return 'FabricMC';
    }

    protected static function websiteUrl(): string
    {
        return 'https://fabricmc.net/';
    }

    protected static function thumbnailUrl(): string
    {
        return 'https://fabricmc.net/assets/logo.png';
    }

    /**
     * Whether a loader build is a stable release.
     */
    protected static function isStable(object $loader): bool
    {
        return (bool) ($loader->stable ?? true);
    }

    public static function search(string $query, int $page = 1, string $gameVersion = '', string $loader = ''): object
    {
        $mods = [];

        foreach (static::request('/versions/game') ?? [] as $game) {
            $version = $game->version ?? '';

            if (empty($game->stable)
                || ($query !== '' && stripos($version, $query) === false)
                || ($gameVersion !== '' && stripos($version, $gameVersion) === false)) {
                continue;
            }

            $mods[] = self::generateModData($version);
        }

        return (object) [
            'mods' => $mods,
            'pagination' => (object) [
                'currentPage' => 1,
                'totalPages' => 1,
                'totalItems' => count($mods),
            ],
        ];
    }

    /**
     * @param  string  $modId  Minecraft version, e.g. "1.20.1" or "26.1"
     */
    public static function mod(string $modId): ?ImportedModData
    {
        $games = collect(static::request('/versions/game') ?? []);
        if (! $games->contains(fn ($game) => ($game->version ?? null) === $modId)) {
            return null;
        }

        $modData = self::generateModData($modId);

        foreach (static::request('/versions/loader') ?? [] as $loader) {
            $loaderVersion = $loader->version ?? null;
            if (! $loaderVersion) {
                continue;
            }

            $modData->versions["$modId-$loaderVersion"] = (object) [
                'url' => static::apiUrl()."/versions/loader/$modId/$loaderVersion/profile/json",
                'filename' => 'version.json',
                'label' => $loaderVersion,
                'gameVersions' => [$modId],
                'versionType' => static::isStable($loader) ? 'release' : 'beta',
            ];
        }

        return $modData;
    }

    private static function generateModData(string $gameVersion): ImportedModData
    {
        $modData = new ImportedModData;

        $modData->id = $gameVersion;
        $modData->slug = static::slug();
        $modData->name = static::name().' Loader';
        $modData->summary = static::name().' Loader for Minecraft';
        $modData->displayName = static::name()." Loader $gameVersion";
        $modData->displaySummary = static::name()." Loader for Minecraft $gameVersion";
        $modData->authors = static::authors();
        $modData->thumbnailUrl = static::thumbnailUrl();
        $modData->thumbnailDesc = static::authors();
        $modData->websiteUrl = static::websiteUrl();
        $modData->versions = [];

        return $modData;
    }
}
