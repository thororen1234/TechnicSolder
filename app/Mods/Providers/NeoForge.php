<?php

namespace App\Mods\Providers;

use App\Mods\ImportedModData;
use App\Mods\ModProvider;

/**
 * NeoForge, packaged for Technic with its installer as bin/modpack.jar.
 *
 * Minecraft 1.20.1 builds were published as net.neoforged:forge ("1.20.1-47.1.106"); later builds as
 * net.neoforged:neoforge, versioned after Minecraft: "21.1.263" is 1.21.1 and "26.3.0.95" is 26.3.
 */
class NeoForge extends ModProvider
{
    public static function name(): string
    {
        return 'NeoForge';
    }

    protected static function apiUrl(): string
    {
        return 'https://maven.neoforged.net/releases/net/neoforged';
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
     * @return list<string>
     */
    private static function fetchMavenVersions(string $artifact): array
    {
        $xml = static::request("/$artifact/maven-metadata.xml", true);
        if (! $xml) {
            return [];
        }

        $previous = libxml_use_internal_errors(true);
        $data = simplexml_load_string($xml);
        libxml_use_internal_errors($previous);

        if (! $data || ! isset($data->versioning->versions->version)) {
            return [];
        }

        $versions = [];
        foreach ($data->versioning->versions->version as $version) {
            $versions[] = (string) $version;
        }

        return $versions;
    }

    /**
     * Map a NeoForge version to the Minecraft version it targets.
     */
    public static function minecraftVersion(string $version): ?string
    {
        // Legacy net.neoforged:forge builds carry the Minecraft version as a prefix
        if (preg_match('/^(1\.\d+(?:\.\d+)?)-/', $version, $match)) {
            return $match[1];
        }

        if (! preg_match('/^(\d+)\.(\d+)\.(\d+)/', $version, $match)) {
            return null;
        }

        [, $major, $minor, $patch] = array_map('intval', $match);

        // Year-based Minecraft versions (26.1 and later): "{year}.{drop}.{hotfix}.{build}"
        if ($major >= 25) {
            return $patch > 0 ? "$major.$minor.$patch" : "$major.$minor";
        }

        // "{minor}.{patch}.{build}" for Minecraft 1.{minor}.{patch}
        return $minor > 0 ? "1.$major.$minor" : "1.$major";
    }

    /**
     * All builds grouped by Minecraft version, newest Minecraft version first, builds newest first.
     *
     * @return array<string, list<string>>
     */
    private static function getVersionsMap(): array
    {
        $legacy = array_filter(
            self::fetchMavenVersions('forge'),
            fn ($version) => (bool) preg_match('/^1\.\d+(?:\.\d+)?-\d/', $version)
        );

        $grouped = [];
        foreach ([...$legacy, ...self::fetchMavenVersions('neoforge')] as $version) {
            $minecraft = static::minecraftVersion($version);
            if ($minecraft !== null) {
                $grouped[$minecraft][] = $version;
            }
        }

        uksort($grouped, fn ($a, $b) => version_compare($b, $a));

        return array_map('array_reverse', $grouped);
    }

    public static function search(string $query, int $page = 1, string $gameVersion = '', string $loader = ''): object
    {
        $mods = [];

        foreach (self::getVersionsMap() as $minecraft => $versions) {
            if (($query !== '' && $minecraft !== $query && ! str_starts_with($minecraft, $query.'.'))
                || ($gameVersion !== '' && stripos($minecraft, $gameVersion) === false)) {
                continue;
            }

            $mods[] = self::generateModData($minecraft, $versions);
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
        $versions = self::getVersionsMap()[$modId] ?? null;

        return $versions === null ? null : self::generateModData($modId, $versions);
    }

    private static function generateModData(string $minecraft, array $versions): ImportedModData
    {
        $modData = new ImportedModData;

        $modData->id = $minecraft;
        $modData->slug = 'neoforge';
        $modData->name = 'NeoForge';
        $modData->summary = 'NeoForge is the modern continuation of the Minecraft Forge modding ecosystem.';
        $modData->displayName = "NeoForge $minecraft";
        $modData->displaySummary = "NeoForge builds for Minecraft $minecraft";
        $modData->authors = 'NeoForged';
        $modData->thumbnailUrl = 'https://neoforged.net/img/authors/neoforged.png';
        $modData->thumbnailDesc = 'NeoForge';
        $modData->websiteUrl = 'https://neoforged.net/';
        $modData->versions = [];

        foreach ($versions as $version) {
            $isLegacy = str_starts_with($version, '1.');
            $artifact = $isLegacy ? 'forge' : 'neoforge';

            $modData->versions["$artifact-$version"] = (object) [
                'url' => static::apiUrl()."/$artifact/$version/$artifact-$version-installer.jar",
                'filename' => 'modpack.jar',
                'label' => $version,
                'gameVersions' => [$minecraft],
                'versionType' => preg_match('/-(beta|alpha)/i', $version) ? 'beta' : 'release',
            ];
        }

        return $modData;
    }
}
