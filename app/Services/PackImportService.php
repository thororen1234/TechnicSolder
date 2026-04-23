<?php

namespace App\Services;

use App\Models\Build;
use App\Models\Mod;
use App\Models\Modpack;
use App\Models\Modversion;
use App\Mods\Providers\CurseForge;
use App\Mods\Providers\Modrinth;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Str;
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
                $mvId = $this->installFromDirectUrl($downloadUrl, $file->path ?? basename($downloadUrl));
                if ($mvId !== null) {
                    $modversionIds[] = $mvId;
                    $this->imported++;
                }
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

    private function installFromDirectUrl(string $url, string $filePath): ?int
    {
        $filename = basename($filePath);
        $slug = $this->slugFromFilename($filename);

        try {
            $tmpPath = tempnam(sys_get_temp_dir(), 'solder_mod_');
            $fp = fopen($tmpPath, 'wb');
            $ch = curl_init($url);
            curl_setopt_array($ch, [
                CURLOPT_FILE           => $fp,
                CURLOPT_FOLLOWLOCATION => true,
                CURLOPT_USERAGENT      => 'TechnicPack/TechnicSolder/' . SOLDER_VERSION,
                CURLOPT_TIMEOUT        => 60,
            ]);
            curl_exec($ch);
            $curlError = curl_error($ch);
            curl_close($ch);
            fclose($fp);

            if ($curlError) {
                $this->errors[] = "Failed to download $filename: $curlError";
                $this->skipped++;
                unlink($tmpPath);
                return null;
            }

            $zip = new ZipArchive();
            if ($zip->open($tmpPath, ZipArchive::RDONLY) !== true) {
                $this->errors[] = "Could not open $filename as a zip/jar archive";
                $this->skipped++;
                unlink($tmpPath);
                return null;
            }

            $modVersion = $this->parseVersionFromJar($zip);
            $zip->close();

            if (empty($modVersion)) {
                $this->errors[] = "Could not detect version for $filename";
                $this->skipped++;
                unlink($tmpPath);
                return null;
            }

            $mod = Mod::firstOrCreate(['name' => $slug], ['pretty_name' => $slug]);

            $existing = Modversion::where(['mod_id' => $mod->id, 'version' => $modVersion])->first();
            if ($existing) {
                unlink($tmpPath);
                return $existing->id;
            }

            $location = config('solder.repo_location');
            $finalPath = $location . "mods/$slug/$slug-$modVersion.zip";
            if (filter_var($finalPath, FILTER_VALIDATE_URL)) {
                $this->errors[] = "Remote repo — cannot save $filename";
                $this->skipped++;
                unlink($tmpPath);
                return null;
            }

            if (! file_exists(dirname($finalPath))) {
                mkdir(dirname($finalPath), 0777, true);
            }

            $out = new ZipArchive();
            $out->open($finalPath, ZipArchive::CREATE | ZipArchive::OVERWRITE);
            $out->addFile($tmpPath, "mods/$filename");
            $out->close();
            unlink($tmpPath);

            $mv = new Modversion();
            $mv->mod_id = $mod->id;
            $mv->version = $modVersion;
            $mv->filesize = filesize($finalPath);
            $mv->md5 = md5_file($finalPath);
            $mv->save();

            return $mv->id;
        } catch (\Throwable $e) {
            $this->errors[] = "Could not install $filename: " . $e->getMessage();
            $this->skipped++;
            return null;
        }
    }

    private function slugFromFilename(string $filename): string
    {
        $base = pathinfo($filename, PATHINFO_FILENAME);
        $parts = preg_split('/[-_+]/', $base);
        $slugParts = [];
        foreach ($parts as $part) {
            if (preg_match('/^\d/', $part)) {
                break;
            }
            $slugParts[] = $part;
        }
        $slug = Str::slug(implode('-', $slugParts));
        return $slug ?: Str::slug($base);
    }

    private function parseVersionFromJar(ZipArchive $zip): string
    {
        $fabricData = $zip->getFromName('fabric.mod.json');
        if ($fabricData !== false) {
            $data = json_decode($fabricData);
            if ($data !== null) {
                $mcVersion = '';
                if (property_exists($data, 'depends') && property_exists($data->depends, 'minecraft')) {
                    $mcVersion = preg_replace('/[^0-9\.]/i', '', explode('-', $data->depends->minecraft)[0]);
                    $mcVersion = $mcVersion ? "$mcVersion-" : '';
                }
                return $mcVersion . ($data->version ?? '');
            }
        }

        $forgeData = $zip->getFromName('mcmod.info');
        if ($forgeData !== false) {
            $data = json_decode($forgeData)[0] ?? null;
            $mcVer = $data->mcversion ?? '';
            $ver = $data->version ?? '';
            if ($data && ! str_contains($ver, '${') && ! str_contains($mcVer, '${') && ! empty($ver)) {
                return "$mcVer-$ver";
            }
        }

        $riftData = $zip->getFromName('riftmod.json');
        if ($riftData !== false) {
            return json_decode($riftData)->version ?? '';
        }

        $tomlData = $zip->getFromName('META-INF/mods.toml');
        if ($tomlData !== false) {
            $parsedVersion = '';
            if (preg_match('/\[\[mods\]\](.*?)(?=\[\[|\z)/s', $tomlData, $modsMatch) &&
                preg_match('/\bversion\s*=\s*"([^"]+)"/', $modsMatch[1], $verMatch)) {
                $parsedVersion = $verMatch[1];
            }

            if ($parsedVersion === '${file.jarVersion}') {
                $manifest = $zip->getFromName('META-INF/MANIFEST.MF');
                if ($manifest !== false &&
                    preg_match('/^Implementation-Version:\s*(.+)$/m', $manifest, $manifestMatch)) {
                    $parsedVersion = trim($manifestMatch[1]);
                } else {
                    $parsedVersion = '';
                }
            }

            if (! empty($parsedVersion)) {
                $mcVer = '';
                if (preg_match_all('/\[\[dependencies\.[^\]]+\]\](.*?)(?=\[\[|\z)/s', $tomlData, $depMatches)) {
                    foreach ($depMatches[1] as $depBlock) {
                        if (preg_match('/\bmodId\s*=\s*"minecraft"/i', $depBlock) &&
                            preg_match('/\bversionRange\s*=\s*"\[([0-9][0-9.]+)/i', $depBlock, $mcMatch)) {
                            $mcVer = $mcMatch[1];
                            break;
                        }
                    }
                }
                return empty($mcVer) ? $parsedVersion : "$mcVer-$parsedVersion";
            }
        }

        return '';
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
