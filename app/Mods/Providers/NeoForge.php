<?php

namespace App\Mods\Providers;

use App\Mods\ImportedModData;
use App\Mods\ModProvider;

class NeoForge extends ModProvider
{
    public static function name(): string
    {
        return "NeoForge";
    }

    protected static function apiUrl(): string
    {
        return "https://maven.neoforged.net/releases/net/neoforged/neoforge";
    }

    protected static function zipFolder(): string
    {
        return "bin";
    }

    protected static function useRawVersion(): bool
    {
        return true;
    }

    private static function forgeApiUrl(): string
    {
        return "https://maven.neoforged.net/releases/net/neoforged/forge";
    }

    private static function fetchMavenVersions(string $baseUrl): array
    {
        $curl_h = curl_init($baseUrl . '/maven-metadata.xml');
        curl_setopt($curl_h, CURLOPT_HTTPHEADER, static::apiHeaders());
        curl_setopt($curl_h, CURLOPT_RETURNTRANSFER, true);
        $xml = curl_exec($curl_h);
        curl_close($curl_h);

        if (!$xml) {
            return [];
        }

        libxml_use_internal_errors(true);
        $data = simplexml_load_string($xml);

        if (!$data || !isset($data->versioning->versions->version)) {
            return [];
        }

        $versions = [];
        foreach ($data->versioning->versions->version as $v) {
            $versions[] = (string) $v;
        }

        return $versions;
    }

    private static function getVersions(): array
    {
        $forgeVersions = array_values(array_filter(
            static::fetchMavenVersions(static::forgeApiUrl()),
            fn ($v) => (bool) preg_match('/^1\.\d+\.\d+-\d/', $v)
        ));

        return array_merge($forgeVersions, static::fetchMavenVersions(static::apiUrl()));
    }

    private static function extractMcVersion(string $version): array
    {
        if (preg_match('/^(1\.\d+(?:\.\d+)?)-(.+)$/', $version, $m)) {
            return [$m[1], $version];
        }

        if (preg_match('/^(\d+\.\d+\.\d+)\./', $version, $m)) {
            return [$m[1], $version];
        }

        if (preg_match('/^(\d+)\.(\d+)\./', $version, $m)) {
            return ["1.{$m[1]}.{$m[2]}", $version];
        }

        return ["unknown", $version];
    }

    private static function groupVersionsByMc(array $all, string $query = ''): array
    {
        $grouped = [];

        foreach ($all as $version) {
            [$mc, $full] = static::extractMcVersion($version);

            $mc = preg_replace('/-.*$/', '', $mc);

            if (!preg_match('/^\d+\.\d+(\.\d+)?$/', $mc)) {
                continue;
            }

            if (!empty($query)) {
                if ($mc !== $query && strpos($mc, $query . '.') !== 0) {
                    continue;
                }
            }

            $grouped[$mc] ??= [];
            $grouped[$mc][] = $full;
        }

        return $grouped;
    }

    public static function search(string $query, int $page = 1, string $gameVersion = '', string $loader = ''): object
    {
        $all = static::getVersions();
        $grouped = static::groupVersionsByMc($all, $query);

        if (!empty($gameVersion)) {
            $grouped = array_filter(
                $grouped,
                fn ($mc) => stripos($mc, $gameVersion) !== false,
                ARRAY_FILTER_USE_KEY
            );
        }

        uksort($grouped, fn ($a, $b) => version_compare($b, $a));
        $grouped = array_map('array_reverse', $grouped);

        $mods = [];

        foreach ($grouped as $mc => $versions) {
            $mods[] = static::generateModData($mc, $versions);
        }

        return (object) [
            'mods' => $mods,
            'pagination' => (object) [
                'currentPage' => 1,
                'totalPages' => 1,
                'totalItems' => count($mods)
            ]
        ];
    }

    public static function mod(string $modId): ?ImportedModData
    {
        $all = static::getVersions();

        if (empty($all)) {
            return null;
        }

        $grouped = static::groupVersionsByMc($all, $modId);

        if (!isset($grouped[$modId])) {
            return null;
        }

        return static::generateModData($modId, array_reverse($grouped[$modId]));
    }

    private static function generateModData($mcVersion, $versions): ImportedModData
    {
        $modData = new ImportedModData();

        $modData->id = $mcVersion;
        $modData->slug = "neoforge";

        $modData->name = "NeoForge";
        $modData->summary = "NeoForge is the modern continuation of the Minecraft Forge modding ecosystem.";

        $modData->displayName = "NeoForge ({$mcVersion})";
        $modData->displaySummary = "NeoForge builds for {$mcVersion}";

        $modData->authors = "NeoForged Team";

        $modData->thumbnailUrl = "https://neoforged.net/img/authors/neoforged.png";
        $modData->thumbnailDesc = "NeoForge";
        $modData->websiteUrl = "https://neoforged.net/";

        $modData->versions = [];

        foreach ($versions as $version) {
            if (str_starts_with($version, '1.')) {
                $modData->versions["forge-{$version}"] = (object) [
                    "url"          => static::forgeApiUrl() . "/{$version}/forge-{$version}-installer.jar",
                    "filename"     => "modpack.jar",
                    "gameVersions" => [$mcVersion],
                ];
            } else {
                $modData->versions["neoforge-{$version}"] = (object) [
                    "url"          => static::apiUrl() . "/{$version}/neoforge-{$version}-installer.jar",
                    "filename"     => "modpack.jar",
                    "gameVersions" => [$mcVersion],
                ];
            }
        }

        return $modData;
    }
}