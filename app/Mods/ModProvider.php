<?php

namespace App\Mods;

use App\Models\Mod;
use App\Models\Modversion;
use App\Mods\ImportedModData;
use Illuminate\Support\Str;
use ZipArchive;

abstract class ModProvider
{
    abstract public static function name() : string;
    abstract protected static function apiUrl() : string;
    abstract public static function search(string $query, int $page = 1, string $gameVersion = '', string $loader = '') : object;
    abstract public static function mod(string $modId) : ?ImportedModData;
    
    
    protected static function apiHeaders() : array
    {
        return array(
            "User-Agent: TechnicPack/TechnicSolder/" . SOLDER_VERSION
        );
    }

    protected static function zipFolder() : string
    {
        return "mods";
    }

    protected static function useRawVersion() : bool
    {
        return false;
    }

    private static function installVersion(int $modId, string $slug, ImportedModData $modData, string $version)
    {
        $url = $modData->versions[$version]->url;
        $fileName = $modData->versions[$version]->filename;

        $tmpFileName = tempnam(sys_get_temp_dir(), "mod");

        $tmpFile = fopen($tmpFileName, "wb");
        $curl_h = curl_init($url);
        curl_setopt($curl_h, CURLOPT_FILE, $tmpFile);
        curl_setopt($curl_h, CURLOPT_FOLLOWLOCATION, 1);
        curl_setopt($curl_h, CURLOPT_HTTPHEADER, static::apiHeaders());
        curl_exec($curl_h);
        curl_close($curl_h);
        fclose($tmpFile);

        $modVersion = $version;

        if (!static::useRawVersion()) {
            $zip = new ZipArchive();
            $res = $zip->open($tmpFileName, ZipArchive::RDONLY);
            if ($res === false) {
                unlink($tmpFileName);
                return ["mod_corrupt" => "Unable to open mod file for version $version, its likely corrupt"];
            }

            $modVersion = "";

            $forgeData = $zip->getFromName('mcmod.info');
            if ($forgeData !== false) {
                $tmpData = json_decode($forgeData)[0];
                $modVersion = "$tmpData->mcversion-$tmpData->version";
            }

            $fabricData = $zip->getFromName('fabric.mod.json');
            if ($fabricData !== false) {
                $tmpData = json_decode($fabricData);
                if ($tmpData === null) {
                    unlink($tmpFileName);
                    return ["mod_corrupt" => "Unable to parse fabric.mod.json for version $version, its likely invalid"];
                }

                $mcVersion = "";
                if (property_exists($tmpData, "depends") && property_exists($tmpData->depends, "minecraft")) {
                    $mcVersion = $tmpData->depends->minecraft;
                    $mcVersion = preg_replace("/[^0-9\.]/i", "", explode('-', $mcVersion)[0]);
                    $mcVersion = "$mcVersion-";
                }
                $modVersion = $mcVersion.$tmpData->version;
            }

            $riftData = $zip->getFromName('riftmod.json');
            if ($riftData !== false) {
                $modVersion = json_decode($riftData)->version;
            }

            if (empty($modVersion)) {
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

                    if (!empty($parsedVersion)) {
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

                        $modVersion = empty($mcVer) ? $parsedVersion : "$mcVer-$parsedVersion";
                    }
                }
            }

            $zip->close();

            if (!empty($modVersion)) {
                $versionObj = $modData->versions[$version] ?? null;
                $apiMcVersions = array_values(array_filter(
                    (array) ($versionObj->gameVersions ?? []),
                    fn ($v) => (bool) preg_match('/^\d+\.\d+/', $v) && ! str_starts_with($v, 'Java')
                ));
                if (! empty($apiMcVersions)) {
                    $apiMcVer = $apiMcVersions[0];
                    if (preg_match('/^(\d+\.\d+(?:\.\d+)?)(.*)$/', $modVersion, $m) &&
                        $m[1] !== $apiMcVer && str_starts_with($apiMcVer, $m[1] . '.')) {
                        $modVersion = $apiMcVer . $m[2];
                    }
                }
            }

            if (empty($modVersion)) {
                unlink($tmpFileName);
                return ["version_missing" => "Unable to detect version number for $version"];
            }
        }

        if (Modversion::where([
            'mod_id' => $modId,
            'version' => $modVersion,
        ])->count() > 0) {
            unlink($tmpFileName);
            return ["version_exists" => "$modVersion already exists"];
        }

        $location = config('solder.repo_location');
        $finalPath = $location."mods/$slug/$slug-$modVersion.zip";
        if (filter_var($finalPath, FILTER_VALIDATE_URL)) {
            unlink($tmpFileName);
            return ["remote_repo" => "Mod repo in a remote location so unable to download $modVersion"];
        }

        if (!file_exists(dirname($finalPath))) {
            mkdir(dirname($finalPath), 0777, true);
        }

        $zip = new ZipArchive();
        $zip->open($finalPath, ZipArchive::CREATE | ZipArchive::OVERWRITE);
        $zip->addFile($tmpFileName, static::zipFolder() . "/" . $fileName);
        $zip->close();

        $ver = new Modversion();
        $ver->mod_id = $modId;
        $ver->version = $modVersion;
        $ver->filesize = filesize($finalPath);
        $ver->md5 = md5_file($finalPath);
        $ver->save();
    }

    /**
     * @param string $releaseType  "release"|"beta"|"alpha"|"any"|"" (empty = prefer release > beta > alpha)
     */
    public static function latestStableVersionForGame(array $versions, string $gameVersion, string $releaseType = ''): ?string
    {
        $candidates = [];

        foreach ($versions as $key => $version) {
            $gameVersions = (array) ($version->gameVersions ?? []);

            if (!empty($gameVersion) && !in_array($gameVersion, $gameVersions)) {
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
            return array_key_first($candidates);
        }

        // Default: prefer release > beta > alpha
        foreach (['release', 'beta', 'alpha'] as $preferred) {
            foreach ($candidates as $key => $type) {
                if ($type === $preferred) {
                    return $key;
                }
            }
        }

        return array_key_first($candidates);
    }

    public static function install(string $modId, array $versions)
    {
        $modData = static::mod($modId);
        $response = (object) [
            "success" => true,
            "id" => -1,
            "errors" => array()
        ];

        $slug = Str::slug($modData->slug);

        $mod = Mod::where('name', $slug)->first();
        if (empty($mod)) {
            $mod = new Mod();
            $mod->name = $slug;
            $mod->pretty_name = $modData->name;
            $mod->author = $modData->authors;
            $mod->description = $modData->summary;
            $mod->link = $modData->websiteUrl;
            $mod->save();
        }

        $response->id = $mod->id;

        foreach ($versions as $version) {
            $error = static::installVersion($mod->id, $slug, $modData, $version);
            if (!empty($error)) {
                $response->errors = array_merge($response->errors, $error);
            }
        }

        return $response;
    }

    protected static function request(string $url, bool $skipJsonDecode = false)
    {
        $curl_h = curl_init(static::apiUrl() . $url);

        curl_setopt($curl_h, CURLOPT_HTTPHEADER, static::apiHeaders());

        curl_setopt($curl_h, CURLOPT_RETURNTRANSFER, true);

        $response = curl_exec($curl_h);
        if ($skipJsonDecode) {
            return $response;
        } else {
            return json_decode($response);
        }
    }
}