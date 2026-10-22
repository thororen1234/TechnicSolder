<?php

namespace App\Services;

use App\Libraries\UrlUtils;
use App\Models\Modversion;
use App\Mods\ModProvider;

/**
 * Access to mod version zips in the mod repository (SOLDER_REPO_LOCATION), which is either a
 * local path or a remote URL. Remote files are downloaded to temporary files on demand.
 */
class ModRepository
{
    /** @var list<string> */
    private array $tempFiles = [];

    public static function isRemote(): bool
    {
        return (bool) filter_var(config('solder.repo_location'), FILTER_VALIDATE_URL);
    }

    /**
     * Full path or URL of a mod version's zip.
     */
    public static function location(Modversion $modversion): string
    {
        return config('solder.repo_location').$modversion->repositoryPath();
    }

    /**
     * Path to a readable copy of the zip, downloading it when the repository is remote.
     *
     * @return array{path: string}|array{error: string}
     */
    public function localCopy(Modversion $modversion): array
    {
        $location = static::location($modversion);

        if (! static::isRemote()) {
            return is_file($location)
                ? ['path' => $location]
                : ['error' => "{$modversion->repositoryPath()} is missing from the mod repository"];
        }

        $tmp = tempnam(sys_get_temp_dir(), 'solder_repo_');
        $this->tempFiles[] = $tmp;

        $error = ModProvider::download($location, $tmp);

        return $error === null ? ['path' => $tmp] : ['error' => $error];
    }

    /**
     * Current checksum and size of the file in the repository.
     *
     * @return array{success: true, md5: string, filesize: int}|array{success: false, message: string}
     */
    public static function checksum(Modversion $modversion): array
    {
        $location = static::location($modversion);

        if (static::isRemote()) {
            $result = UrlUtils::get_remote_md5($location);

            return $result['success']
                ? ['success' => true, 'md5' => $result['md5'], 'filesize' => (int) ($result['filesize'] ?? 0)]
                : ['success' => false, 'message' => $result['message'] ?? 'Could not fetch the file'];
        }

        if (! is_file($location)) {
            return ['success' => false, 'message' => 'File not found'];
        }

        return ['success' => true, 'md5' => md5_file($location), 'filesize' => filesize($location)];
    }

    /**
     * Delete any temporary downloads.
     */
    public function cleanup(): void
    {
        foreach ($this->tempFiles as $tempFile) {
            if (file_exists($tempFile)) {
                unlink($tempFile);
            }
        }

        $this->tempFiles = [];
    }

    public function __destruct()
    {
        $this->cleanup();
    }
}
