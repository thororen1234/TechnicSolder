<?php

namespace Tests\Feature;

use App\Models\Build;
use App\Models\Modpack;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Http;
use Illuminate\Testing\TestResponse;
use Tests\FakesModProviders;
use Tests\TestCase;
use ZipArchive;

final class PackImportTest extends TestCase
{
    use FakesModProviders;
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        $this->seed();
        $this->be(User::find(1));
        $this->setUpModRepository();
    }

    private function importPack(string $contents, string $filename, string $slug = 'test-pack'): TestResponse
    {
        return $this->post('/modpack/import', [
            'name' => 'Test Pack',
            'slug' => $slug,
            'source' => 'file',
            'file' => UploadedFile::fake()->createWithContent($filename, $contents),
        ]);
    }

    /**
     * @return array<string, string> mod name => version for every mod version in the build
     */
    private function buildContents(Build $build): array
    {
        return $build->modversions()->with('mod')->get()
            ->mapWithKeys(fn ($modversion) => [$modversion->mod->name => $modversion->version])
            ->sortKeys()
            ->all();
    }

    private function zipEntries(string $modName, string $version): array
    {
        $zip = new ZipArchive;
        $zip->open($this->modRepository."mods/$modName/$modName-$version.zip");
        $entries = [];
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $entries[$zip->getNameIndex($i)] = $zip->getFromIndex($i);
        }
        $zip->close();
        ksort($entries);

        return $entries;
    }

    public function test_imports_a_modrinth_pack_with_loader_resource_packs_and_overrides(): void
    {
        $sodium = $this->makeFabricJar('sodium', '0.5.13');
        $resourcePack = $this->makeArchive(['pack.mcmeta' => '{"pack":{"pack_format":15}}']);

        $this->fakeFabricMeta();
        Http::fake([
            'api.modrinth.com/v2/versions*' => Http::response([[
                'id' => 'v1', 'project_id' => 'AANobbMI', 'version_number' => '0.5.13', 'version_type' => 'release',
                'game_versions' => ['1.20.1'], 'loaders' => ['fabric'],
                'files' => [['url' => 'https://cdn.modrinth.com/data/AANobbMI/versions/v1/sodium.jar', 'filename' => 'sodium.jar', 'primary' => true, 'hashes' => ['sha1' => sha1($sodium)]]],
            ]]),
            'api.modrinth.com/v2/projects*' => Http::response([[
                'id' => 'AANobbMI', 'slug' => 'sodium', 'title' => 'Sodium', 'description' => 'Fast', 'project_type' => 'mod',
            ]]),
            'cdn.modrinth.com/data/AANobbMI/versions/v1/sodium.jar' => Http::response($sodium),
            'example.com/faithful-1.2.zip' => Http::response($resourcePack),
        ]);

        $pack = $this->makeArchive([
            'modrinth.index.json' => json_encode([
                'formatVersion' => 1,
                'game' => 'minecraft',
                'versionId' => '5.4.1',
                'name' => 'Fabulous',
                'files' => [
                    ['path' => 'mods/sodium.jar', 'downloads' => ['https://cdn.modrinth.com/data/AANobbMI/versions/v1/sodium.jar'], 'hashes' => ['sha1' => sha1($sodium)], 'env' => ['client' => 'required', 'server' => 'required']],
                    ['path' => 'resourcepacks/faithful-1.2.zip', 'downloads' => ['https://example.com/faithful-1.2.zip'], 'hashes' => ['sha1' => sha1($resourcePack)]],
                    ['path' => 'mods/server-only.jar', 'downloads' => ['https://example.com/server-only.jar'], 'env' => ['client' => 'unsupported', 'server' => 'required']],
                ],
                'dependencies' => ['minecraft' => '1.20.1', 'fabric-loader' => '0.14.9'],
            ]),
            'overrides/config/sodium.json' => '{"quality":"fast"}',
            'client-overrides/options.txt' => 'fov:90',
        ]);

        $response = $this->importPack($pack, 'fabulous.mrpack');

        $modpack = Modpack::where('slug', 'test-pack')->firstOrFail();
        $response->assertRedirect("modpack/view/{$modpack->id}");
        $response->assertSessionHasNoErrors();
        $response->assertSessionHas('success', '3 mod(s) imported.');

        $this->assertTrue((bool) $modpack->hidden);
        $build = $modpack->builds()->sole();
        $this->assertSame('5.4.1', $build->version);
        $this->assertSame('1.20.1', $build->minecraft);
        $this->assertSame([
            'fabric-loader' => '1.20.1-0.14.9',
            'faithful' => '1.20.1-faithful-1.2',
            'sodium' => '1.20.1-0.5.13',
            'test-pack-overrides' => '5.4.1',
        ], $this->buildContents($build));

        $this->assertSame(['resourcepacks/faithful-1.2.zip'], array_keys($this->zipEntries('faithful', '1.20.1-faithful-1.2')));
        $this->assertSame([
            'config/sodium.json' => '{"quality":"fast"}',
            'options.txt' => 'fov:90',
        ], $this->zipEntries('test-pack-overrides', '5.4.1'));
        Http::assertNotSent(fn (Request $request) => str_contains($request->url(), 'server-only'));
    }

    public function test_imports_a_curseforge_pack_with_forge_and_overrides(): void
    {
        config(['solder.curseforge_api_key' => 'test-key']);
        $jei = $this->makeArchive(['mcmod.info' => json_encode([['version' => '15.2.0', 'mcversion' => '1.20.1']])]);

        Http::fake([
            'api.curseforge.com/v1/mods/files' => Http::response(['data' => [[
                'id' => 111, 'modId' => 238222, 'displayName' => 'jei-1.20.1-15.2.0', 'fileName' => 'jei.jar',
                'downloadUrl' => 'https://edge.forgecdn.net/files/111/jei.jar', 'gameVersions' => ['1.20.1', 'Forge'], 'releaseType' => 1,
            ]]]),
            'api.curseforge.com/v1/mods' => Http::response(['data' => [[
                'id' => 238222, 'slug' => 'jei', 'name' => 'Just Enough Items', 'classId' => 6, 'authors' => [['name' => 'mezz']],
            ]]]),
            'edge.forgecdn.net/files/111/jei.jar' => Http::response($jei),
            'maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml' => Http::response(
                '<metadata><versioning><versions><version>1.20.1-47.2.0</version></versions></versioning></metadata>'
            ),
            'maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.2.0/*' => Http::response($this->makeArchive(['install_profile.json' => '{}'])),
        ]);

        $pack = $this->makeArchive([
            'manifest.json' => json_encode([
                'minecraft' => ['version' => '1.20.1', 'modLoaders' => [['id' => 'forge-47.2.0', 'primary' => true]]],
                'manifestType' => 'minecraftModpack',
                'manifestVersion' => 1,
                'name' => 'CF Pack',
                'version' => '2.0.0',
                'files' => [
                    ['projectID' => 238222, 'fileID' => 111, 'required' => true],
                    ['projectID' => 999, 'fileID' => 222, 'required' => false],
                ],
                'overrides' => 'overrides',
            ]),
            'overrides/config/jei.toml' => 'enabled = true',
        ]);

        $response = $this->importPack($pack, 'cf-pack.zip');

        $response->assertSessionHasNoErrors();
        $build = Modpack::where('slug', 'test-pack')->firstOrFail()->builds()->sole();
        $this->assertSame('forge-47.2.0', $build->forge);
        $this->assertSame([
            'forge' => '1.20.1-forge-47.2.0',
            'jei' => '1.20.1-15.2.0',
            'test-pack-overrides' => '2.0.0',
        ], $this->buildContents($build));
        $this->assertSame(['bin/modpack.jar'], array_keys($this->zipEntries('forge', '1.20.1-forge-47.2.0')));
        Http::assertSent(fn (Request $request) => $request->url() === 'https://api.curseforge.com/v1/mods/files' && $request['fileIds'] === [111]);
        Http::assertSent(fn (Request $request) => str_contains($request->url(), 'forgecdn') && ! $request->hasHeader('x-api-key'));
    }

    public function test_curseforge_pack_without_api_key_is_rejected_before_creating_anything(): void
    {
        config(['solder.curseforge_api_key' => null]);

        $pack = $this->makeArchive(['manifest.json' => json_encode([
            'minecraft' => ['version' => '1.20.1', 'modLoaders' => []],
            'manifestType' => 'minecraftModpack',
            'files' => [['projectID' => 1, 'fileID' => 2, 'required' => true]],
        ])]);

        $response = $this->importPack($pack, 'cf-pack.zip');

        $response->assertRedirect('modpack/import');
        $response->assertSessionHasErrors();
        $this->assertStringContainsString('CURSEFORGE_API_KEY', session('errors')->first());
        $this->assertFalse(Modpack::where('slug', 'test-pack')->exists());
        Http::assertNothingSent();
    }

    public function test_unavailable_loader_version_is_reported_without_failing_the_import(): void
    {
        $this->fakeFabricMeta();

        $pack = $this->makeArchive(['modrinth.index.json' => json_encode([
            'formatVersion' => 1,
            'game' => 'minecraft',
            'versionId' => '1.0',
            'files' => [],
            'dependencies' => ['minecraft' => '1.20.1', 'fabric-loader' => '9.9.9'],
        ])]);

        $response = $this->importPack($pack, 'pack.mrpack');

        $modpack = Modpack::where('slug', 'test-pack')->firstOrFail();
        $response->assertRedirect("modpack/view/{$modpack->id}");
        $this->assertStringContainsString('Could not find fabric 9.9.9 for Minecraft 1.20.1', session('errors')->first());
    }

    public function test_unrecognized_archive_is_rejected(): void
    {
        $response = $this->importPack($this->makeArchive(['readme.txt' => 'hi']), 'random.zip');

        $response->assertRedirect('modpack/import');
        $this->assertStringContainsString('Unrecognized modpack format', session('errors')->first());
        $this->assertFalse(Modpack::where('slug', 'test-pack')->exists());
    }

    public function test_non_archive_upload_is_rejected(): void
    {
        $response = $this->importPack('definitely not a zip', 'pack.zip');

        $response->assertRedirect('modpack/import');
        $this->assertStringContainsString('Could not open the archive', session('errors')->first());
    }
}
