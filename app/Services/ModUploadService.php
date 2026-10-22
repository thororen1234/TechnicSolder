<?php

namespace App\Services;

use App\Models\Mod;
use App\Models\Modversion;
use App\Mods\JarMetadata;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Str;
use ZipArchive;

/**
 * Adds uploaded mod files to the mod repository.
 *
 * A .jar is wrapped into a Solder zip under mods/, and its mod ID, name, author and version are read from the
 * jar's metadata. A .zip is assumed to already be in Solder's layout (mods/, config/, bin/...) and stored as-is.
 */
class ModUploadService
{
    /**
     * @param  list<UploadedFile>  $files
     * @param  Mod|null  $mod  Add the files as versions of this mod; when null each jar creates or extends the mod it declares
     * @param  string|null  $version  Version name to use instead of the detected one (single file uploads)
     * @return array{created: list<array{mod_id: int, mod: string, version: string}>, errors: list<string>}
     */
    public function upload(array $files, ?Mod $mod = null, ?string $version = null): array
    {
        $result = ['created' => [], 'errors' => []];

        if (ModRepository::isRemote()) {
            $result['errors'][] = 'The mod repository is a remote URL, so uploaded files cannot be saved. Set SOLDER_REPO_LOCATION to a local path.';

            return $result;
        }

        foreach ($files as $file) {
            $outcome = $this->store($file, $mod, count($files) === 1 ? $version : null);

            if (isset($outcome['error'])) {
                $result['errors'][] = $file->getClientOriginalName().': '.$outcome['error'];
            } else {
                $result['created'][] = $outcome;
            }
        }

        if (! empty($result['created'])) {
            Cache::forget('mods');
        }

        return $result;
    }

    /**
     * @return array{mod_id: int, mod: string, version: string}|array{error: string}
     */
    private function store(UploadedFile $file, ?Mod $mod, ?string $version): array
    {
        $filename = basename($file->getClientOriginalName());
        $extension = strtolower($file->getClientOriginalExtension());

        if (! in_array($extension, ['jar', 'zip'], true)) {
            return ['error' => 'only .jar and .zip files can be uploaded'];
        }

        $zip = new ZipArchive;
        if ($zip->open($file->getRealPath(), ZipArchive::RDONLY) !== true) {
            return ['error' => 'not a valid jar or zip file'];
        }

        $metadata = JarMetadata::describe($zip);
        $detected = JarMetadata::detectVersion($zip);
        $environment = JarMetadata::environment($zip);
        $zip->close();

        $declared = $metadata['mods'][0] ?? null;

        if ($mod === null) {
            if ($extension === 'zip') {
                return ['error' => 'zips can only be added to an existing mod; upload the .jar instead'];
            }

            $slug = Str::slug($declared['id'] ?? '') ?: Str::slug(pathinfo($filename, PATHINFO_FILENAME));
            $mod = Mod::firstOrCreate(['name' => $slug], [
                'pretty_name' => ($declared['name'] ?? '') ?: Str::headline($slug),
                'author' => $declared['authors'] ?? null,
                'description' => $declared['description'] ?? null,
                'link' => $declared['url'] ?? null,
            ]);
        }

        $versionName = $version ?: ($detected ?: pathinfo($filename, PATHINFO_FILENAME));
        $versionName = trim(preg_replace('/[^A-Za-z0-9._+-]+/', '-', $versionName), '-');

        if ($versionName === '') {
            return ['error' => 'could not work out a version name; enter one'];
        }

        if (Modversion::where(['mod_id' => $mod->id, 'version' => $versionName])->exists()) {
            return ['error' => "{$mod->name} $versionName already exists"];
        }

        $modversion = new Modversion(['mod_id' => $mod->id, 'version' => $versionName, 'environment' => $environment]);
        $modversion->setRelation('mod', $mod);
        $finalPath = ModRepository::location($modversion);

        if (! is_dir(dirname($finalPath)) && ! mkdir(dirname($finalPath), 0775, true) && ! is_dir(dirname($finalPath))) {
            return ['error' => 'could not create the folder in the mod repository'];
        }

        if ($extension === 'zip') {
            copy($file->getRealPath(), $finalPath);
        } else {
            $out = new ZipArchive;
            $out->open($finalPath, ZipArchive::CREATE | ZipArchive::OVERWRITE);
            $out->addFile($file->getRealPath(), "mods/$filename");
            $out->close();
        }

        $modversion->md5 = md5_file($finalPath);
        $modversion->filesize = filesize($finalPath);
        $modversion->save();

        return ['mod_id' => $mod->id, 'mod' => $mod->pretty_name ?: $mod->name, 'version' => $versionName];
    }
}
