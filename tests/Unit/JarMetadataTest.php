<?php

namespace Tests\Unit;

use App\Mods\JarMetadata;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use ZipArchive;

final class JarMetadataTest extends TestCase
{
    /**
     * @param  array<string, string>  $files
     */
    private function detect(array $files): ?string
    {
        $path = tempnam(sys_get_temp_dir(), 'jar_metadata_test_');
        $zip = new ZipArchive;
        $zip->open($path, ZipArchive::CREATE | ZipArchive::OVERWRITE);
        foreach ($files as $name => $contents) {
            $zip->addFromString($name, $contents);
        }
        $zip->close();

        try {
            return JarMetadata::detectVersionFromFile($path);
        } finally {
            unlink($path);
        }
    }

    public function test_fabric_mod_prefixes_minecraft_version(): void
    {
        $version = $this->detect([
            'fabric.mod.json' => json_encode(['version' => '0.5.13', 'depends' => ['minecraft' => '>=1.20 <1.21']]),
        ]);

        $this->assertSame('1.20-0.5.13', $version);
    }

    public function test_fabric_mod_with_minecraft_dependency_list(): void
    {
        $version = $this->detect([
            'fabric.mod.json' => json_encode(['version' => '2.0', 'depends' => ['minecraft' => ['1.20.1', '1.20.2']]]),
        ]);

        $this->assertSame('1.20.1-2.0', $version);
    }

    public function test_fabric_mod_does_not_repeat_minecraft_prefix(): void
    {
        $version = $this->detect([
            'fabric.mod.json' => json_encode(['version' => '1.20.1-2.0', 'depends' => ['minecraft' => '~1.20.1']]),
        ]);

        $this->assertSame('1.20.1-2.0', $version);
    }

    public function test_fabric_mod_with_year_based_minecraft_version(): void
    {
        $version = $this->detect([
            'fabric.mod.json' => json_encode(['version' => '3.1.0', 'depends' => ['minecraft' => '>=26.1']]),
        ]);

        $this->assertSame('26.1-3.1.0', $version);
    }

    public function test_quilt_mod(): void
    {
        $version = $this->detect([
            'quilt.mod.json' => json_encode(['quilt_loader' => [
                'version' => '1.4.0',
                'depends' => [['id' => 'quilt_loader'], ['id' => 'minecraft', 'versions' => '>=1.20.1']],
            ]]),
        ]);

        $this->assertSame('1.20.1-1.4.0', $version);
    }

    public function test_legacy_forge_mcmod_info_list(): void
    {
        $version = $this->detect([
            'mcmod.info' => json_encode([['modid' => 'jei', 'version' => '4.16.1', 'mcversion' => '1.12.2']]),
        ]);

        $this->assertSame('1.12.2-4.16.1', $version);
    }

    public function test_legacy_forge_mcmod_info_mod_list(): void
    {
        $version = $this->detect([
            'mcmod.info' => json_encode(['modListVersion' => 2, 'modList' => [['version' => '1.0', 'mcversion' => '1.7.10']]]),
        ]);

        $this->assertSame('1.7.10-1.0', $version);
    }

    public function test_unexpanded_placeholders_are_ignored(): void
    {
        $version = $this->detect([
            'mcmod.info' => json_encode([['version' => '${version}', 'mcversion' => '${mcversion}']]),
        ]);

        $this->assertSame('', $version);
    }

    public function test_forge_mods_toml(): void
    {
        $toml = <<<'TOML'
        modLoader="javafml"
        [[mods]]
        modId="examplemod"
        version="15.2.0"
        [[dependencies.examplemod]]
            modId="forge"
            versionRange="[47,)"
        [[dependencies.examplemod]]
            modId="minecraft"
            versionRange="[1.20.1,1.21)"
        TOML;

        $this->assertSame('1.20.1-15.2.0', $this->detect(['META-INF/mods.toml' => $toml]));
    }

    public function test_neoforge_mods_toml_with_jar_version_from_manifest(): void
    {
        $toml = <<<'TOML'
        [[mods]]
        modId="examplemod"
        version="${file.jarVersion}"
        [[dependencies.examplemod]]
            modId="minecraft"
            versionRange="[26.1,)"
        TOML;

        $version = $this->detect([
            'META-INF/neoforge.mods.toml' => $toml,
            'META-INF/MANIFEST.MF' => "Manifest-Version: 1.0\nImplementation-Version: 4.2.0\n",
        ]);

        $this->assertSame('26.1-4.2.0', $version);
    }

    public function test_archive_without_metadata_returns_empty_string(): void
    {
        $this->assertSame('', $this->detect(['assets/minecraft/textures/stone.png' => 'png']));
    }

    public function test_non_archive_returns_null(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'jar_metadata_test_');
        file_put_contents($path, '<html>Not found</html>');

        try {
            $this->assertNull(JarMetadata::detectVersionFromFile($path));
        } finally {
            unlink($path);
        }
    }

    /**
     * @return array<string, array{0: mixed, 1: string}>
     */
    public static function minecraftRanges(): array
    {
        return [
            'tilde' => ['~1.20.1', '1.20.1'],
            'range' => ['>=1.19.2 <1.20', '1.19.2'],
            'wildcard' => ['1.20.x', '1.20'],
            'year based' => ['>=26.1', '26.1'],
            'list' => [['1.18.2', '1.19'], '1.18.2'],
            'any' => ['*', ''],
            'not a string' => [null, ''],
        ];
    }

    #[DataProvider('minecraftRanges')]
    public function test_minecraft_version_from_range(mixed $range, string $expected): void
    {
        $this->assertSame($expected, JarMetadata::minecraftVersionFromRange($range));
    }
}
