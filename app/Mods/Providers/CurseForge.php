<?php

namespace App\Mods\Providers;

use App\Mods\ImportedModData;
use App\Mods\ModProvider;

class CurseForge extends ModProvider
{
    /** CurseForge game ID for Minecraft */
    private const GAME_ID = 432;

    /** CurseForge class ID for mods */
    private const CLASS_MODS = 6;

    /**
     * Folders for non-mod project classes (resource packs, shader packs).
     *
     * @var array<int, string>
     */
    private const CLASS_FOLDERS = [
        12 => 'resourcepacks',
        6552 => 'shaderpacks',
    ];

    /** @var array<string, int> */
    private const LOADER_TYPES = [
        'forge' => 1,
        'fabric' => 4,
        'quilt' => 5,
        'neoforge' => 6,
    ];

    public static function name(): string
    {
        return 'CurseForge';
    }

    protected static function apiUrl(): string
    {
        return 'https://api.curseforge.com/v1';
    }

    protected static function apiHeaders(): array
    {
        return [
            ...static::downloadHeaders(),
            'x-api-key' => (string) config('solder.curseforge_api_key'),
        ];
    }

    public static function hasApiKey(): bool
    {
        return ! empty(config('solder.curseforge_api_key'));
    }

    public static function search(string $query, int $page = 1, string $gameVersion = '', string $loader = ''): object
    {
        $pageSize = 20;
        $page = max(1, $page);

        $result = (object) [
            'mods' => [],
            'pagination' => (object) [
                'currentPage' => $page,
                'totalPages' => 1,
                'totalItems' => 0,
            ],
        ];

        if (! static::hasApiKey()) {
            $result->errors = ['no_api_key' => 'CurseForge API key is not configured. Set CURSEFORGE_API_KEY in your .env file.'];

            return $result;
        }

        $params = [
            'gameId' => self::GAME_ID,
            'classId' => self::CLASS_MODS,
            'searchFilter' => $query,
            'pageSize' => $pageSize,
            'index' => ($page - 1) * $pageSize,
            'sortField' => 2, // popularity
            'sortOrder' => 'desc',
        ];

        if ($gameVersion !== '') {
            $params['gameVersion'] = $gameVersion;
        }

        if (isset(self::LOADER_TYPES[$loader])) {
            $params['modLoaderType'] = self::LOADER_TYPES[$loader];
        }

        $data = static::request('/mods/search?'.http_build_query($params));

        if (! isset($data->data)) {
            $result->errors = ['api_error' => 'CurseForge API request failed. Check your API key.'];

            return $result;
        }

        foreach ($data->data as $mod) {
            $result->mods[] = self::generateModData($mod);
        }

        // CurseForge refuses to page past 10,000 results
        $total = min($data->pagination->totalCount ?? 0, 10000);
        $result->pagination->totalItems = $data->pagination->totalCount ?? 0;
        $result->pagination->totalPages = max(1, (int) ceil($total / $pageSize));

        return $result;
    }

    public static function mod(string $modId): ?ImportedModData
    {
        return static::modFor($modId);
    }

    /**
     * CurseForge pages files 50 at a time, newest first, so filter server-side when a game version or loader is known.
     */
    public static function modFor(string $modId, string $gameVersion = '', string $loader = ''): ?ImportedModData
    {
        if (! static::hasApiKey()) {
            return null;
        }

        $mod = static::request('/mods/'.rawurlencode($modId))->data ?? null;
        if (! is_object($mod)) {
            return null;
        }

        $modData = self::generateModData($mod);

        $params = ['pageSize' => 50];
        if ($gameVersion !== '') {
            $params['gameVersion'] = $gameVersion;
        }
        if (isset(self::LOADER_TYPES[$loader])) {
            $params['modLoaderType'] = self::LOADER_TYPES[$loader];
        }

        $files = static::request('/mods/'.rawurlencode($modId).'/files?'.http_build_query($params))->data ?? $mod->latestFiles ?? [];
        foreach ($files as $file) {
            self::addFile($modData, $file, self::CLASS_FOLDERS[$mod->classId ?? 0] ?? null);
        }

        return $modData;
    }

    /**
     * Load specific files in bulk, grouped by project. Used by pack imports.
     *
     * @param  list<int|string>  $fileIds
     * @return array<string, ImportedModData> keyed by project ID, each holding only the requested files
     */
    public static function modsForFiles(array $fileIds): array
    {
        if (! static::hasApiKey() || empty($fileIds)) {
            return [];
        }

        $files = [];
        foreach (array_chunk(array_map('intval', array_values(array_unique($fileIds))), 500) as $chunk) {
            foreach (static::post('/mods/files', ['fileIds' => $chunk])->data ?? [] as $file) {
                $files[] = $file;
            }
        }

        $modIds = array_values(array_unique(array_map(fn ($file) => (int) $file->modId, $files)));

        $mods = [];
        $classes = [];
        foreach (array_chunk($modIds, 500) as $chunk) {
            foreach (static::post('/mods', ['modIds' => $chunk])->data ?? [] as $mod) {
                $mods[(string) $mod->id] = self::generateModData($mod);
                $classes[(string) $mod->id] = $mod->classId ?? self::CLASS_MODS;
            }
        }

        foreach ($files as $file) {
            $modId = (string) $file->modId;
            if (isset($mods[$modId])) {
                self::addFile($mods[$modId], $file, self::CLASS_FOLDERS[$classes[$modId]] ?? null);
            }
        }

        return $mods;
    }

    private static function addFile(ImportedModData $modData, object $file, ?string $folder): void
    {
        $gameVersions = [];
        $loaders = [];
        foreach ($file->gameVersions ?? [] as $tag) {
            if (preg_match('/^\d+\.\d+/', $tag)) {
                $gameVersions[] = $tag;
            } elseif (isset(self::LOADER_TYPES[strtolower($tag)])) {
                $loaders[] = strtolower($tag);
            }
        }

        $sha1 = collect($file->hashes ?? [])->firstWhere('algo', 1)->value ?? null;

        $modData->versions[(string) $file->id] = (object) [
            // downloadUrl is null when the author disabled third-party distribution
            'url' => $file->downloadUrl ?? null,
            'filename' => $file->fileName ?? 'mod.jar',
            'label' => $file->displayName ?? $file->fileName ?? (string) $file->id,
            'gameVersions' => $gameVersions,
            'loaders' => $loaders,
            'versionType' => match ($file->releaseType ?? 1) {
                2 => 'beta',
                3 => 'alpha',
                default => 'release',
            },
            'folder' => $folder,
            'sha1' => $sha1,
            // relationType 3 = required dependency
            'dependencies' => collect($file->dependencies ?? [])
                ->filter(fn ($dependency) => ($dependency->relationType ?? 0) === 3)
                ->map(fn ($dependency) => (string) $dependency->modId)->unique()->values()->all(),
        ];
    }

    private static function generateModData(object $mod): ImportedModData
    {
        $modData = new ImportedModData;

        $modData->id = $mod->id ?? null;
        $modData->slug = $mod->slug ?? null;
        $modData->name = $mod->name ?? 'Unknown Mod';
        $modData->summary = $mod->summary ?? '';
        $modData->authors = $mod->authors[0]->name ?? 'Unknown';
        $modData->thumbnailUrl = $mod->logo->thumbnailUrl ?? $mod->logo->url ?? null;
        $modData->thumbnailDesc = $modData->name;
        $modData->websiteUrl = $mod->links->websiteUrl ?? null;
        $modData->versions = [];

        return $modData;
    }
}
