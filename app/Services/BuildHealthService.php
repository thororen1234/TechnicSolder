<?php

namespace App\Services;

use App\Models\Build;
use App\Models\Modversion;
use App\Mods\JarMetadata;
use App\Mods\VersionRange;
use Illuminate\Support\Facades\Cache;
use ZipArchive;

/**
 * Checks a build for problems that stop it from launching: missing files, mods for the wrong loader or
 * Minecraft version, missing required dependencies and mods included twice.
 *
 * @phpstan-type Issue array{severity: 'error'|'warning', mod: string|null, message: string}
 * @phpstan-type JarInfo array{file: string, loaders: list<string>, mods: list<array<string, mixed>>, provides: list<string>}
 */
class BuildHealthService
{
    /** Dependencies satisfied by the game or the loader itself */
    private const BUILT_IN = [
        'minecraft', 'java', 'fabricloader', 'fabric-loader', 'quilt_loader', 'quilt-loader',
        'forge', 'neoforge', 'javafml', 'lowcodefml', 'mcp', 'fml',
    ];

    /** How deep to follow jars bundled inside jars */
    private const NESTING_DEPTH = 3;

    /**
     * @return array{issues: list<Issue>, checked: int}
     */
    public function check(Build $build): array
    {
        $build->loadMissing('modversions.mod');

        $repository = new ModRepository;
        $issues = [];
        $jars = [];

        $loaders = $build->modversions->filter(fn (Modversion $modversion) => in_array($modversion->mod->name, ['forge', 'neoforge', 'fabric-loader', 'quilt-loader'], true));
        $loader = $build->loader();

        if ($loader === null) {
            $issues[] = $this->issue('error', null, 'This build has no mod loader. Add Forge, NeoForge, Fabric or Quilt from Mods → Import → Mod loader.');
        } elseif ($loaders->count() > 1) {
            $issues[] = $this->issue('error', null, 'This build has more than one mod loader: '.$loaders->map(fn ($modversion) => $modversion->mod->name)->implode(', ').'.');
        }

        foreach ($build->modversions as $modversion) {
            $label = $modversion->mod->pretty_name ?: $modversion->mod->name;
            $info = Cache::rememberForever("solder-jarinfo:v1:{$modversion->id}:{$modversion->md5}", function () use ($repository, $modversion) {
                $copy = $repository->localCopy($modversion);

                return isset($copy['error']) ? ['error' => $copy['error']] : ['jars' => $this->readModversion($copy['path'])];
            });

            if (isset($info['error'])) {
                Cache::forget("solder-jarinfo:v1:{$modversion->id}:{$modversion->md5}");
                $issues[] = $this->issue('error', $label, "{$modversion->version}: {$info['error']}");

                continue;
            }

            foreach ($info['jars'] as $jar) {
                $jars[] = ['modversion' => $label, 'jar' => $jar];
            }
        }
        $repository->cleanup();

        // Everything the build provides, including jars bundled inside other jars
        $provided = array_flip(self::BUILT_IN);
        $owners = [];
        foreach ($jars as ['modversion' => $label, 'jar' => $jar]) {
            foreach ($jar['provides'] as $id) {
                $provided[$id] = true;
            }
            foreach ($jar['mods'] as $mod) {
                if (isset($owners[$mod['id']]) && $owners[$mod['id']] !== $label) {
                    $issues[] = $this->issue('warning', $label, "{$mod['id']} is included by both {$owners[$mod['id']]} and $label.");
                }
                $owners[$mod['id']] = $label;
            }
        }

        $compatible = $this->compatibleLoaders($build, $loader['type'] ?? null);
        $minecraft = (string) $build->minecraft;

        foreach ($jars as ['modversion' => $label, 'jar' => $jar]) {
            if ($compatible !== [] && $jar['loaders'] !== [] && array_intersect($jar['loaders'], $compatible) === []) {
                $issues[] = $this->issue('error', $label, "{$jar['file']} is a ".implode('/', $jar['loaders'])." mod, but this build uses {$loader['type']}.");

                continue;
            }

            foreach ($jar['mods'] as $mod) {
                if ($mod['minecraft'] !== '' && ! VersionRange::satisfies($mod['minecraft'], $minecraft)) {
                    $issues[] = $this->issue('warning', $label, "{$jar['file']} is made for Minecraft {$mod['minecraft']}, but this build is $minecraft.");
                }

                foreach ($mod['depends'] as $dependency) {
                    if (! isset($provided[$dependency])) {
                        $issues[] = $this->issue('error', $label, "{$jar['file']} requires \"$dependency\", which isn't in this build.");
                    }
                }
            }
        }

        usort($issues, fn ($a, $b) => [$a['severity'] === 'error' ? 0 : 1, $a['mod'] ?? ''] <=> [$b['severity'] === 'error' ? 0 : 1, $b['mod'] ?? '']);

        return ['issues' => $issues, 'checked' => $build->modversions->count()];
    }

    /**
     * Describe every jar in a mod version's zip (mods/*.jar).
     *
     * @return list<JarInfo>
     */
    private function readModversion(string $zipPath): array
    {
        $zip = new ZipArchive;
        if ($zip->open($zipPath, ZipArchive::RDONLY) !== true) {
            return [];
        }

        $jars = [];
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $name = (string) $zip->getNameIndex($i);
            if (preg_match('#^mods/[^/]+\.jar$#i', $name)) {
                $jars[] = $this->describeJar((string) $zip->getFromIndex($i), basename($name), 0);
            }
        }
        $zip->close();

        return $jars;
    }

    /**
     * @return JarInfo
     */
    private function describeJar(string $contents, string $file, int $depth): array
    {
        $tmp = tempnam(sys_get_temp_dir(), 'solder_health_');
        file_put_contents($tmp, $contents);

        try {
            $zip = new ZipArchive;
            if ($zip->open($tmp, ZipArchive::RDONLY) !== true) {
                return ['file' => $file, 'loaders' => [], 'mods' => [], 'provides' => []];
            }

            $info = JarMetadata::describe($zip);
            $provides = [];
            foreach ($info['mods'] as $mod) {
                array_push($provides, $mod['id'], ...$mod['provides']);
            }

            if ($depth < self::NESTING_DEPTH) {
                foreach ($info['nested'] as $nested) {
                    $nestedContents = $zip->getFromName($nested);
                    if ($nestedContents !== false) {
                        array_push($provides, ...$this->describeJar($nestedContents, basename($nested), $depth + 1)['provides']);
                    }
                }
            }
            $zip->close();

            return [
                'file' => $file,
                'loaders' => $info['loaders'],
                'mods' => $info['mods'],
                'provides' => array_values(array_unique($provides)),
            ];
        } finally {
            unlink($tmp);
        }
    }

    /**
     * Loaders whose mods run in this build. Quilt runs Fabric mods; NeoForge for 1.20.1 runs Forge mods.
     *
     * @return list<string>
     */
    private function compatibleLoaders(Build $build, ?string $loader): array
    {
        return match ($loader) {
            null => [],
            'quilt' => ['quilt', 'fabric'],
            'neoforge' => $build->minecraft === '1.20.1' ? ['neoforge', 'forge'] : ['neoforge'],
            default => [$loader],
        };
    }

    /**
     * @return Issue
     */
    private function issue(string $severity, ?string $mod, string $message): array
    {
        return ['severity' => $severity, 'mod' => $mod, 'message' => $message];
    }
}
