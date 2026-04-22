<?php

namespace App\Mods\Providers;

use App\Mods\ImportedModData;
use App\Mods\ModProvider;

class Quilt extends ModProvider
{
    public static function name(): string
    {
        return "Quilt";
    }

    protected static function apiUrl(): string
    {
        return "https://meta.quiltmc.org";
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
        $data = static::request("/v3/versions/game") ?? [];

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
                'totalItems' => count($mods),
            ],
        ];
    }

    public static function mod(string $modId): ?ImportedModData
    {
        $data = static::request("/v3/versions/game") ?? [];

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

        $foundMod->versions = static::request("/v3/versions/loader") ?? [];

        return static::generateModData($foundMod);
    }

    private static function generateModData($mod): ImportedModData
    {
        $modData = new ImportedModData();

        $version = $mod->version ?? 'unknown';

        $modData->id = $version;
        $modData->slug = "quilt-loader";

        $modData->name = "Quilt Loader";
        $modData->summary = "Quilt Loader for Minecraft";

        $modData->displayName = "Quilt Loader {$version}";
        $modData->displaySummary = "Quilt Loader for Minecraft {$version}";

        $modData->authors = "QuiltMC";

        $modData->thumbnailUrl = "https://quiltmc.org/assets/img/logo.svg";
        $modData->thumbnailDesc = "QuiltMC";
        $modData->websiteUrl = "https://quiltmc.org/";

        $modData->versions = [];

        if (!empty($mod->versions) && is_iterable($mod->versions)) {
            foreach ($mod->versions as $versionObj) {
                $ver = $versionObj->version ?? 'unknown';
                $game = $mod->version ?? 'unknown';

                $key = "{$game}-{$ver}";

                $modData->versions[$key] = (object) [
                    "url"          => static::apiUrl()
                        . "/v3/versions/loader/{$game}/{$ver}/profile/json",
                    "filename"     => "version.json",
                    "gameVersions" => [$game],
                ];
            }
        }

        return $modData;
    }
}
