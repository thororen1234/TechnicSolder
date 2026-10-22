<?php

namespace App\Mods;

use ZipArchive;

/**
 * Reads mod metadata out of a mod jar to derive a "{minecraft}-{version}" version string.
 *
 * Supports Fabric, Quilt, legacy Forge (mcmod.info), Forge/NeoForge (mods.toml) and Rift.
 * Minecraft versions may be the classic "1.20.1" form or the year-based "26.1" form.
 */
final class JarMetadata
{
    /**
     * Detect the version of the jar at the given path. Returns null when the file is not a readable archive.
     */
    public static function detectVersionFromFile(string $path): ?string
    {
        $zip = new ZipArchive;
        if ($zip->open($path, ZipArchive::RDONLY) !== true) {
            return null;
        }

        try {
            return self::detectVersion($zip);
        } finally {
            $zip->close();
        }
    }

    /**
     * Detect the version from an open archive. Returns an empty string when no metadata is found.
     */
    public static function detectVersion(ZipArchive $zip): string
    {
        return self::fromFabric($zip)
            ?? self::fromQuilt($zip)
            ?? self::fromMcmodInfo($zip)
            ?? self::fromRift($zip)
            ?? self::fromModsToml($zip)
            ?? '';
    }

    /**
     * Everything the jar says about itself: the loaders it targets, the mods it contains
     * (with their required dependencies) and any jars bundled inside it.
     *
     * @return array{
     *     loaders: list<'fabric'|'quilt'|'forge'|'neoforge'>,
     *     mods: list<array{id: string, name: string, version: string, authors: string, description: string, url: string, minecraft: string, depends: list<string>, provides: list<string>}>,
     *     nested: list<string>,
     * }
     */
    public static function describe(ZipArchive $zip): array
    {
        $info = ['loaders' => [], 'mods' => [], 'nested' => []];

        $fabric = self::json($zip, 'fabric.mod.json');
        if (is_object($fabric) && isset($fabric->id)) {
            $info['loaders'][] = 'fabric';
            $info['mods'][] = self::mod(
                id: $fabric->id,
                name: $fabric->name ?? '',
                version: $fabric->version ?? '',
                authors: implode(', ', array_map(fn ($author) => is_object($author) ? ($author->name ?? '') : (string) $author, (array) ($fabric->authors ?? []))),
                description: $fabric->description ?? '',
                url: $fabric->contact->homepage ?? $fabric->contact->sources ?? '',
                minecraft: $fabric->depends->minecraft ?? '',
                depends: array_keys((array) ($fabric->depends ?? [])),
                provides: (array) ($fabric->provides ?? []),
            );
            foreach ((array) ($fabric->jars ?? []) as $jar) {
                $info['nested'][] = $jar->file ?? '';
            }
        }

        $quilt = self::json($zip, 'quilt.mod.json')->quilt_loader ?? null;
        if (is_object($quilt) && isset($quilt->id)) {
            $info['loaders'][] = 'quilt';
            $depends = [];
            $minecraft = '';
            foreach ((array) ($quilt->depends ?? []) as $dependency) {
                $id = is_object($dependency) ? ($dependency->id ?? '') : (string) $dependency;
                if (is_object($dependency) && ! empty($dependency->optional)) {
                    continue;
                }
                $depends[] = $id;
                if ($id === 'minecraft' && is_object($dependency)) {
                    $minecraft = $dependency->versions ?? '';
                }
            }
            $info['mods'][] = self::mod(
                id: $quilt->id,
                name: $quilt->metadata->name ?? '',
                version: $quilt->version ?? '',
                authors: implode(', ', array_keys((array) ($quilt->metadata->contributors ?? []))),
                description: $quilt->metadata->description ?? '',
                url: $quilt->metadata->contact->homepage ?? '',
                minecraft: $minecraft,
                depends: $depends,
                provides: array_map(fn ($provided) => is_object($provided) ? ($provided->id ?? '') : (string) $provided, (array) ($quilt->provides ?? [])),
            );
            foreach ((array) ($quilt->jars ?? []) as $jar) {
                $info['nested'][] = (string) $jar;
            }
        }

        foreach (['META-INF/neoforge.mods.toml' => 'neoforge', 'META-INF/mods.toml' => 'forge'] as $file => $loader) {
            $toml = $zip->getFromName($file);
            if ($toml === false) {
                continue;
            }

            $info['loaders'][] = $loader;
            foreach (self::tomlMods($toml, $zip) as $mod) {
                $info['mods'][] = $mod;
            }
        }

        $jarJar = self::json($zip, 'META-INF/jarjar/metadata.json');
        foreach ((array) ($jarJar->jars ?? []) as $jar) {
            $info['nested'][] = $jar->path ?? '';
        }

        $mcmod = self::json($zip, 'mcmod.info');
        $legacyMods = is_array($mcmod) ? $mcmod : ($mcmod->modList ?? []);
        foreach ($legacyMods as $legacy) {
            if (! is_object($legacy) || empty($legacy->modid)) {
                continue;
            }
            $info['loaders'][] = 'forge';
            $info['mods'][] = self::mod(
                id: $legacy->modid,
                name: $legacy->name ?? '',
                version: self::usable($legacy->version ?? null) ? $legacy->version : '',
                authors: implode(', ', (array) ($legacy->authorList ?? $legacy->authors ?? [])),
                description: $legacy->description ?? '',
                url: $legacy->url ?? '',
                minecraft: self::usable($legacy->mcversion ?? null) ? $legacy->mcversion : '',
                depends: array_map(fn ($dependency) => explode('@', (string) $dependency)[0], (array) ($legacy->requiredMods ?? [])),
                provides: [],
            );
        }

        $info['loaders'] = array_values(array_unique($info['loaders']));
        $info['nested'] = array_values(array_filter($info['nested']));

        return $info;
    }

    /**
     * Mods declared in a Forge/NeoForge mods.toml, with their mandatory dependencies.
     *
     * @return list<array{id: string, name: string, version: string, authors: string, description: string, url: string, minecraft: string, depends: list<string>, provides: list<string>}>
     */
    private static function tomlMods(string $toml, ZipArchive $zip): array
    {
        $string = fn (string $block, string $key) => preg_match('/^\s*'.$key.'\s*=\s*["\']{1,3}(.*?)["\']{1,3}\s*$/m', $block, $match) ? trim($match[1]) : '';

        // Dependencies grouped by the mod that declares them
        $dependencies = [];
        if (preg_match_all('/\[\[dependencies\.([^\]]+)\]\](.*?)(?=\[\[|\z)/s', $toml, $blocks, PREG_SET_ORDER)) {
            foreach ($blocks as [, $owner, $block]) {
                $required = preg_match('/^\s*mandatory\s*=\s*true/m', $block)
                    || preg_match('/^\s*type\s*=\s*["\']required["\']/mi', $block);
                $dependencies[trim($owner, '"\' ')][] = [
                    'id' => $string($block, 'modId'),
                    'required' => (bool) $required,
                    'range' => $string($block, 'versionRange'),
                ];
            }
        }

        $mods = [];
        preg_match_all('/\[\[mods\]\](.*?)(?=\[\[|\z)/s', $toml, $modBlocks);
        foreach ($modBlocks[1] as $block) {
            $id = $string($block, 'modId');
            if ($id === '') {
                continue;
            }

            $version = $string($block, 'version');
            if ($version === '${file.jarVersion}') {
                $manifest = $zip->getFromName('META-INF/MANIFEST.MF');
                $version = $manifest !== false && preg_match('/^Implementation-Version:\s*(.+)$/m', $manifest, $match) ? trim($match[1]) : '';
            }

            $minecraft = '';
            $depends = [];
            foreach ($dependencies[$id] ?? [] as $dependency) {
                if ($dependency['id'] === 'minecraft') {
                    $minecraft = $dependency['range'];
                }
                if ($dependency['required']) {
                    $depends[] = $dependency['id'];
                }
            }

            $mods[] = self::mod(
                id: $id,
                name: $string($block, 'displayName'),
                version: self::usable($version) ? $version : '',
                authors: $string($block, 'authors'),
                description: $string($block, 'description'),
                url: $string($block, 'displayURL'),
                minecraft: $minecraft,
                depends: $depends,
                provides: [],
            );
        }

        return $mods;
    }

    /**
     * @param  list<string>  $depends
     * @param  list<string>  $provides
     * @return array{id: string, name: string, version: string, authors: string, description: string, url: string, minecraft: string, depends: list<string>, provides: list<string>}
     */
    private static function mod(string $id, string $name, string $version, string $authors, string $description, string $url, mixed $minecraft, array $depends, array $provides): array
    {
        return [
            'id' => $id,
            'name' => $name,
            'version' => $version,
            'authors' => $authors,
            'description' => $description,
            'url' => is_string($url) ? $url : '',
            'minecraft' => is_array($minecraft) ? implode(' || ', $minecraft) : (string) $minecraft,
            'depends' => array_values(array_filter(array_map('strval', $depends))),
            'provides' => array_values(array_filter(array_map('strval', $provides))),
        ];
    }

    /**
     * Pull the first concrete Minecraft version out of a version range such as ">=1.20 <1.21", "~26.1" or "1.20.x".
     */
    public static function minecraftVersionFromRange(mixed $range): string
    {
        if (is_array($range)) {
            $range = $range[0] ?? '';
        }

        if (! is_string($range) || ! preg_match('/(\d+\.\d+(?:\.\d+)?)/', $range, $match)) {
            return '';
        }

        return $match[1];
    }

    private static function fromFabric(ZipArchive $zip): ?string
    {
        $data = self::json($zip, 'fabric.mod.json');
        $version = $data->version ?? null;

        if (! self::usable($version)) {
            return null;
        }

        $minecraft = self::minecraftVersionFromRange($data->depends->minecraft ?? '');

        return self::combine($minecraft, $version);
    }

    private static function fromQuilt(ZipArchive $zip): ?string
    {
        $loader = self::json($zip, 'quilt.mod.json')->quilt_loader ?? null;
        $version = $loader->version ?? null;

        if (! self::usable($version)) {
            return null;
        }

        $minecraft = '';
        foreach ((array) ($loader->depends ?? []) as $dependency) {
            if (is_object($dependency) && ($dependency->id ?? '') === 'minecraft') {
                $minecraft = self::minecraftVersionFromRange($dependency->versions ?? '');
                break;
            }
        }

        return self::combine($minecraft, $version);
    }

    private static function fromMcmodInfo(ZipArchive $zip): ?string
    {
        $data = self::json($zip, 'mcmod.info');

        // Either a bare list of mods or {"modListVersion": 2, "modList": [...]}
        $mods = is_array($data) ? $data : ($data->modList ?? []);
        $mod = $mods[0] ?? null;

        if (! is_object($mod) || ! self::usable($mod->version ?? null)) {
            return null;
        }

        $minecraft = self::usable($mod->mcversion ?? null) ? $mod->mcversion : '';

        return self::combine($minecraft, $mod->version);
    }

    private static function fromRift(ZipArchive $zip): ?string
    {
        $version = self::json($zip, 'riftmod.json')->version ?? null;

        return self::usable($version) ? $version : null;
    }

    private static function fromModsToml(ZipArchive $zip): ?string
    {
        $toml = $zip->getFromName('META-INF/neoforge.mods.toml');
        if ($toml === false) {
            $toml = $zip->getFromName('META-INF/mods.toml');
        }
        if ($toml === false) {
            return null;
        }

        $version = '';
        if (preg_match('/\[\[mods\]\](.*?)(?=\[\[|\z)/s', $toml, $modsBlock)
            && preg_match('/^\s*version\s*=\s*["\']([^"\']+)["\']/m', $modsBlock[1], $versionMatch)) {
            $version = $versionMatch[1];
        }

        if ($version === '${file.jarVersion}') {
            $manifest = $zip->getFromName('META-INF/MANIFEST.MF');
            $version = $manifest !== false && preg_match('/^Implementation-Version:\s*(.+)$/m', $manifest, $manifestMatch)
                ? trim($manifestMatch[1])
                : '';
        }

        if (! self::usable($version)) {
            return null;
        }

        $minecraft = '';
        if (preg_match_all('/\[\[dependencies\.[^\]]+\]\](.*?)(?=\[\[|\z)/s', $toml, $dependencyBlocks)) {
            foreach ($dependencyBlocks[1] as $block) {
                if (preg_match('/modId\s*=\s*["\']minecraft["\']/i', $block)
                    && preg_match('/versionRange\s*=\s*["\']([^"\']+)["\']/i', $block, $rangeMatch)) {
                    $minecraft = self::minecraftVersionFromRange($rangeMatch[1]);
                    break;
                }
            }
        }

        return self::combine($minecraft, $version);
    }

    private static function json(ZipArchive $zip, string $name): mixed
    {
        $contents = $zip->getFromName($name);

        return $contents === false ? null : json_decode($contents);
    }

    /**
     * Whether a metadata value is a real version rather than empty or an unexpanded build placeholder.
     */
    private static function usable(mixed $value): bool
    {
        return is_string($value) && trim($value) !== '' && ! str_contains($value, '${');
    }

    private static function combine(string $minecraft, string $version): string
    {
        $version = trim($version);

        // Avoid "1.20.1-1.20.1-2.0" when the mod already prefixes its own version
        if ($minecraft === '' || str_starts_with($version, $minecraft.'-')) {
            return $version;
        }

        return "$minecraft-$version";
    }
}
