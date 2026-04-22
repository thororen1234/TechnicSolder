<?php

namespace App\Mods\Providers;

use App\Mods\ImportedModData;
use App\Mods\ModProvider;
use SimpleXMLElement;

class Forge extends ModProvider
{
    public static function name(): string
    {
        return "Forge";
    }

    protected static function apiUrl(): string
    {
        return "https://maven.minecraftforge.net/net/minecraftforge/forge";
    }

    protected static function zipFolder(): string
    {
        return "bin";
    }

    protected static function useRawVersion(): bool
    {
        return true;
    }

    private static function getVersionsMap(): array
    {
        $response = static::request("/maven-metadata.xml", true);

        if (!$response) {
            return [];
        }

        libxml_use_internal_errors(true);
        $data = simplexml_load_string($response);

        if (!$data || !isset($data->versioning->versions->version)) {
            return [];
        }

        $versionsMap = [];

        foreach ($data->versioning->versions->version as $raw) {

            $versionString = (string) $raw;

            if (!str_contains($versionString, '-')) {
                continue;
            }

            [$mcVersion, $forgeVersion] = explode('-', $versionString, 2);

            if (!$mcVersion || !$forgeVersion) {
                continue;
            }

            $versionsMap[$mcVersion] ??= [];

            if (!in_array($forgeVersion, $versionsMap[$mcVersion], true)) {
                $versionsMap[$mcVersion][] = $forgeVersion;
            }
        }

        uksort($versionsMap, fn($a, $b) => version_compare($b, $a));

        return $versionsMap;
    }

    public static function search(string $query, int $page = 1, string $gameVersion = '', string $loader = ''): object
    {
        $versionsMap = static::getVersionsMap();

        $mods = [];

        foreach ($versionsMap as $mcVersion => $versions) {
            if (!empty($query) && stripos($mcVersion, $query) === false) {
                continue;
            }

            if (!empty($gameVersion) && stripos($mcVersion, $gameVersion) === false) {
                continue;
            }

            $mods[] = static::generateModData($mcVersion, array_reverse($versions));
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
        $versionsMap = static::getVersionsMap();

        if (!isset($versionsMap[$modId])) {
            return null;
        }

        return static::generateModData($modId, array_reverse($versionsMap[$modId]));
    }

    private static function generateModData($mc, $versions): ImportedModData
    {
        $modData = new ImportedModData();

        $modData->id = $mc;
        $modData->slug = "forge";

        $modData->name = "Minecraft Forge";
        $modData->summary = "Forge mod loader";

        $modData->displayName = "Minecraft Forge - MC {$mc}";
        $modData->displaySummary = "Forge for Minecraft {$mc}";

        $modData->authors = "LexManos";

        $modData->thumbnailUrl = "https://files.minecraftforge.net/static/images/logo.svg";
        $modData->thumbnailDesc = "Forge";
        $modData->websiteUrl = "https://files.minecraftforge.net/";

        $modData->versions = [];

        foreach ($versions as $version) {
            $key = "{$mc}-forge-{$version}";
            $modData->versions[$key] = (object) [
                "url"          => "https://maven.minecraftforge.net/net/minecraftforge/forge/"
                    . "{$mc}-{$version}/forge-{$mc}-{$version}-installer.jar",
                "filename"     => "modpack.jar",
                "gameVersions" => [$mc],
            ];
        }

        return $modData;
    }
}