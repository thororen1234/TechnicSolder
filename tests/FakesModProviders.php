<?php

namespace Tests;

use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Http;
use ZipArchive;

/**
 * Helpers for tests that import or export mods: a throwaway mod repository, in-memory
 * mod jars and fake responses for the mod loader APIs. No test may reach the network.
 */
trait FakesModProviders
{
    protected string $modRepository;

    protected function setUpModRepository(): void
    {
        $this->modRepository = sys_get_temp_dir().'/solder-test-repo-'.uniqid().'/';
        mkdir($this->modRepository, 0775, true);
        config(['solder.repo_location' => $this->modRepository]);

        Http::preventStrayRequests();

        $this->beforeApplicationDestroyed(fn () => File::deleteDirectory($this->modRepository));
    }

    /**
     * Contents of a zip/jar holding the given files.
     *
     * @param  array<string, string>  $files
     */
    protected function makeArchive(array $files): string
    {
        $path = tempnam(sys_get_temp_dir(), 'solder_test_jar_');
        $zip = new ZipArchive;
        $zip->open($path, ZipArchive::CREATE | ZipArchive::OVERWRITE);
        foreach ($files as $name => $contents) {
            $zip->addFromString($name, $contents);
        }
        $zip->close();

        $contents = file_get_contents($path);
        unlink($path);

        return $contents;
    }

    /**
     * A Fabric mod jar declaring the given version and Minecraft dependency.
     */
    protected function makeFabricJar(string $id, string $version, string $minecraft = '1.20.1'): string
    {
        return $this->makeArchive([
            'fabric.mod.json' => json_encode(['id' => $id, 'version' => $version, 'depends' => ['minecraft' => "~$minecraft"]]),
        ]);
    }

    /**
     * Place a mod version's zip in the fake repository, as Solder stores it.
     *
     * @param  array<string, string>  $files
     */
    protected function putModversionZip(string $modName, string $version, array $files): void
    {
        File::ensureDirectoryExists($this->modRepository."mods/$modName");
        file_put_contents($this->modRepository."mods/$modName/$modName-$version.zip", $this->makeArchive($files));
    }

    /**
     * Fake Fabric Meta with a stable and an unstable loader for the given game versions.
     *
     * @param  list<string>  $gameVersions
     */
    protected function fakeFabricMeta(array $gameVersions = ['1.18.2', '1.20.1', '26.1']): void
    {
        Http::fake([
            'meta.fabricmc.net/v2/versions/game' => Http::response(array_map(
                fn ($version) => ['version' => $version, 'stable' => true],
                $gameVersions
            )),
            'meta.fabricmc.net/v2/versions/loader' => Http::response([
                ['version' => '0.15.0', 'stable' => false],
                ['version' => '0.14.9', 'stable' => true],
            ]),
            'meta.fabricmc.net/v2/versions/loader/*/profile/json' => Http::response(['id' => 'fabric-loader-profile']),
        ]);
    }
}
