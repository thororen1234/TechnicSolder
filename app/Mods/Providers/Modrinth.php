<?php

namespace App\Mods\Providers;

use App\Mods\ImportedModData;
use App\Mods\ModProvider;

class Modrinth extends ModProvider
{
    public static function name(): string
    {
        return 'Modrinth';
    }

    protected static function apiUrl(): string
    {
        return 'https://api.modrinth.com/v2';
    }

    public static function search(string $query, int $page = 1, string $gameVersion = '', string $loader = ''): object
    {
        $pageSize = 20;
        $page = max(1, $page);

        $params = [
            'limit' => $pageSize,
            'offset' => ($page - 1) * $pageSize,
            'query' => $query,
            'index' => 'relevance',
        ];

        $facets = [['project_type:mod']];
        if ($gameVersion !== '') {
            $facets[] = ["versions:$gameVersion"];
        }
        if ($loader !== '') {
            $facets[] = ["categories:$loader"];
        }
        $params['facets'] = json_encode($facets);

        $data = static::request('/search?'.http_build_query($params));

        $result = (object) [
            'mods' => [],
            'pagination' => (object) [
                'currentPage' => $page,
                'totalPages' => isset($data->total_hits) ? max(1, (int) ceil($data->total_hits / $pageSize)) : 1,
                'totalItems' => $data->total_hits ?? 0,
            ],
        ];

        if ($data === null) {
            $result->errors = ['api_error' => 'Modrinth could not be reached. Try again in a moment.'];

            return $result;
        }

        foreach ($data->hits ?? [] as $mod) {
            $result->mods[] = self::generateModData($mod);
        }

        return $result;
    }

    public static function mod(string $modId): ?ImportedModData
    {
        return static::modFor($modId);
    }

    public static function modFor(string $modId, string $gameVersion = '', string $loader = ''): ?ImportedModData
    {
        $mod = static::request('/project/'.rawurlencode($modId));

        if (! is_object($mod)) {
            return null;
        }

        $modData = self::generateModData($mod);

        // Project responses carry no author; take the team owner instead
        $members = static::request('/project/'.rawurlencode($modId).'/members') ?? [];
        $owner = collect($members)->firstWhere('role', 'Owner') ?? ($members[0] ?? null);
        if (isset($owner->user->username)) {
            $modData->authors = $owner->user->username;
        }

        $filters = array_filter([
            'game_versions' => $gameVersion !== '' ? json_encode([$gameVersion]) : null,
            'loaders' => $loader !== '' ? json_encode([$loader]) : null,
        ]);
        $query = $filters ? '?'.http_build_query($filters) : '';

        foreach (static::request('/project/'.rawurlencode($modId).'/version'.$query) ?? [] as $version) {
            self::addVersion($modData, $version);
        }

        return $modData;
    }

    /**
     * Load specific versions in bulk, grouped by project. Used by pack imports.
     *
     * @param  list<string>  $versionIds
     * @return array<string, ImportedModData> keyed by project ID, each holding only the requested versions
     */
    public static function modsForVersions(array $versionIds): array
    {
        $versions = [];
        foreach (array_chunk(array_values(array_unique($versionIds)), 100) as $chunk) {
            foreach (static::request('/versions?'.http_build_query(['ids' => json_encode($chunk)])) ?? [] as $version) {
                $versions[] = $version;
            }
        }

        $projectIds = array_values(array_unique(array_map(fn ($version) => $version->project_id, $versions)));

        $mods = [];
        foreach (array_chunk($projectIds, 100) as $chunk) {
            foreach (static::request('/projects?'.http_build_query(['ids' => json_encode($chunk)])) ?? [] as $project) {
                $mods[$project->id] = self::generateModData($project);
            }
        }

        foreach ($versions as $version) {
            if (isset($mods[$version->project_id])) {
                self::addVersion($mods[$version->project_id], $version);
            }
        }

        return $mods;
    }

    /**
     * Find the Modrinth files matching the given SHA-1 hashes.
     *
     * @param  list<string>  $sha1Hashes
     * @return array<string, object{url: string, sha1: string, sha512: string}> keyed by SHA-1
     */
    public static function filesByHash(array $sha1Hashes): array
    {
        $found = [];

        foreach (array_chunk(array_values(array_unique($sha1Hashes)), 500) as $chunk) {
            $versions = static::post('/version_files', ['hashes' => $chunk, 'algorithm' => 'sha1']) ?? [];

            foreach ((array) $versions as $hash => $version) {
                foreach ($version->files ?? [] as $file) {
                    if (($file->hashes->sha1 ?? null) === $hash && ! empty($file->url)) {
                        $found[$hash] = (object) [
                            'url' => $file->url,
                            'sha1' => $file->hashes->sha1,
                            'sha512' => $file->hashes->sha512 ?? '',
                        ];
                    }
                }
            }
        }

        return $found;
    }

    private static function addVersion(ImportedModData $modData, object $version): void
    {
        $files = $version->files ?? [];
        $primaryFile = collect($files)->firstWhere('primary', true) ?? ($files[0] ?? null);

        if (! $primaryFile || empty($primaryFile->url)) {
            return;
        }

        $modData->versions[$version->id] = (object) [
            'url' => $primaryFile->url,
            'filename' => $primaryFile->filename ?? 'mod.jar',
            'label' => $version->version_number ?? $version->id,
            'gameVersions' => $version->game_versions ?? [],
            'loaders' => $version->loaders ?? [],
            'versionType' => $version->version_type ?? 'release',
            'sha1' => $primaryFile->hashes->sha1 ?? null,
        ];
    }

    private static function generateModData(object $mod): ImportedModData
    {
        $modData = new ImportedModData;

        $modData->id = $mod->project_id ?? $mod->id ?? null;
        $modData->slug = $mod->slug ?? $modData->id;
        $modData->name = $mod->title ?? $mod->name ?? 'Unknown Mod';
        $modData->summary = $mod->description ?? '';
        $modData->authors = $mod->author ?? 'Unknown';
        $modData->thumbnailUrl = $mod->icon_url ?? null;
        $modData->thumbnailDesc = $modData->name;
        $modData->websiteUrl = 'https://modrinth.com/'.($mod->project_type ?? 'mod').'/'.$modData->slug;
        $modData->versions = [];

        return $modData;
    }
}
