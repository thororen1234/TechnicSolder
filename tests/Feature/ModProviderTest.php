<?php

namespace Tests\Feature;

use App\Models\Mod;
use App\Models\Modversion;
use App\Models\User;
use App\Models\UserPermission;
use App\Mods\ModProvider;
use App\Mods\Providers\CurseForge;
use App\Mods\Providers\Fabric;
use App\Mods\Providers\Forge;
use App\Mods\Providers\Modrinth;
use App\Mods\Providers\NeoForge;
use App\Mods\Providers\Quilt;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\FakesModProviders;
use Tests\TestCase;
use ZipArchive;

final class ModProviderTest extends TestCase
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

    /**
     * Fake a Modrinth project "sodium" whose versions serve the given file contents.
     *
     * @param  array<string, array{contents: string, loaders?: list<string>, game?: string, sha1?: string, status?: int}>  $versions
     */
    private function fakeModrinthProject(array $versions): void
    {
        $fakes = [
            'api.modrinth.com/v2/project/sodium' => Http::response([
                'id' => 'AANobbMI', 'slug' => 'sodium', 'title' => 'Sodium', 'description' => 'Fast', 'project_type' => 'mod',
            ]),
            'api.modrinth.com/v2/project/sodium/members' => Http::response([
                ['role' => 'Owner', 'user' => ['username' => 'jellysquid3']],
            ]),
            'api.modrinth.com/v2/project/sodium/version' => Http::response(collect($versions)->map(fn ($version, $id) => [
                'id' => $id,
                'version_number' => "$id-number",
                'version_type' => 'release',
                'game_versions' => [$version['game'] ?? '1.20.1'],
                'loaders' => $version['loaders'] ?? ['fabric'],
                'files' => [[
                    'url' => "https://cdn.modrinth.com/data/AANobbMI/versions/$id/sodium.jar",
                    'filename' => 'sodium.jar',
                    'primary' => true,
                    'hashes' => ['sha1' => $version['sha1'] ?? sha1($version['contents'])],
                ]],
            ])->values()->all()),
        ];

        foreach ($versions as $id => $version) {
            $fakes["cdn.modrinth.com/data/AANobbMI/versions/$id/sodium.jar"] = Http::response($version['contents'], $version['status'] ?? 200);
        }

        Http::fake($fakes);
    }

    private function storedEntries(Modversion $modversion): array
    {
        $zip = new ZipArchive;
        $zip->open($this->modRepository."mods/{$modversion->mod->name}/{$modversion->mod->name}-{$modversion->version}.zip");
        $names = [];
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $names[] = $zip->getNameIndex($i);
        }
        $zip->close();

        return $names;
    }

    public function test_modrinth_import_stores_jar_under_detected_version(): void
    {
        $this->fakeModrinthProject(['v1' => ['contents' => $this->makeFabricJar('sodium', '0.5.13')]]);

        $result = Modrinth::install('sodium', ['v1']);

        $this->assertTrue($result->success);
        $this->assertSame([], $result->errors);
        $mod = Mod::where('name', 'sodium')->firstOrFail();
        $this->assertSame('Sodium', $mod->pretty_name);
        $this->assertSame('jellysquid3', $mod->author);
        $modversion = Modversion::findOrFail($result->modversionIds['v1']);
        $this->assertSame('1.20.1-0.5.13', $modversion->version);
        $this->assertSame(['mods/sodium.jar'], $this->storedEntries($modversion));
        $this->assertSame(md5_file($this->modRepository.'mods/sodium/sodium-1.20.1-0.5.13.zip'), $modversion->md5);
    }

    public function test_importing_an_existing_version_reuses_it(): void
    {
        $this->fakeModrinthProject(['v1' => ['contents' => $this->makeFabricJar('sodium', '0.5.13')]]);

        $first = Modrinth::install('sodium', ['v1']);
        $second = Modrinth::install('sodium', ['v1']);

        $this->assertSame($first->modversionIds, $second->modversionIds);
        $this->assertSame(1, $second->existing);
        $this->assertSame([], $second->errors);
        $this->assertSame(1, Modversion::where('mod_id', $first->id)->count());
    }

    public function test_failed_download_is_reported_and_stores_nothing(): void
    {
        $this->fakeModrinthProject(['v1' => ['contents' => 'Not Found', 'status' => 404]]);

        $result = Modrinth::install('sodium', ['v1']);

        $this->assertStringContainsString('HTTP 404', $result->errors[0]);
        $this->assertSame([], $result->modversionIds);
        $this->assertFalse(Modversion::whereHas('mod', fn ($query) => $query->where('name', 'sodium'))->exists());
        $this->assertDirectoryDoesNotExist($this->modRepository.'mods/sodium');
    }

    public function test_checksum_mismatch_is_rejected(): void
    {
        $this->fakeModrinthProject(['v1' => ['contents' => $this->makeFabricJar('sodium', '0.5.13'), 'sha1' => str_repeat('0', 40)]]);

        $result = Modrinth::install('sodium', ['v1']);

        $this->assertStringContainsString('checksum mismatch', $result->errors[0]);
        $this->assertSame([], $result->modversionIds);
    }

    public function test_download_that_is_not_an_archive_is_rejected(): void
    {
        $this->fakeModrinthProject(['v1' => ['contents' => '<html>rate limited</html>']]);

        $result = Modrinth::install('sodium', ['v1']);

        $this->assertStringContainsString('not a valid jar or zip', $result->errors[0]);
    }

    public function test_file_without_metadata_uses_the_provider_version_name(): void
    {
        $this->fakeModrinthProject(['v1' => ['contents' => $this->makeArchive(['pack.mcmeta' => '{}'])]]);

        $result = Modrinth::install('sodium', ['v1']);

        $this->assertSame('1.20.1-v1-number', Modversion::findOrFail($result->modversionIds['v1'])->version);
    }

    public function test_remote_repository_cannot_receive_imports(): void
    {
        config(['solder.repo_location' => 'https://mods.example.com/']);
        $this->fakeModrinthProject(['v1' => ['contents' => $this->makeFabricJar('sodium', '0.5.13')]]);

        $result = Modrinth::install('sodium', ['v1']);

        $this->assertStringContainsString('remote URL', $result->errors[0]);
        Http::assertNotSent(fn (Request $request) => str_contains($request->url(), 'cdn.modrinth.com'));
    }

    public function test_latest_version_respects_loader_game_version_and_channel(): void
    {
        $versions = [
            'newest-forge' => (object) ['gameVersions' => ['1.20.1'], 'loaders' => ['forge'], 'versionType' => 'release'],
            'beta-fabric' => (object) ['gameVersions' => ['1.20.1'], 'loaders' => ['fabric'], 'versionType' => 'beta'],
            'fabric' => (object) ['gameVersions' => ['1.20.1'], 'loaders' => ['fabric'], 'versionType' => 'release'],
            'old-fabric' => (object) ['gameVersions' => ['1.19.2'], 'loaders' => ['fabric'], 'versionType' => 'release'],
        ];

        $this->assertSame('fabric', ModProvider::latestStableVersionForGame($versions, '1.20.1', 'release', 'fabric'));
        $this->assertSame('beta-fabric', ModProvider::latestStableVersionForGame($versions, '1.20.1', 'any', 'fabric'));
        $this->assertSame('old-fabric', ModProvider::latestStableVersionForGame($versions, '1.19.2', '', 'fabric'));
        $this->assertSame('newest-forge', ModProvider::latestStableVersionForGame($versions, '', 'release'));
        $this->assertNull(ModProvider::latestStableVersionForGame($versions, '1.20.1', 'alpha'));
    }

    public function test_fabric_flags_unstable_loaders_and_stores_profile_in_bin(): void
    {
        $this->fakeFabricMeta();

        $modData = Fabric::mod('1.20.1');

        $this->assertSame('beta', $modData->versions['1.20.1-0.15.0']->versionType);
        $this->assertSame('release', $modData->versions['1.20.1-0.14.9']->versionType);
        $this->assertSame('1.20.1-0.14.9', Fabric::latestStableVersionForGame($modData->versions, '1.20.1', 'release'));

        $result = Fabric::install('1.20.1', ['1.20.1-0.14.9'], $modData);
        $modversion = Modversion::findOrFail($result->modversionIds['1.20.1-0.14.9']);

        $this->assertSame('fabric-loader', $modversion->mod->name);
        $this->assertSame('1.20.1-0.14.9', $modversion->version);
        $this->assertSame(['bin/version.json'], $this->storedEntries($modversion));
    }

    public function test_fabric_supports_year_based_minecraft_versions(): void
    {
        $this->fakeFabricMeta();

        $modData = Fabric::mod('26.1');

        $this->assertSame('Fabric Loader 26.1', $modData->displayName);
        $this->assertSame(
            'https://meta.fabricmc.net/v2/versions/loader/26.1/0.14.9/profile/json',
            $modData->versions['26.1-0.14.9']->url
        );
    }

    public function test_quilt_flags_beta_loaders(): void
    {
        Http::fake([
            'meta.quiltmc.org/v3/versions/game' => Http::response([['version' => '1.20.1', 'stable' => true]]),
            'meta.quiltmc.org/v3/versions/loader' => Http::response([['version' => '0.30.0-beta.2'], ['version' => '0.29.1']]),
        ]);

        $modData = Quilt::mod('1.20.1');

        $this->assertSame('quilt-loader', $modData->slug);
        $this->assertSame('beta', $modData->versions['1.20.1-0.30.0-beta.2']->versionType);
        $this->assertSame('release', $modData->versions['1.20.1-0.29.1']->versionType);
    }

    public function test_forge_uses_universal_jar_up_to_1_12_2_and_installer_after(): void
    {
        Http::fake([
            'maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml' => Http::response(
                '<metadata><versioning><versions>'
                .'<version>1.12.2-14.23.5.2860</version><version>1.20.1-47.2.0</version><version>26.1-62.0.1</version>'
                .'</versions></versioning></metadata>'
            ),
        ]);

        $this->assertStringEndsWith(
            '1.12.2-14.23.5.2860/forge-1.12.2-14.23.5.2860-universal.jar',
            Forge::mod('1.12.2')->versions['1.12.2-forge-14.23.5.2860']->url
        );
        $this->assertStringEndsWith(
            '1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar',
            Forge::mod('1.20.1')->versions['1.20.1-forge-47.2.0']->url
        );
        $this->assertStringEndsWith('-installer.jar', Forge::mod('26.1')->versions['26.1-forge-62.0.1']->url);
        $this->assertSame(['26.1', '1.20.1', '1.12.2'], array_map(fn ($mod) => $mod->id, Forge::search('')->mods));
    }

    /**
     * @return array<string, array{0: string, 1: string}>
     */
    public static function neoForgeVersions(): array
    {
        return [
            'legacy forge artifact' => ['1.20.1-47.1.106', '1.20.1'],
            'minor release' => ['20.4.80-beta', '1.20.4'],
            'first build of a major' => ['21.0.167', '1.21'],
            'patch release' => ['21.1.263', '1.21.1'],
            'year based' => ['26.3.0.95', '26.3'],
            'year based hotfix' => ['26.3.1.4', '26.3.1'],
        ];
    }

    #[DataProvider('neoForgeVersions')]
    public function test_neoforge_maps_versions_to_minecraft(string $version, string $minecraft): void
    {
        $this->assertSame($minecraft, NeoForge::minecraftVersion($version));
    }

    public function test_neoforge_builds_installer_urls_for_both_artifacts(): void
    {
        Http::fake([
            'maven.neoforged.net/releases/net/neoforged/forge/maven-metadata.xml' => Http::response(
                '<metadata><versioning><versions><version>1.20.1-47.1.106</version></versions></versioning></metadata>'
            ),
            'maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml' => Http::response(
                '<metadata><versioning><versions><version>26.3.0.94-beta</version><version>26.3.0.95-beta</version></versions></versioning></metadata>'
            ),
        ]);

        $legacy = NeoForge::mod('1.20.1');
        $this->assertStringEndsWith('/forge/1.20.1-47.1.106/forge-1.20.1-47.1.106-installer.jar', $legacy->versions['forge-1.20.1-47.1.106']->url);

        $current = NeoForge::mod('26.3');
        $this->assertSame(['neoforge-26.3.0.95-beta', 'neoforge-26.3.0.94-beta'], array_keys($current->versions));
        $this->assertSame('beta', $current->versions['neoforge-26.3.0.95-beta']->versionType);
    }

    public function test_curseforge_requires_an_api_key(): void
    {
        config(['solder.curseforge_api_key' => null]);

        $search = CurseForge::search('jei');

        $this->assertArrayHasKey('no_api_key', $search->errors);
        $this->assertNull(CurseForge::mod('238222'));
        Http::assertNothingSent();
    }

    public function test_curseforge_filters_files_and_reports_disabled_downloads(): void
    {
        config(['solder.curseforge_api_key' => 'test-key']);
        Http::fake([
            'api.curseforge.com/v1/mods/238222' => Http::response(['data' => [
                'id' => 238222, 'slug' => 'jei', 'name' => 'Just Enough Items', 'classId' => 6, 'authors' => [['name' => 'mezz']],
            ]]),
            'api.curseforge.com/v1/mods/238222/files*' => Http::response(['data' => [[
                'id' => 111, 'modId' => 238222, 'displayName' => 'jei-1.20.1-15.2.0', 'fileName' => 'jei.jar',
                'downloadUrl' => null, 'gameVersions' => ['1.20.1', 'Forge'], 'releaseType' => 1,
            ]]]),
        ]);

        $modData = CurseForge::modFor('238222', '1.20.1', 'forge');
        $result = CurseForge::install('238222', ['111'], $modData);

        Http::assertSent(fn (Request $request) => str_contains($request->url(), '/files?')
            && str_contains($request->url(), 'gameVersion=1.20.1')
            && str_contains($request->url(), 'modLoaderType=1')
            && $request->hasHeader('x-api-key', 'test-key'));
        $this->assertSame(['forge'], $modData->versions['111']->loaders);
        $this->assertStringContainsString('disabled third-party downloads', $result->errors[0]);
    }

    public function test_mod_import_requires_create_permission(): void
    {
        $user = new User;
        $user->forceFill([
            'username' => 'viewer', 'email' => 'viewer@example.com', 'password' => 'password',
            'created_ip' => '127.0.0.1', 'created_by_user_id' => 1, 'updated_by_user_id' => 1, 'updated_by_ip' => '127.0.0.1',
        ])->save();
        $permission = new UserPermission;
        $permission->user_id = $user->id;
        $permission->save();

        $this->be($user->fresh('permission'));

        $this->get('/mod/import')->assertRedirect('dashboard');
        $this->post('/mod/import/batch', ['provider' => 'fabric', 'mods' => ['1.20.1']])->assertRedirect('dashboard');
        Http::assertNothingSent();
    }
}
