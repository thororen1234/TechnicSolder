<?php

namespace App\Services;

use App\Models\Build;
use App\Models\Modpack;
use App\Models\Modversion;
use App\Mods\ModProvider;
use App\Mods\Providers\Modrinth;
use Generator;
use ZipArchive;

/**
 * Exports builds as client/server zips or Modrinth/CurseForge modpacks, and modpacks as Solder JSON backups.
 */
class PackExportService
{
    public const BACKUP_FORMAT = 'solder-modpack';

    /**
     * Build export formats.
     *
     * @var array<string, array{label: string, description: string, extension: string, suffix: string}>
     */
    public const FORMATS = [
        'technic' => [
            'label' => 'Client zip',
            'description' => 'Every mod, config and the loader merged, as the Technic launcher installs it',
            'extension' => 'zip',
            'suffix' => '',
        ],
        'server' => [
            'label' => 'Server zip',
            'description' => 'Mods and configs plus the loader installer, for running a server',
            'extension' => 'zip',
            'suffix' => '-server',
        ],
        'mrpack' => [
            'label' => 'Modrinth (.mrpack)',
            'description' => 'For Prism, ATLauncher and the Modrinth App',
            'extension' => 'mrpack',
            'suffix' => '',
        ],
        'curseforge' => [
            'label' => 'CurseForge (.zip)',
            'description' => 'For the CurseForge app and other launchers',
            'extension' => 'zip',
            'suffix' => '-curseforge',
        ],
    ];

    /** Keys used for the loader in a Modrinth index's dependencies */
    private const MRPACK_LOADER_KEYS = [
        'forge' => 'forge',
        'neoforge' => 'neoforge',
        'fabric' => 'fabric-loader',
        'quilt' => 'quilt-loader',
    ];

    /** @var list<string> */
    private array $warnings = [];

    /** @var list<string> */
    private array $tempFiles = [];

    /**
     * Export a build. The caller is responsible for deleting the returned file.
     *
     * @return array{path: string, filename: string}
     */
    public function exportBuild(Build $build, string $format): array
    {
        if (! isset(self::FORMATS[$format])) {
            throw new \InvalidArgumentException("Unknown export format \"$format\"");
        }

        $this->warnings = [];
        $build->loadMissing('modpack', 'modversions.mod');

        $path = tempnam(sys_get_temp_dir(), 'solder_export_');
        $zip = new ZipArchive;
        $zip->open($path, ZipArchive::CREATE | ZipArchive::OVERWRITE);

        try {
            match ($format) {
                'technic' => $this->writeClient($build, $zip),
                'server' => $this->writeServer($build, $zip),
                'mrpack' => $this->writeMrpack($build, $zip),
                'curseforge' => $this->writeCurseForge($build, $zip),
            };

            if (! empty($this->warnings)) {
                $zip->addFromString('EXPORT_WARNINGS.txt', "Some files could not be exported:\n\n- ".implode("\n- ", $this->warnings)."\n");
            }

            $zip->close();
        } finally {
            foreach ($this->tempFiles as $tempFile) {
                if (file_exists($tempFile)) {
                    unlink($tempFile);
                }
            }
            $this->tempFiles = [];
        }

        $version = trim(preg_replace('/[^A-Za-z0-9._+-]+/', '-', $build->version), '-');
        $options = self::FORMATS[$format];

        return [
            'path' => $path,
            'filename' => "{$build->modpack->slug}-$version{$options['suffix']}.{$options['extension']}",
        ];
    }

    /**
     * A JSON-serializable backup of a modpack, its builds and the mod versions they use.
     */
    public function backup(Modpack $modpack): array
    {
        $modpack->loadMissing('builds.modversions.mod');

        $mods = [];
        foreach ($modpack->builds as $build) {
            foreach ($build->modversions as $modversion) {
                $mod = $modversion->mod;
                $mods[$mod->name] ??= $mod->only(['name', 'pretty_name', 'author', 'description', 'link']) + ['versions' => []];
                $mods[$mod->name]['versions'][$modversion->version] = $modversion->only(['version', 'md5', 'filesize']);
            }
        }

        return [
            'format' => self::BACKUP_FORMAT,
            'format_version' => 1,
            'solder_version' => SOLDER_VERSION,
            'exported_at' => now()->toIso8601String(),
            'modpack' => $modpack->only(['name', 'slug', 'recommended', 'latest', 'hidden', 'private']),
            'builds' => $modpack->builds->sortBy('id')->map(fn (Build $build) => $build->only([
                'version', 'minecraft', 'forge', 'is_published', 'private', 'min_java', 'java_runtime', 'min_memory',
            ]) + [
                'mods' => $build->modversions->map(fn (Modversion $modversion) => [
                    'name' => $modversion->mod->name,
                    'version' => $modversion->version,
                ])->values()->all(),
            ])->values()->all(),
            'mods' => array_values(array_map(function (array $mod) {
                $mod['versions'] = array_values($mod['versions']);

                return $mod;
            }, $mods)),
        ];
    }

    /**
     * Work out which mod loader a build uses from its loader mods, or the loader recorded by an import.
     *
     * @return array{type: string, version: string}|null
     */
    public function detectLoader(Build $build): ?array
    {
        $minecraft = (string) $build->minecraft;
        $withoutMinecraft = fn (string $version) => str_starts_with($version, "$minecraft-")
            ? substr($version, strlen($minecraft) + 1)
            : $version;

        foreach ($build->modversions as $modversion) {
            $version = (string) $modversion->version;

            switch ($modversion->mod->name ?? '') {
                case 'fabric-loader':
                    return ['type' => 'fabric', 'version' => $withoutMinecraft($version)];
                case 'quilt-loader':
                    return ['type' => 'quilt', 'version' => $withoutMinecraft($version)];
                case 'forge':
                    // Imported as "{mc}-forge-{version}"; very old builds also end in "-{mc}"
                    $version = preg_match('/-forge-(.+)$/', $version, $match) ? $match[1] : $withoutMinecraft($version);

                    return ['type' => 'forge', 'version' => preg_replace('/-'.preg_quote($minecraft, '/').'$/', '', $version)];
                case 'neoforge':
                    // Imported as "neoforge-{version}" or, for 1.20.1, "forge-{mc}-{version}"
                    $version = preg_replace('/^(neoforge|forge)-/', '', $version);

                    return ['type' => 'neoforge', 'version' => $withoutMinecraft($version)];
            }
        }

        if (preg_match('/^(neoforge|forge|fabric|quilt)(?:-loader)?-(.+)$/', (string) $build->forge, $match)) {
            return ['type' => $match[1], 'version' => $match[2]];
        }

        return null;
    }

    private function writeClient(Build $build, ZipArchive $out): void
    {
        foreach ($this->archives($build) as $archive) {
            $this->copyEntries($archive, $out);
        }
    }

    private function writeServer(Build $build, ZipArchive $out): void
    {
        $installer = null;

        foreach ($this->archives($build) as $archive) {
            $this->copyEntries($archive, $out, function (string $name) use ($archive, &$installer) {
                if ($name === 'bin/modpack.jar') {
                    $installer = $archive->getFromName($name);
                }

                // bin/ holds the client launcher profile, which a server doesn't use
                return str_starts_with($name, 'bin/') ? null : $name;
            });
        }

        $loader = $this->detectLoader($build);
        $readme = "{$build->modpack->name} {$build->version} server\nMinecraft {$build->minecraft}\n\n";

        if ($installer !== null) {
            $isInstaller = $this->jarContains($installer, 'install_profile.json');
            $jarName = $isInstaller ? 'installer.jar' : 'forge-universal.jar';
            $out->addFromString($jarName, $installer);
            $readme .= $isInstaller
                ? "Install the server with:\n\n    java -jar installer.jar --installServer\n\nthen start it with the run script the installer creates.\n"
                : "Place the vanilla minecraft_server.{$build->minecraft}.jar next to forge-universal.jar and start the server with:\n\n    java -jar forge-universal.jar nogui\n";
        } elseif ($loader !== null && in_array($loader['type'], ['fabric', 'quilt'])) {
            $site = $loader['type'] === 'fabric' ? 'https://fabricmc.net/use/server/' : 'https://quiltmc.org/en/install/server/';
            $readme .= ucfirst($loader['type'])." Loader {$loader['version']}\n\nDownload the server launcher for Minecraft {$build->minecraft} from $site, place it in this folder and run it.\n";
        } else {
            $readme .= "No mod loader was found in this build. Install the matching loader before starting the server.\n";
        }

        $readme .= "\nYou must accept the Minecraft EULA (eula.txt) before the server will start.\n";
        $out->addFromString('README.txt', $readme);
    }

    private function writeMrpack(Build $build, ZipArchive $out): void
    {
        // Pass 1: hash every jar in mods/ so Modrinth-hosted files can be referenced instead of bundled
        $jars = [];
        foreach ($this->archives($build) as $key => $archive) {
            for ($i = 0; $i < $archive->numFiles; $i++) {
                $name = $this->safeEntryName($archive, $i);
                if ($name === null || str_starts_with($name, 'bin/')) {
                    continue;
                }

                if (preg_match('#^mods/[^/]+\.jar$#i', $name)) {
                    $contents = (string) $archive->getFromIndex($i);
                    $jars[] = [
                        'archive' => $key,
                        'name' => $name,
                        'sha1' => sha1($contents),
                        'sha512' => hash('sha512', $contents),
                        'size' => strlen($contents),
                    ];
                } else {
                    $out->addFromString("overrides/$name", (string) $archive->getFromIndex($i));
                }
            }
        }

        $hosted = Modrinth::filesByHash(array_column($jars, 'sha1'));

        // Pass 2: bundle the jars Modrinth doesn't host
        $bundle = [];
        $files = [];
        foreach ($jars as $jar) {
            $match = $hosted[$jar['sha1']] ?? null;
            if ($match === null) {
                $bundle[$jar['archive']][] = $jar['name'];

                continue;
            }

            $files[] = [
                'path' => $jar['name'],
                'hashes' => ['sha1' => $jar['sha1'], 'sha512' => $jar['sha512']],
                'env' => ['client' => 'required', 'server' => 'required'],
                'downloads' => [$match->url],
                'fileSize' => $jar['size'],
            ];
        }

        if (! empty($bundle)) {
            foreach ($this->archives($build) as $key => $archive) {
                foreach ($bundle[$key] ?? [] as $name) {
                    $out->addFromString("overrides/$name", (string) $archive->getFromName($name));
                }
            }
        }

        $dependencies = ['minecraft' => (string) $build->minecraft];
        $loader = $this->detectLoader($build);
        if ($loader !== null) {
            $dependencies[self::MRPACK_LOADER_KEYS[$loader['type']]] = $loader['version'];
        } else {
            $this->warnings[] = 'No mod loader was found in this build; set it in your launcher after importing.';
        }

        $out->addFromString('modrinth.index.json', json_encode([
            'formatVersion' => 1,
            'game' => 'minecraft',
            'versionId' => (string) $build->version,
            'name' => $build->modpack->name,
            'files' => $files,
            'dependencies' => $dependencies,
        ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    }

    private function writeCurseForge(Build $build, ZipArchive $out): void
    {
        foreach ($this->archives($build) as $archive) {
            $this->copyEntries($archive, $out, fn (string $name) => str_starts_with($name, 'bin/') ? null : "overrides/$name");
        }

        $loader = $this->detectLoader($build);
        if ($loader === null) {
            $this->warnings[] = 'No mod loader was found in this build; set it in your launcher after importing.';
        }

        $out->addFromString('manifest.json', json_encode([
            'minecraft' => [
                'version' => (string) $build->minecraft,
                'modLoaders' => $loader === null ? [] : [['id' => "{$loader['type']}-{$loader['version']}", 'primary' => true]],
            ],
            'manifestType' => 'minecraftModpack',
            'manifestVersion' => 1,
            'name' => $build->modpack->name,
            'version' => (string) $build->version,
            'author' => '',
            'files' => [],
            'overrides' => 'overrides',
        ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    }

    /**
     * Open each mod version's zip in turn, keyed by modversion ID. Missing files are recorded as warnings.
     *
     * @return Generator<int, ZipArchive>
     */
    private function archives(Build $build): Generator
    {
        $modversions = $build->modversions->sortBy(fn (Modversion $modversion) => $modversion->mod->name);

        foreach ($modversions as $modversion) {
            $path = $this->localArchive($modversion);
            if ($path === null) {
                continue;
            }

            $zip = new ZipArchive;
            if ($zip->open($path, ZipArchive::RDONLY) !== true) {
                $this->warnings[] = "{$modversion->mod->name} {$modversion->version}: not a valid zip";

                continue;
            }

            try {
                yield $modversion->id => $zip;
            } finally {
                $zip->close();
            }
        }
    }

    /**
     * Path to a mod version's zip on disk, downloading it first when the repository is remote.
     */
    private function localArchive(Modversion $modversion): ?string
    {
        $name = $modversion->mod->name;
        $relative = "mods/$name/$name-{$modversion->version}.zip";
        $repo = config('solder.repo_location');

        if (! filter_var($repo, FILTER_VALIDATE_URL)) {
            if (is_file($repo.$relative)) {
                return $repo.$relative;
            }

            $this->warnings[] = "$name {$modversion->version}: $relative is missing from the mod repository";

            return null;
        }

        $tmp = tempnam(sys_get_temp_dir(), 'solder_export_mod_');
        $this->tempFiles[] = $tmp;

        $error = ModProvider::download($repo.$relative, $tmp);
        if ($error !== null) {
            $this->warnings[] = "$name {$modversion->version}: $error";

            return null;
        }

        return $tmp;
    }

    /**
     * Copy entries between archives, optionally renaming or skipping them (rename returns null to skip).
     */
    private function copyEntries(ZipArchive $source, ZipArchive $out, ?callable $rename = null): void
    {
        for ($i = 0; $i < $source->numFiles; $i++) {
            $name = $this->safeEntryName($source, $i);
            if ($name === null) {
                continue;
            }

            $target = $rename ? $rename($name) : $name;
            if ($target !== null) {
                $out->addFromString($target, (string) $source->getFromIndex($i));
            }
        }
    }

    /**
     * Entry name for a file (not a directory) with a safe relative path, or null.
     */
    private function safeEntryName(ZipArchive $archive, int $index): ?string
    {
        $name = str_replace('\\', '/', (string) $archive->getNameIndex($index));

        if ($name === '' || str_ends_with($name, '/') || str_starts_with($name, '/') || str_contains($name, '..')) {
            return null;
        }

        return $name;
    }

    private function jarContains(string $jarContents, string $entry): bool
    {
        $tmp = tempnam(sys_get_temp_dir(), 'solder_jar_');
        $this->tempFiles[] = $tmp;
        file_put_contents($tmp, $jarContents);

        $zip = new ZipArchive;
        if ($zip->open($tmp, ZipArchive::RDONLY) !== true) {
            return false;
        }

        $found = $zip->locateName($entry) !== false;
        $zip->close();

        return $found;
    }
}
