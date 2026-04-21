<?php

namespace App\Mods\Providers;

use App\Mods\ImportedModData;
use App\Mods\ModProvider;

class Modrinth extends ModProvider
{
    public static function name(): string
    {
        return "Modrinth";
    }

    protected static function apiUrl(): string
    {
        return "https://api.modrinth.com/v2";
    }

    public static function search(string $query, int $page = 1): object
    {
        $pageSize = 20;
        $offset = max(0, ($page - 1) * $pageSize);

        $data = static::request("/search?" . http_build_query([
            "limit" => $pageSize,
            "offset" => $offset,
            "query" => $query,
            "index" => "relevance",
        ]));

        $mods = [];

        foreach (($data->hits ?? []) as $mod) {
            try {
                $mods[] = static::generateModData($mod);
            } catch (\Throwable $e) {
            }
        }

        return (object) [
            'mods' => $mods,
            'pagination' => (object) [
                'currentPage' => $page,
                'totalPages' => isset($data->total_hits)
                    ? (int) ceil($data->total_hits / $pageSize)
                    : 1,
                'totalItems' => $data->total_hits ?? 0,
            ]
        ];
    }

    public static function mod(string $modId): ?ImportedModData
    {
        $mod = static::request("/project/" . urlencode($modId));

        if (!$mod) {
            return null;
        }

        $modData = static::generateModData($mod);

        $versions = static::request("/project/" . urlencode($modId) . "/version");

        if (is_array($versions)) {
            foreach ($versions as $version) {
                $primaryFile = $version->files[0] ?? null;
                if (!$primaryFile || empty($primaryFile->url)) {
                    continue;
                }

                $key = $version->version_number ?? $version->id ?? uniqid();

                $modData->versions[$key] = (object) [
                    "url"          => $primaryFile->url,
                    "filename"     => $primaryFile->filename ?? "mod.jar",
                    "gameVersions" => $version->game_versions ?? [],
                ];
            }
        }

        return $modData;
    }

    private static function generateModData($mod): ImportedModData
    {
        $modData = new ImportedModData();

        $modData->id = $mod->project_id ?? $mod->id ?? null;
        $modData->slug = $mod->slug ?? $modData->id;

        $modData->name = $mod->title ?? $mod->name ?? 'Unknown Mod';
        $modData->summary = $mod->description ?? '';

        $modData->authors = $mod->author ?? 'Unknown';

        $modData->thumbnailUrl = $mod->icon_url ?? null;
        $modData->thumbnailDesc = $modData->name;

        $modData->websiteUrl =
            $mod->source_url
            ?? $mod->project_url
            ?? "https://modrinth.com/mod/" . $modData->slug;

        $modData->versions = [];

        return $modData;
    }
}