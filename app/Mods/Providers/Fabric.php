<?php

namespace App\Mods\Providers;

use App\Mods\ImportedModData;
use App\Mods\ModProvider;

class Fabric extends ModProvider
{
    public static function name(): string
    {
        return "Fabric";
    }

    protected static function apiUrl(): string
    {
        return "https://meta.fabricmc.net";
    }

    protected static function zipFolder(): string
    {
        return "bin";
    }

    protected static function useRawVersion(): bool
    {
        return true;
    }

    public static function search(string $query, int $page = 1, string $gameVersion = '', string $loader = ''): object
    {
        $mods = [];
        $data = static::request("/v2/versions/game") ?? [];

        foreach ($data as $mod) {
            if (empty($mod->stable)) {
                continue;
            }

            if (!empty($query) && stripos($mod->version ?? '', $query) === false) {
                continue;
            }

            if (!empty($gameVersion) && stripos($mod->version ?? '', $gameVersion) === false) {
                continue;
            }

            $mods[] = static::generateModData($mod);
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
        $data = static::request("/v2/versions/game") ?? [];

        $foundMod = null;

        foreach ($data as $mod) {
            if (isset($mod->version) && $mod->version === $modId) {
                $foundMod = $mod;
                break;
            }
        }

        if (!$foundMod) {
            return null;
        }

        $foundMod->versions = static::request("/v2/versions/loader") ?? [];

        return static::generateModData($foundMod);
    }

    private static function generateModData($mod): ImportedModData
    {
        $modData = new ImportedModData();

        $version = $mod->version ?? 'unknown';

        $modData->id = $version;
        $modData->slug = "fabric-loader";

        $modData->name = "Fabric Loader";
        $modData->summary = "Fabric Loader for Minecraft";

        $modData->displayName = "Fabric Loader {$version}";
        $modData->displaySummary = "Fabric Loader for Minecraft {$version}";

        $modData->authors = "FabricMC";

        $modData->thumbnailUrl = "https://fabricmc.net/assets/logo.png";
        $modData->thumbnailDesc = "FabricMC";
        $modData->websiteUrl = "https://fabricmc.net/";

        $modData->versions = [];

        if (!empty($mod->versions) && is_iterable($mod->versions)) {
            foreach ($mod->versions as $versionObj) {

                $ver = $versionObj->version ?? 'unknown';
                $game = $mod->version ?? 'unknown';

                $key = "{$game}-{$ver}";

                $modData->versions[$key] = (object) [
                    "url"          => static::apiUrl()
                        . "/v2/versions/loader/{$game}/{$ver}/profile/json",
                    "filename"     => "version.json",
                    "gameVersions" => [$game],
                ];
            }
        }

        return $modData;
    }
}