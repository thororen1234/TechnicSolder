<?php

namespace App\Mods;

use App\Models\Mod;
use App\Models\Modversion;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use ZipArchive;

abstract class ModProvider
{
    abstract public static function name(): string;

    abstract protected static function apiUrl(): string;

    abstract public static function search(string $query, int $page = 1, string $gameVersion = '', string $loader = ''): object;

    abstract public static function mod(string $modId): ?ImportedModData;

    /**
     * Load a mod with its versions narrowed to a game version and loader, for providers that only
     * return a page of versions at a time. Defaults to mod().
     */
    public static function modFor(string $modId, string $gameVersion = '', string $loader = ''): ?ImportedModData
    {
        return static::mod($modId);
    }

    /**
     * Headers sent to the provider API.
     *
     * @return array<string, string>
     */
    protected static function apiHeaders(): array
    {
        return static::downloadHeaders();
    }

    /**
     * Headers sent when downloading files. Kept separate so API keys never reach file CDNs.
     *
     * @return array<string, string>
     */
    protected static function downloadHeaders(): array
    {
        return ['User-Agent' => 'TechnicPack/TechnicSolder/'.SOLDER_VERSION];
    }

    /**
     * Folder inside the Solder zip that downloaded files are stored in.
     */
    protected static function zipFolder(): string
    {
        return 'mods';
    }

    /**
     * Whether to use the provider's version key as-is instead of reading it from the jar (mod loaders).
     */
    protected static function useRawVersion(): bool
    {
        return false;
    }

    /**
     * Import the given versions of a mod into the mod library.
     *
     * @param  list<string>  $versions  Version keys from ImportedModData::$versions
     * @param  ImportedModData|null  $modData  Pre-loaded mod data; fetched from the provider when null
     * @return object{success: bool, id: int, errors: list<string>, modversionIds: array<string, int>, created: int, existing: int}
     */
    public static function install(string $modId, array $versions, ?ImportedModData $modData = null): object
    {
        $response = (object) [
            'success' => false,
            'id' => -1,
            'errors' => [],
            'modversionIds' => [],
            'created' => 0,
            'existing' => 0,
        ];

        $modData ??= static::mod($modId);
        if ($modData === null) {
            $response->errors[] = static::name()." mod \"$modId\" could not be loaded";

            return $response;
        }

        $slug = Str::slug((string) $modData->slug) ?: Str::slug((string) $modData->name);
        if ($slug === '') {
            $response->errors[] = static::name()." mod \"$modId\" has no usable name";

            return $response;
        }

        $mod = Mod::firstOrCreate(['name' => $slug], [
            'pretty_name' => $modData->name ?: $slug,
            'author' => $modData->authors,
            'description' => $modData->summary,
            'link' => $modData->websiteUrl,
        ]);

        if ($mod->wasRecentlyCreated) {
            Cache::forget('mods');
        }

        $response->success = true;
        $response->id = $mod->id;

        foreach ($versions as $version) {
            $result = static::installVersion($mod, $modData, (string) $version);

            if (isset($result['error'])) {
                $response->errors[] = $result['error'];

                continue;
            }

            $response->modversionIds[(string) $version] = $result['id'];
            $result['existing'] ? $response->existing++ : $response->created++;
        }

        return $response;
    }

    /**
     * Download one version and store it in the mod repository.
     *
     * @return array{id: int, existing: bool}|array{error: string}
     */
    protected static function installVersion(Mod $mod, ImportedModData $modData, string $versionKey): array
    {
        $versionData = $modData->versions[$versionKey] ?? null;
        $label = $versionData->label ?? $versionKey;

        if ($versionData === null) {
            return ['error' => "{$mod->pretty_name} $label: version not found on ".static::name()];
        }

        if (empty($versionData->url)) {
            return ['error' => "{$mod->pretty_name} $label: no download is available (the author may have disabled third-party downloads)"];
        }

        $repo = config('solder.repo_location');
        if (filter_var($repo, FILTER_VALIDATE_URL)) {
            return ['error' => 'The mod repository is a remote URL, so imported files cannot be saved. Set SOLDER_REPO_LOCATION to a local path.'];
        }

        $tmpFile = tempnam(sys_get_temp_dir(), 'solder_mod_');

        try {
            $downloadError = static::download($versionData->url, $tmpFile);
            if ($downloadError !== null) {
                return ['error' => "{$mod->pretty_name} $label: $downloadError"];
            }

            if (! empty($versionData->sha1) && sha1_file($tmpFile) !== strtolower($versionData->sha1)) {
                return ['error' => "{$mod->pretty_name} $label: checksum mismatch, the download may be corrupt"];
            }

            $modVersion = static::useRawVersion()
                ? $versionKey
                : static::resolveVersionName($tmpFile, $versionData, $label);

            if ($modVersion === null) {
                return ['error' => "{$mod->pretty_name} $label: the downloaded file is not a valid jar or zip"];
            }

            $modVersion = static::sanitizeVersion($modVersion);

            $existing = Modversion::where(['mod_id' => $mod->id, 'version' => $modVersion])->first();
            if ($existing) {
                return ['id' => $existing->id, 'existing' => true];
            }

            $finalPath = $repo."mods/{$mod->name}/{$mod->name}-$modVersion.zip";
            if (! is_dir(dirname($finalPath)) && ! mkdir(dirname($finalPath), 0775, true) && ! is_dir(dirname($finalPath))) {
                return ['error' => "Could not create the folder for {$mod->name} in the mod repository"];
            }

            $folder = trim($versionData->folder ?? static::zipFolder(), '/');
            $fileName = basename($versionData->filename ?? 'mod.jar');

            $zip = new ZipArchive;
            if ($zip->open($finalPath, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
                return ['error' => "Could not write $finalPath"];
            }
            $zip->addFile($tmpFile, ($folder === '' ? '' : "$folder/").$fileName);
            $zip->close();

            $modversion = new Modversion;
            $modversion->mod_id = $mod->id;
            $modversion->version = $modVersion;
            $modversion->filesize = filesize($finalPath);
            $modversion->md5 = md5_file($finalPath);
            $modversion->save();

            return ['id' => $modversion->id, 'existing' => false];
        } finally {
            if (file_exists($tmpFile)) {
                unlink($tmpFile);
            }
        }
    }

    /**
     * Work out the Solder version name for a downloaded file: jar metadata first, then the provider label.
     */
    protected static function resolveVersionName(string $file, object $versionData, string $label): ?string
    {
        $detected = JarMetadata::detectVersionFromFile($file);
        if ($detected === null) {
            return null;
        }

        if ($detected === '') {
            // Not a mod jar (resource pack, shader pack, data pack...) or no metadata: use the provider's name
            $minecraft = static::primaryGameVersion($versionData);
            $detected = $minecraft !== '' && ! str_contains($label, $minecraft) ? "$minecraft-$label" : $label;
        }

        // Jar metadata often says "1.20" when the provider knows the exact "1.20.1"
        $apiMinecraft = static::primaryGameVersion($versionData);
        if ($apiMinecraft !== ''
            && preg_match('/^(\d+\.\d+(?:\.\d+)?)(-.*)$/', $detected, $match)
            && $match[1] !== $apiMinecraft
            && str_starts_with($apiMinecraft, $match[1].'.')) {
            $detected = $apiMinecraft.$match[2];
        }

        return $detected;
    }

    /**
     * First Minecraft version the provider lists for a file, ignoring loader and Java tags.
     */
    protected static function primaryGameVersion(object $versionData): string
    {
        foreach ((array) ($versionData->gameVersions ?? []) as $gameVersion) {
            if (is_string($gameVersion) && preg_match('/^\d+\.\d+/', $gameVersion)) {
                return $gameVersion;
            }
        }

        return '';
    }

    /**
     * Make a version string safe to use in a file name.
     */
    protected static function sanitizeVersion(string $version): string
    {
        return trim(preg_replace('/[^A-Za-z0-9._+-]+/', '-', $version), '-');
    }

    /**
     * Pick the newest version matching the filters.
     *
     * @param  array<string, object>  $versions  Ordered newest first
     * @param  string  $releaseType  "release"|"beta"|"alpha"|"any"|"" (empty = prefer release > beta > alpha)
     * @param  string  $loader  Only consider files for this loader, when the provider reports loaders
     */
    public static function latestStableVersionForGame(array $versions, string $gameVersion, string $releaseType = '', string $loader = ''): ?string
    {
        $candidates = [];

        foreach ($versions as $key => $version) {
            $gameVersions = (array) ($version->gameVersions ?? []);

            if ($gameVersion !== '' && ! in_array($gameVersion, $gameVersions)) {
                continue;
            }

            $loaders = (array) ($version->loaders ?? []);
            if ($loader !== '' && ! empty($loaders) && ! in_array($loader, $loaders)) {
                continue;
            }

            $type = $version->versionType ?? 'release';

            if ($releaseType !== '' && $releaseType !== 'any' && $type !== $releaseType) {
                continue;
            }

            $candidates[$key] = $type;
        }

        if (empty($candidates)) {
            return null;
        }

        if ($releaseType !== '') {
            return (string) array_key_first($candidates);
        }

        // Default: prefer release > beta > alpha
        foreach (['release', 'beta', 'alpha'] as $preferred) {
            foreach ($candidates as $key => $type) {
                if ($type === $preferred) {
                    return (string) $key;
                }
            }
        }

        return (string) array_key_first($candidates);
    }

    protected static function http(): PendingRequest
    {
        return Http::withHeaders(static::apiHeaders())
            ->connectTimeout(10)
            ->timeout(30)
            ->retry(2, 250, throw: false);
    }

    /**
     * GET a provider API path. Returns the decoded JSON (or raw body), or null on any failure.
     */
    protected static function request(string $url, bool $skipJsonDecode = false): mixed
    {
        try {
            $response = static::http()->get(static::apiUrl().$url);
        } catch (ConnectionException) {
            return null;
        }

        if (! $response->successful()) {
            return null;
        }

        return $skipJsonDecode ? $response->body() : json_decode($response->body());
    }

    /**
     * POST JSON to a provider API path. Returns the decoded JSON, or null on any failure.
     */
    protected static function post(string $url, array $body): mixed
    {
        try {
            $response = static::http()->post(static::apiUrl().$url, $body);
        } catch (ConnectionException) {
            return null;
        }

        return $response->successful() ? json_decode($response->body()) : null;
    }

    /**
     * Download a file to the given path. Returns an error message, or null on success.
     */
    public static function download(string $url, string $destination): ?string
    {
        try {
            $response = Http::withHeaders(static::downloadHeaders())
                ->connectTimeout(15)
                ->timeout(600)
                ->sink($destination)
                ->get($url);
        } catch (ConnectionException $e) {
            return 'download failed: '.$e->getMessage();
        }

        if (! $response->successful()) {
            return "download failed with HTTP {$response->status()}";
        }

        clearstatcache(true, $destination);
        if (! filesize($destination)) {
            // Faked responses in tests don't stream to the sink
            file_put_contents($destination, $response->body());
            clearstatcache(true, $destination);
        }

        return filesize($destination) ? null : 'the downloaded file is empty';
    }
}
