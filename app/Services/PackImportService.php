<?php

namespace App\Services;

use App\Models\Build;
use App\Models\Mod;
use App\Models\Modpack;
use App\Models\Modversion;
use App\Mods\ImportedModData;
use App\Mods\ModProvider;
use App\Mods\Providers\CurseForge;
use App\Mods\Providers\Fabric;
use App\Mods\Providers\Forge;
use App\Mods\Providers\Modrinth;
use App\Mods\Providers\NeoForge;
use App\Mods\Providers\Quilt;
use Closure;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Str;
use ZipArchive;

/**
 * Imports a modpack from a CurseForge zip, a Modrinth .mrpack, or a Solder JSON backup.
 *
 * Mods are added to the mod library, the pack's mod loader and override files (configs, scripts...)
 * are stored as mods of their own, and everything is linked to a new build of a new, hidden modpack,
 * or to a new (or overwritten) build of an existing modpack.
 */
class PackImportService
{
    /** @var list<string> */
    private array $errors = [];

    private int $imported = 0;

    private int $skipped = 0;

    /** The existing modpack to add the build to, or null to create a modpack */
    private ?Modpack $into = null;

    /** Build version to use instead of the archive's */
    private ?string $buildVersion = null;

    /** Whether to replace an existing build with the same version rather than stop */
    private bool $overwrite = false;

    /**
     * @param  (Closure(int $done, int $total, string $message): void)|null  $progress
     * @param  (Closure(string $level, string $message): void)|null  $log  Receives each step and problem, as 'info' or 'error'
     */
    public function __construct(private ?Closure $progress = null, private ?Closure $log = null) {}

    /**
     * @return array{error: string}|array{modpack_id: int, build_id: int, imported: int, skipped: int, errors: list<string>}
     */
    public function importFromFile(UploadedFile $file, string $name, string $slug): array
    {
        return $this->importFromPath($file->getRealPath(), $name, $slug);
    }

    /**
     * @return array{error: string}|array{modpack_id: int, build_id: int, imported: int, skipped: int, errors: list<string>}
     */
    public function importFromPath(string $path, string $name, string $slug): array
    {
        return $this->process($path, $name, $slug);
    }

    /**
     * Import the archive as a build of an existing modpack. When the modpack already has a build with that version,
     * nothing is changed and a conflict is returned unless $overwrite is set.
     *
     * @param  string|null  $version  Build version to use instead of the one in the archive
     * @return array{error: string}|array{conflict: string}|array{modpack_id: int, build_id: int, imported: int, skipped: int, errors: list<string>}
     */
    public function importIntoModpack(string $path, Modpack $modpack, ?string $version = null, bool $overwrite = false): array
    {
        $this->into = $modpack;
        $this->buildVersion = $version;
        $this->overwrite = $overwrite;

        try {
            return $this->process($path, '', '');
        } finally {
            $this->into = null;
            $this->buildVersion = null;
            $this->overwrite = false;
        }
    }

    /**
     * @return array{error: string}|array{modpack_id: int, build_id: int, imported: int, skipped: int, errors: list<string>}
     */
    public function importFromUrl(string $url, string $name, string $slug): array
    {
        $tmpPath = tempnam(sys_get_temp_dir(), 'solder_pack_');

        try {
            $error = ModProvider::download($url, $tmpPath);
            if ($error !== null) {
                return ['error' => "Could not download the archive: $error"];
            }

            return $this->process($tmpPath, $name, $slug);
        } finally {
            if (file_exists($tmpPath)) {
                unlink($tmpPath);
            }
        }
    }

    private function process(string $path, string $name, string $slug): array
    {
        $this->errors = [];
        $this->imported = 0;
        $this->skipped = 0;

        $backup = $this->readSolderBackup($path);
        if ($backup !== null) {
            if ($this->into !== null) {
                return ['error' => 'A Solder backup holds a whole modpack, so it can only be restored as a new modpack.'];
            }

            return $this->importSolderBackup($backup, $name, $slug);
        }

        $zip = new ZipArchive;
        if ($zip->open($path, ZipArchive::RDONLY) !== true) {
            return ['error' => 'Could not open the archive. Upload a CurseForge .zip, a Modrinth .mrpack or a Solder .json backup.'];
        }

        try {
            if ($zip->locateName('modrinth.index.json') !== false) {
                return $this->importModrinth($zip, $name, $slug);
            }

            if ($zip->locateName('manifest.json') !== false) {
                return $this->importCurseForge($zip, $name, $slug);
            }

            return ['error' => 'Unrecognized modpack format. Expected a CurseForge .zip (manifest.json) or a Modrinth .mrpack (modrinth.index.json).'];
        } finally {
            $zip->close();
        }
    }

    private function importCurseForge(ZipArchive $zip, string $name, string $slug): array
    {
        $manifest = json_decode((string) $zip->getFromName('manifest.json'));

        if (! is_object($manifest) || ($manifest->manifestType ?? 'minecraftModpack') !== 'minecraftModpack') {
            return ['error' => 'manifest.json is not a valid CurseForge modpack manifest.'];
        }

        $files = array_values(array_filter(
            $manifest->files ?? [],
            fn ($file) => ! empty($file->fileID) && ($file->required ?? true) !== false
        ));

        if (! empty($files) && ! CurseForge::hasApiKey()) {
            return ['error' => 'Importing CurseForge modpacks requires a CurseForge API key. Set CURSEFORGE_API_KEY in your .env file.'];
        }

        $minecraft = (string) ($manifest->minecraft->version ?? '');
        $loaders = $manifest->minecraft->modLoaders ?? [];
        $primaryLoader = collect($loaders)->firstWhere('primary', true) ?? ($loaders[0] ?? null);
        [$loaderType, $loaderVersion] = $this->parseCurseForgeLoader((string) ($primaryLoader->id ?? ''));

        $build = $this->prepareBuild($name ?: ($manifest->name ?? 'Imported Pack'), $slug, (string) ($manifest->version ?? '1.0'), $minecraft, $primaryLoader->id ?? '');
        if (is_array($build)) {
            return $build;
        }
        $modpack = $build->modpack;
        $this->note(sprintf('CurseForge pack %s %s: %d mods for Minecraft %s, %s', $manifest->name ?? '', $manifest->version ?? '', count($files), $minecraft ?: '?', ($primaryLoader->id ?? '') ?: 'no mod loader'));

        $modversionIds = [];

        $this->report(0, count($files), 'Looking up mods on CurseForge');
        $mods = CurseForge::modsForFiles(array_map(fn ($file) => $file->fileID, $files));
        foreach ($files as $index => $file) {
            $projectId = (string) ($file->projectID ?? '');
            $fileId = (string) $file->fileID;
            $modData = $mods[$projectId] ?? null;

            if ($modData === null || ! isset($modData->versions[$fileId])) {
                $this->fail("CurseForge file $fileId (project $projectId) could not be found");

                continue;
            }

            $this->report($index, count($files), "Downloading {$modData->name}");
            $this->installVersion(CurseForge::class, $projectId, $fileId, $modData, $modversionIds);
        }

        $this->installLoader($loaderType, $loaderVersion, $minecraft, $modversionIds);
        $this->installOverrides($zip, [($manifest->overrides ?? 'overrides') ?: 'overrides'], $modpack, $build->version, $modversionIds);

        $build->modversions()->sync(array_unique($modversionIds));

        return $this->result($modpack, $build);
    }

    private function importModrinth(ZipArchive $zip, string $name, string $slug): array
    {
        $index = json_decode((string) $zip->getFromName('modrinth.index.json'));

        if (! is_object($index) || ($index->game ?? 'minecraft') !== 'minecraft') {
            return ['error' => 'modrinth.index.json is not a valid Minecraft modpack index.'];
        }

        $dependencies = (array) ($index->dependencies ?? []);
        $minecraft = (string) ($dependencies['minecraft'] ?? '');

        $loaderType = '';
        $loaderVersion = '';
        foreach (['neoforge' => 'neoforge', 'forge' => 'forge', 'fabric-loader' => 'fabric', 'quilt-loader' => 'quilt'] as $key => $type) {
            if (! empty($dependencies[$key])) {
                [$loaderType, $loaderVersion] = [$type, (string) $dependencies[$key]];
                break;
            }
        }

        $build = $this->prepareBuild($name ?: ($index->name ?? 'Imported Pack'), $slug, (string) ($index->versionId ?? '1.0'), $minecraft, $loaderType ? "$loaderType-$loaderVersion" : '');
        if (is_array($build)) {
            return $build;
        }
        $modpack = $build->modpack;

        $modversionIds = [];

        // Skip files the client doesn't use (server-only mods)
        $files = array_values(array_filter(
            $index->files ?? [],
            fn ($file) => ($file->env->client ?? 'required') !== 'unsupported' && ! empty($file->downloads)
        ));

        $modrinthFiles = [];
        $otherFiles = [];
        foreach ($files as $file) {
            if (preg_match('#^https://cdn\.modrinth\.com/data/([^/]+)/versions/([^/]+)/#', $file->downloads[0], $match)) {
                $modrinthFiles[] = [$file, $match[1], $match[2]];
            } else {
                $otherFiles[] = $file;
            }
        }

        $total = count($files);
        $this->note(sprintf('Modrinth pack %s %s: %d files for Minecraft %s, %s', $index->name ?? '', $index->versionId ?? '', $total, $minecraft ?: '?', $loaderType ? "$loaderType $loaderVersion" : 'no mod loader'));
        $this->report(0, $total, 'Looking up mods on Modrinth');
        $mods = Modrinth::modsForVersions(array_map(fn ($entry) => $entry[2], $modrinthFiles));
        $done = 0;
        foreach ($modrinthFiles as [$file, $projectId, $versionId]) {
            $modData = $mods[$projectId] ?? null;

            if ($modData === null || ! isset($modData->versions[$versionId])) {
                // Not resolvable through the API (deleted project?): fall back to the direct download
                $otherFiles[] = $file;

                continue;
            }

            $modData->versions[$versionId]->folder = $this->folderFromPath($file->path ?? '');
            $modData->versions[$versionId]->environment = $this->environmentFromIndex($file) ?? $modData->environment;
            $modData->versions[$versionId]->filename = basename($file->path ?? $modData->versions[$versionId]->filename);
            $this->report($done++, $total, "Downloading {$modData->name}");
            $this->installVersion(Modrinth::class, $projectId, $versionId, $modData, $modversionIds);
        }

        foreach ($otherFiles as $file) {
            $this->report($done++, $total, 'Downloading '.basename((string) ($file->path ?? 'file')));
            $this->installDirectFile($file, $minecraft, $modversionIds);
        }

        $this->installLoader($loaderType, $loaderVersion, $minecraft, $modversionIds);
        $this->installOverrides($zip, ['overrides', 'client-overrides'], $modpack, $build->version, $modversionIds);

        $build->modversions()->sync(array_unique($modversionIds));

        return $this->result($modpack, $build);
    }

    /**
     * Install a file listed in a .mrpack that isn't hosted on Modrinth, using its download URL directly.
     *
     * @param  list<int>  $modversionIds
     */
    private function installDirectFile(object $file, string $minecraft, array &$modversionIds): void
    {
        $path = (string) ($file->path ?? basename($file->downloads[0]));
        $filename = basename($path);
        $slug = $this->slugFromFilename($filename);

        $modData = new ImportedModData;
        $modData->id = $slug;
        $modData->slug = $slug;
        $modData->name = Str::headline($slug);
        $modData->versions[$filename] = (object) [
            'url' => $file->downloads[0],
            'filename' => $filename,
            'label' => pathinfo($filename, PATHINFO_FILENAME),
            'gameVersions' => $minecraft !== '' ? [$minecraft] : [],
            'folder' => $this->folderFromPath($path),
            'environment' => $this->environmentFromIndex($file),
            'sha1' => $file->hashes->sha1 ?? null,
            // Not actually from Modrinth, so don't record it as a Modrinth file
            'untracked' => true,
        ];

        $this->installVersion(Modrinth::class, $slug, $filename, $modData, $modversionIds);
    }

    /**
     * @param  class-string<ModProvider>  $provider
     * @param  list<int>  $modversionIds
     */
    private function installVersion(string $provider, string $modId, string $versionKey, ImportedModData $modData, array &$modversionIds): void
    {
        $result = $provider::install($modId, [$versionKey], $modData);

        if (isset($result->modversionIds[$versionKey])) {
            $modversionIds[] = (int) $result->modversionIds[$versionKey];
            $this->imported++;
            $this->note("Added {$modData->name} ".($modData->versions[$versionKey]->label ?? $versionKey));
        } else {
            $this->fail(...($result->errors ?: ["{$modData->name}: import failed"]));
        }
    }

    /**
     * Add the pack's mod loader (bin/modpack.jar or bin/version.json) to the build.
     *
     * @param  list<int>  $modversionIds
     */
    private function installLoader(string $type, string $version, string $minecraft, array &$modversionIds): void
    {
        if ($type === '' || $version === '' || $minecraft === '') {
            return;
        }

        /** @var class-string<ModProvider>|null $provider */
        $provider = [
            'forge' => Forge::class,
            'neoforge' => NeoForge::class,
            'fabric' => Fabric::class,
            'quilt' => Quilt::class,
        ][$type] ?? null;

        $loaderData = $provider ? $provider::mod($minecraft) : null;

        $candidates = match ($type) {
            'forge' => ["$minecraft-forge-$version", "$minecraft-forge-$version-$minecraft"],
            'neoforge' => ["neoforge-$version", "forge-$minecraft-$version"],
            default => ["$minecraft-$version"],
        };

        $this->report(1, 1, "Adding $type $version");
        $key = collect($candidates)->first(fn ($candidate) => isset($loaderData->versions[$candidate]));

        if ($key === null) {
            $this->fail("Could not find $type $version for Minecraft $minecraft. Add the mod loader to the build manually.");

            return;
        }

        $this->installVersion($provider, $minecraft, $key, $loaderData, $modversionIds);
    }

    /**
     * Store the pack's override files (configs, scripts, resource packs...) as a mod linked to the build.
     *
     * @param  list<string>  $prefixes  Folders inside the archive whose contents are extracted to the game folder
     * @param  list<int>  $modversionIds
     */
    private function installOverrides(ZipArchive $source, array $prefixes, Modpack $modpack, string $version, array &$modversionIds): void
    {
        $entries = [];
        for ($i = 0; $i < $source->numFiles; $i++) {
            $entryName = (string) $source->getNameIndex($i);

            foreach ($prefixes as $prefix) {
                $prefix = trim($prefix, '/').'/';
                if (str_starts_with($entryName, $prefix) && ! str_ends_with($entryName, '/')) {
                    $relative = substr($entryName, strlen($prefix));
                    // Guard against path traversal in untrusted archives
                    if ($relative !== '' && ! str_contains($relative, '..')) {
                        $entries[$relative] = $i;
                    }
                }
            }
        }

        if (empty($entries)) {
            return;
        }

        $repo = config('solder.repo_location');
        if (filter_var($repo, FILTER_VALIDATE_URL)) {
            $this->fail('The mod repository is a remote URL, so the pack\'s override files could not be saved.');

            return;
        }

        $modSlug = Str::slug("{$modpack->slug}-overrides");
        $mod = Mod::firstOrCreate(['name' => $modSlug], [
            'pretty_name' => "{$modpack->name} Overrides",
            'description' => "Configs and other files bundled with the {$modpack->name} modpack.",
        ]);
        Cache::forget('mods');

        $versionName = trim(preg_replace('/[^A-Za-z0-9._+-]+/', '-', $version), '-') ?: '1.0';
        $finalPath = $repo."mods/$modSlug/$modSlug-$versionName.zip";

        if (! is_dir(dirname($finalPath))) {
            mkdir(dirname($finalPath), 0775, true);
        }

        $out = new ZipArchive;
        if ($out->open($finalPath, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
            $this->fail("Could not write $finalPath");

            return;
        }
        foreach ($entries as $relative => $index) {
            $out->addFromString($relative, (string) $source->getFromIndex($index));
        }
        $out->close();

        $modversion = Modversion::updateOrCreate(
            ['mod_id' => $mod->id, 'version' => $versionName],
            ['filesize' => filesize($finalPath), 'md5' => md5_file($finalPath)],
        );
        $this->note('Saved '.count($entries)." override files (configs, scripts...) as $modSlug $versionName");

        $modversionIds[] = $modversion->id;
    }

    /**
     * Decode a Solder JSON backup, or return null when the file isn't one.
     */
    private function readSolderBackup(string $path): ?array
    {
        $handle = fopen($path, 'rb');
        $start = $handle ? ltrim((string) fread($handle, 64)) : '';
        if ($handle) {
            fclose($handle);
        }

        if (! str_starts_with($start, '{')) {
            return null;
        }

        $data = json_decode((string) file_get_contents($path), true);

        return is_array($data) && ($data['format'] ?? null) === PackExportService::BACKUP_FORMAT ? $data : null;
    }

    /**
     * Recreate a modpack from a Solder JSON backup. Mod files are expected to already be in the mod repository.
     */
    private function importSolderBackup(array $backup, string $name, string $slug): array
    {
        $source = $backup['modpack'] ?? [];
        $modpack = $this->createModpack($slug, $name ?: ($source['name'] ?? 'Imported Pack'));
        $modpack->fill(array_intersect_key($source, array_flip(['recommended', 'latest', 'private'])));
        $modpack->save();

        $modversionsByKey = [];
        foreach ($backup['mods'] ?? [] as $modData) {
            if (empty($modData['name'])) {
                continue;
            }

            $mod = Mod::firstOrCreate(['name' => $modData['name']], array_intersect_key(
                $modData + ['pretty_name' => $modData['name']],
                array_flip(['pretty_name', 'author', 'description', 'link'])
            ));

            foreach ($modData['versions'] ?? [] as $versionData) {
                $modversion = Modversion::firstOrCreate(
                    ['mod_id' => $mod->id, 'version' => $versionData['version']],
                    ['md5' => $versionData['md5'] ?? '', 'filesize' => $versionData['filesize'] ?? 0] + array_intersect_key(
                        $versionData,
                        array_flip(['provider', 'provider_project_id', 'provider_version_id', 'environment'])
                    ),
                );
                $modversionsByKey[$mod->name."\0".$modversion->version] = $modversion->id;
                $this->imported++;
            }
        }
        Cache::forget('mods');

        $lastBuild = null;
        foreach ($backup['builds'] ?? [] as $buildData) {
            $build = new Build(array_intersect_key($buildData, array_flip([
                'version', 'minecraft', 'forge', 'is_published', 'private', 'min_java', 'java_runtime', 'min_memory',
            ])));
            $build->modpack_id = $modpack->id;
            $build->save();

            $ids = [];
            foreach ($buildData['mods'] ?? [] as $entry) {
                $id = $modversionsByKey[($entry['name'] ?? '')."\0".($entry['version'] ?? '')] ?? null;
                if ($id === null) {
                    $this->fail("Build {$build->version}: {$entry['name']} {$entry['version']} is missing from the backup");

                    continue;
                }
                $ids[] = $id;
            }
            $build->modversions()->sync($ids);
            $lastBuild = $build;
        }

        if ($lastBuild === null) {
            return ['error' => 'The backup contains no builds.'];
        }

        return $this->result($modpack, $lastBuild);
    }

    /**
     * Split a CurseForge loader id such as "forge-47.2.0" or "fabric-0.15.11" into [type, version].
     *
     * @return array{0: string, 1: string}
     */
    private function parseCurseForgeLoader(string $id): array
    {
        if (! preg_match('/^(neoforge|forge|fabric|quilt)-(.+)$/', $id, $match)) {
            return ['', ''];
        }

        return [$match[1], $match[2]];
    }

    /**
     * "client" when a .mrpack file isn't used on servers. (Files the client doesn't use are skipped entirely.)
     */
    private function environmentFromIndex(object $file): ?string
    {
        return ($file->env->server ?? 'required') === 'unsupported' ? 'client' : null;
    }

    private function folderFromPath(string $path): string
    {
        $folder = trim(dirname(str_replace('\\', '/', $path)), './');

        return str_contains($folder, '..') ? 'mods' : ($folder ?: 'mods');
    }

    private function slugFromFilename(string $filename): string
    {
        $base = pathinfo($filename, PATHINFO_FILENAME);
        $slugParts = [];
        foreach (preg_split('/[-_+ ]/', $base) as $part) {
            if (preg_match('/^v?\d/i', $part)) {
                break;
            }
            $slugParts[] = $part;
        }

        return Str::slug(implode('-', $slugParts)) ?: Str::slug($base);
    }

    /**
     * The build to import into: a new build of a new modpack, a new build of the modpack being imported into,
     * or, when overwriting, that modpack's build with the same version.
     *
     * @return Build|array{conflict: string}
     */
    private function prepareBuild(string $name, string $slug, string $version, string $minecraft, string $loader): Build|array
    {
        $version = $this->buildVersion ?: $version;

        if ($this->into === null) {
            return $this->createBuild($this->createModpack($slug, $name), $version, $minecraft, $loader);
        }

        $existing = Build::where('modpack_id', $this->into->id)->where('version', $version)->first();
        if ($existing === null) {
            $this->note("Adding build $version to {$this->into->name}");

            return $this->createBuild($this->into, $version, $minecraft, $loader);
        }

        if (! $this->overwrite) {
            return ['conflict' => $version];
        }

        $this->note("Overwriting build $version of {$this->into->name}; its mods are replaced with the pack's");
        $existing->minecraft = $minecraft;
        $existing->forge = $loader ?: null;
        $existing->save();

        return $existing;
    }

    private function createModpack(string $slug, string $name): Modpack
    {
        $modpack = new Modpack;
        $modpack->name = $name;
        $modpack->slug = $slug;
        $modpack->hidden = true;
        $modpack->icon_url = asset('/resources/default/icon.png');
        $modpack->logo_url = asset('/resources/default/logo.png');
        $modpack->background_url = asset('/resources/default/background.jpg');
        $modpack->save();

        return $modpack;
    }

    private function createBuild(Modpack $modpack, string $version, string $minecraft, string $loader): Build
    {
        $build = new Build;
        $build->modpack_id = $modpack->id;
        $build->version = $version;
        $build->minecraft = $minecraft;
        $build->forge = $loader ?: null;
        $build->is_published = false;
        $build->save();

        return $build;
    }

    private function report(int $done, int $total, string $message): void
    {
        if ($this->progress !== null) {
            ($this->progress)($done, $total, $message);
        }
    }

    private function fail(string ...$messages): void
    {
        array_push($this->errors, ...$messages);
        $this->skipped++;

        foreach ($messages as $message) {
            $this->writeLog('error', $message);
        }
    }

    private function note(string $message): void
    {
        $this->writeLog('info', $message);
    }

    /**
     * @param  'info'|'error'  $level
     */
    private function writeLog(string $level, string $message): void
    {
        if ($this->log !== null) {
            ($this->log)($level, $message);
        }
    }

    private function result(Modpack $modpack, Build $build): array
    {
        return [
            'modpack_id' => $modpack->id,
            'build_id' => $build->id,
            'imported' => $this->imported,
            'skipped' => $this->skipped,
            'errors' => $this->errors,
        ];
    }
}
