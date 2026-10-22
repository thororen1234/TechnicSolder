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
