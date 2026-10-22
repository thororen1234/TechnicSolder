<?php

namespace App\Mods\Providers;

use App\Mods\ImportedModData;
use App\Mods\ModProvider;

/**
 * Minecraft Forge, packaged for Technic as bin/modpack.jar.
 *
 * Technic needs the universal jar for Minecraft 1.12.2 and older, and the installer jar for 1.13 and newer.
 */
class Forge extends ModProvider
{
    public static function name(): string
    {
        return 'Forge';
    }

    protected static function apiUrl(): string
    {
        return 'https://maven.minecraftforge.net/net/minecraftforge/forge';
    }

    protected static function zipFolder(): string
    {
        return 'bin';
    }

    protected static function useRawVersion(): bool
    {
        return true;
    }

    /**
     * Forge builds grouped by Minecraft version, newest Minecraft version first, builds oldest first.
     *
     * @return array<string, list<string>>
     */
    private static function getVersionsMap(): array
    {
        $xml = static::request('/maven-metadata.xml', true);
        if (! $xml) {
            return [];
        }

        $previous = libxml_use_internal_errors(true);
        $data = simplexml_load_string($xml);
        libxml_use_internal_errors($previous);

        if (! $data || ! isset($data->versioning->versions->version)) {
            return [];
        }

        $versionsMap = [];
        foreach ($data->versioning->versions->version as $raw) {
            $parts = explode('-', (string) $raw, 2);
            if (count($parts) !== 2 || $parts[0] === '' || $parts[1] === '') {
                continue;
            }

            [$minecraft, $forgeVersion] = $parts;
            $versionsMap[$minecraft][] = $forgeVersion;
        }

        uksort($versionsMap, fn ($a, $b) => version_compare($b, $a));

        return $versionsMap;
    }

    public static function search(string $query, int $page = 1, string $gameVersion = '', string $loader = ''): object
    {
        $mods = [];

        foreach (self::getVersionsMap() as $minecraft => $versions) {
            if (($query !== '' && stripos($minecraft, $query) === false)
                || ($gameVersion !== '' && stripos($minecraft, $gameVersion) === false)) {
                continue;
            }

            $mods[] = self::generateModData($minecraft, array_reverse($versions));
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
     * @param  string  $modId  Minecraft version
     */
    public static function mod(string $modId): ?ImportedModData
    {
        $versionsMap = self::getVersionsMap();

        if (! isset($versionsMap[$modId])) {
            return null;
        }

        return self::generateModData($modId, array_reverse($versionsMap[$modId]));
    }

    /**
     * Whether Technic needs the universal jar (Minecraft 1.12.2 and older) rather than the installer.
     */
    public static function usesUniversalJar(string $minecraft): bool
    {
        return str_starts_with($minecraft, '1.') && version_compare($minecraft, '1.13', '<');
    }

    private static function generateModData(string $minecraft, array $versions): ImportedModData
    {
        $modData = new ImportedModData;

        $modData->id = $minecraft;
        $modData->slug = 'forge';
        $modData->name = 'Minecraft Forge';
        $modData->summary = 'Forge mod loader';
        $modData->displayName = "Minecraft Forge $minecraft";
        $modData->displaySummary = "Forge for Minecraft $minecraft";
        $modData->authors = 'MinecraftForge';
        $modData->thumbnailUrl = 'https://files.minecraftforge.net/static/images/logo.svg';
        $modData->thumbnailDesc = 'Forge';
        $modData->websiteUrl = 'https://files.minecraftforge.net/';
        $modData->versions = [];

        $classifier = static::usesUniversalJar($minecraft) ? 'universal' : 'installer';

        foreach ($versions as $version) {
            $modData->versions["$minecraft-forge-$version"] = (object) [
                'url' => static::apiUrl()."/$minecraft-$version/forge-$minecraft-$version-$classifier.jar",
                'filename' => 'modpack.jar',
                'label' => $version,
                'gameVersions' => [$minecraft],
                'versionType' => 'release',
            ];
        }

        return $modData;
    }
}
