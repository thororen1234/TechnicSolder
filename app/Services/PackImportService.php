<?php

namespace App\Services;

use App\Models\Build;
use App\Models\Modpack;
use App\Models\Modversion;
use App\Mods\Providers\CurseForge;
use App\Mods\Providers\Modrinth;
use Illuminate\Http\UploadedFile;
use ZipArchive;

class PackImportService
{
    private array $errors = [];
    private int $imported = 0;
    private int $skipped = 0;

    public function importFromFile(UploadedFile $file, string $name, string $slug): array
    {
        return $this->processZip($file->getRealPath(), $name, $slug);
    }

    public function importFromUrl(string $url, string $name, string $slug): array
    {
        $tmpPath = tempnam(sys_get_temp_dir(), 'solder_pack_');

        $fp = fopen($tmpPath, 'wb');
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_FILE          => $fp,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_USERAGENT     => 'TechnicPack/TechnicSolder/' . SOLDER_VERSION,
            CURLOPT_TIMEOUT       => 120,
        ]);
        curl_exec($ch);
        $curlError = curl_error($ch);
        curl_close($ch);
        fclose($fp);

        if ($curlError) {
            unlink($tmpPath);
            return ['error' => "Failed to download archive: $curlError"];
        }

        $result = $this->processZip($tmpPath, $name, $slug);
        unlink($tmpPath);

        return $result;
    }

    private function processZip(string $zipPath, string $name, string $slug): array
    {
        $this->errors = [];
        $this->imported = 0;
        $this->skipped = 0;

        $zip = new ZipArchive();
        if ($zip->open($zipPath) !== true) {
            return ['error' => 'Could not open archive — make sure it is a valid ZIP or mrpack file.'];
        }

        if ($zip->locateName('manifest.json') !== false) {
            return $this->importCurseForge($zip, $name, $slug);
        }

        if ($zip->locateName('modrinth.index.json') !== false) {
            return $this->importModrinth($zip, $name, $slug);
        }

        $zip->close();
        return ['error' => 'Unrecognized modpack format. Expected a CurseForge (.zip) or Modrinth (.mrpack) modpack.'];
    }

    private function importCurseForge(ZipArchive $zip, string $name, string $slug): array
    {
        $manifest = json_decode($zip->getFromName('manifest.json'));
        $zip->close();

        if (! $manifest) {
            return ['error' => 'Could not parse manifest.json.'];
        }

        $packName    = $name ?: ($manifest->name ?? 'Imported Pack');
        $packVersion = $manifest->version ?? '1.0';
        $mcVersion   = $manifest->minecraft->version ?? '';
        $loaderStr   = '';

        foreach ($manifest->minecraft->modLoaders ?? [] as $loader) {
            if ($loader->primary ?? false) {
                $loaderStr = $loader->id;
                break;
            }
        }

        $modpack = $this->createModpack($slug, $packName);
        $build   = $this->createBuild($modpack, $packVersion, $mcVersion, $loaderStr);

        $modversionIds = [];

        foreach ($manifest->files ?? [] as $file) {
            if (isset($file->required) && ! $file->required) {
                continue;
            }

            $projectId = (string) ($file->projectID ?? '');
            $fileId    = (string) ($file->fileID ?? '');

            if (! $projectId || ! $fileId) {
                continue;
            }

            $mvId = $this->installFromCurseForge($projectId, $fileId);
            if ($mvId !== null) {
                $modversionIds[] = $mvId;
                $this->imported++;
            }
        }

        $build->modversions()->sync($modversionIds);

        return $this->buildResult($modpack, $build);
    }

    private function importModrinth(ZipArchive $zip, string $name, string $slug): array
    {
        $index = json_decode($zip->getFromName('modrinth.index.json'));
        $zip->close();

        if (! $index) {
            return ['error' => 'Could not parse modrinth.index.json.'];
        }

        $packName    = $name ?: ($index->name ?? 'Imported Pack');
        $packVersion = $index->versionId ?? '1.0';
        $deps        = (array) ($index->dependencies ?? []);
        $mcVersion   = $deps['minecraft'] ?? '';

        $loaderStr = '';
        foreach (['fabric-loader', 'quilt-loader', 'forge', 'neoforge'] as $loaderKey) {
            if (! empty($deps[$loaderKey])) {
                $loaderStr = $loaderKey . '-' . $deps[$loaderKey];
                break;
            }
        }

        $modpack = $this->createModpack($slug, $packName);
        $build   = $this->createBuild($modpack, $packVersion, $mcVersion, $loaderStr);

        $modversionIds = [];

        foreach ($index->files ?? [] as $file) {
            $downloads = (array) ($file->downloads ?? []);
            if (empty($downloads)) {
                continue;
            }

            $downloadUrl = $downloads[0];

            if (! preg_match('#/data/([^/]+)/versions/([^/]+)/#', $downloadUrl, $m)) {
                $this->errors[] = 'Could not parse download URL for: ' . basename($file->path ?? 'unknown file');
                $this->skipped++;
                continue;
            }

            $projectId = $m[1];
            $versionId = $m[2];

            $mvId = $this->installFromModrinth($projectId, $versionId);
            if ($mvId !== null) {
                $modversionIds[] = $mvId;
                $this->imported++;
            }
        }

        $build->modversions()->sync($modversionIds);

        return $this->buildResult($modpack, $build);
    }

    private function installFromCurseForge(string $projectId, string $fileId): ?int
    {
        try {
            $maxBefore = Modversion::max('id') ?? 0;
            $result    = CurseForge::install($projectId, [$fileId]);

            return $this->resolveModversionId($result, $maxBefore);
        } catch (\Throwable $e) {
            $this->errors[] = "CurseForge project $projectId: " . $e->getMessage();
            $this->skipped++;
            return null;
        }
    }

    private function installFromModrinth(string $projectId, string $versionId): ?int
    {
        try {
            $modData = Modrinth::mod($projectId);

            if (! $modData) {
                $this->errors[] = "Modrinth project not found: $projectId";
                $this->skipped++;
                return null;
            }

            $versionKey = null;
            foreach ($modData->versions as $key => $v) {
                if (str_contains($v->url ?? '', "/$versionId/")) {
                    $versionKey = $key;
                    break;
                }
            }

            if ($versionKey === null) {
                $this->errors[] = "Version $versionId not found for Modrinth project $projectId";
                $this->skipped++;
                return null;
            }

            $maxBefore = Modversion::max('id') ?? 0;
            $result    = Modrinth::install($projectId, [$versionKey]);

            return $this->resolveModversionId($result, $maxBefore);
        } catch (\Throwable $e) {
            $this->errors[] = "Modrinth project $projectId: " . $e->getMessage();
            $this->skipped++;
            return null;
        }
    }

    private function resolveModversionId(object $result, int $maxBefore): ?int
    {
        if ($result->id <= 0) {
            $this->errors = array_merge($this->errors, array_values($result->errors));
            $this->skipped++;
            return null;
        }

        $mv = Modversion::where('mod_id', $result->id)
            ->where('id', '>', $maxBefore)
            ->first();

        if ($mv) {
            return $mv->id;
        }

        if (isset($result->errors['version_exists'])) {
            $mv = Modversion::where('mod_id', $result->id)->orderByDesc('id')->first();
            return $mv?->id;
        }

        if (! empty($result->errors)) {
            $this->errors = array_merge($this->errors, array_values($result->errors));
            $this->skipped++;
        }

        return null;
    }

    private function createModpack(string $slug, string $name): Modpack
    {
        $modpack                  = new Modpack();
        $modpack->name            = $name;
        $modpack->slug            = $slug;
        $modpack->hidden          = true;
        $modpack->icon_url        = asset('/resources/default/icon.png');
        $modpack->logo_url        = asset('/resources/default/logo.png');
        $modpack->background_url  = asset('/resources/default/background.jpg');
        $modpack->save();

        return $modpack;
    }

    private function createBuild(Modpack $modpack, string $version, string $mcVersion, string $loaderStr): Build
    {
        $build              = new Build();
        $build->modpack_id  = $modpack->id;
        $build->version     = $version;
        $build->minecraft   = $mcVersion;
        $build->forge       = $loaderStr ?: null;
        $build->is_published = false;
        $build->save();

        return $build;
    }

    private function buildResult(Modpack $modpack, Build $build): array
    {
        return [
            'modpack_id' => $modpack->id,
            'build_id'   => $build->id,
            'imported'   => $this->imported,
            'skipped'    => $this->skipped,
            'errors'     => $this->errors,
        ];
    }
}
