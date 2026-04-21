<?php

namespace App\Mods\Providers;

use App\Mods\ImportedModData;
use App\Mods\ModProvider;

class CurseForge extends ModProvider
{
    public static function name(): string
    {
        return "CurseForge";
    }

    protected static function apiUrl(): string
    {
        return "https://api.curseforge.com/v1";
    }

    protected static function apiHeaders(): array
    {
        $apiKey = config('services.curseforge.api_key') ?: env("CURSEFORGE_API_KEY");

        return [
            "User-Agent: TechnicPack/TechnicSolder/" . SOLDER_VERSION,
            "x-api-key: " . ($apiKey ?? ''),
        ];
    }

    private static function hasApiKey(): bool
    {
        $apiKey = config('services.curseforge.api_key') ?: env("CURSEFORGE_API_KEY");
        return !empty($apiKey);
    }

    public static function search(string $query, int $page = 1): object
    {
        $empty = (object) [
            "mods" => [],
            "pagination" => (object) [
                "currentPage" => $page,
                "totalPages"  => 1,
                "totalItems"  => 0,
            ],
        ];

        if (!static::hasApiKey()) {
            $empty->errors = ["no_api_key" => "CurseForge API key is not configured. Set CURSEFORGE_API_KEY in your .env file."];
            return $empty;
        }

        $pageSize = 20;
        $index = ($page - 1) * $pageSize;

        $data = static::request(
            "/mods/search?" . http_build_query([
                "gameId"       => 432,
                "classId"      => 6,
                "searchFilter" => $query,
                "pageSize"     => $pageSize,
                "index"        => $index,
                "sortField"    => 2,
            ])
        );

        if (!$data || isset($data->error) || isset($data->errorCode)) {
            $message = $data->errorMessage ?? $data->error ?? "CurseForge API request failed. Check your API key.";
            $empty->errors = ["api_error" => $message];
            return $empty;
        }

        $mods = [];

        foreach (($data->data ?? []) as $mod) {
            try {
                $mods[] = static::generateModDataFromSearch($mod);
            } catch (\Throwable $e) {
            }
        }

        $pagination = $data->pagination ?? null;
        $total = $pagination->totalCount ?? 0;

        return (object) [
            "mods" => $mods,
            "pagination" => (object) [
                "currentPage" => $page,
                "totalPages"  => $total > 0 ? (int) ceil($total / $pageSize) : 1,
                "totalItems"  => $total,
            ],
        ];
    }

    public static function mod(string $modId): ?ImportedModData
    {
        if (!static::hasApiKey()) {
            return null;
        }

        $res = static::request("/mods/{$modId}");

        if (!$res || isset($res->error) || isset($res->errorCode)) {
            return null;
        }

        $mod = $res->data ?? null;

        if (!$mod) {
            return null;
        }

        try {
            return static::generateModDataFull($mod);
        } catch (\Throwable $e) {
            return null;
        }
    }
    private static function extractAuthor(object $mod): string
    {
        $authors = $mod->authors ?? [];
        if (!is_array($authors) || empty($authors)) {
            return "Unknown";
        }
        return $authors[0]->name ?? "Unknown";
    }

    private static function extractThumbnailUrl(object $mod): ?string
    {
        $logo = $mod->logo ?? null;
        if (!$logo) {
            return null;
        }
        return $logo->thumbnailUrl ?? $logo->url ?? null;
    }

    private static function generateModDataFromSearch($mod): ImportedModData
    {
        $modData = new ImportedModData();

        $modData->id            = $mod->id ?? null;
        $modData->slug          = $mod->slug ?? null;
        $modData->name          = $mod->name ?? "Unknown";
        $modData->summary       = $mod->summary ?? "";
        $modData->authors       = static::extractAuthor($mod);
        $modData->thumbnailUrl  = static::extractThumbnailUrl($mod);
        $modData->thumbnailDesc = $mod->name ?? "CurseForge Mod";
        $modData->websiteUrl    = $mod->links->websiteUrl ?? null;
        $modData->versions      = [];

        return $modData;
    }

    private static function generateModDataFull($mod): ImportedModData
    {
        $modData = new ImportedModData();

        $modData->id            = $mod->id ?? null;
        $modData->slug          = $mod->slug ?? null;
        $modData->name          = $mod->name ?? "Unknown Mod";
        $modData->summary       = $mod->summary ?? "";
        $modData->authors       = static::extractAuthor($mod);
        $modData->thumbnailUrl  = static::extractThumbnailUrl($mod);
        $modData->thumbnailDesc = $mod->name ?? "CurseForge Mod";
        $modData->websiteUrl    = $mod->links->websiteUrl ?? null;
        $modData->versions      = [];

        foreach (($mod->latestFiles ?? []) as $file) {
            if (empty($file->downloadUrl)) {
                continue;
            }

            $key = $file->id ?? $file->fileName ?? uniqid();

            $modData->versions[$key] = (object) [
                "url"          => $file->downloadUrl,
                "filename"     => $file->fileName ?? "mod.jar",
                "gameVersions" => $file->gameVersions ?? [],
            ];
        }

        return $modData;
    }
}