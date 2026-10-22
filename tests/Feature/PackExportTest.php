<?php

namespace Tests\Feature;

use App\Models\Build;
use App\Models\Mod;
use App\Models\Modpack;
use App\Models\Modversion;
use App\Models\User;
use App\Models\UserPermission;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Http;
use Symfony\Component\HttpFoundation\BinaryFileResponse;
use Tests\FakesModProviders;
use Tests\TestCase;
use ZipArchive;

final class PackExportTest extends TestCase
{
    use FakesModProviders;
    use RefreshDatabase;

    private Modpack $modpack;

    private Build $build;

    private string $sodiumJar;

    protected function setUp(): void
    {
        parent::setUp();

        $this->seed();
        $this->be(User::find(1));
        $this->setUpModRepository();

        $this->sodiumJar = $this->makeFabricJar('sodium', '0.5.13');

        $this->modpack = Modpack::create(['name' => 'Export Pack', 'slug' => 'export-pack']);
        $this->build = Build::create(['modpack_id' => $this->modpack->id, 'version' => '1.0.0', 'minecraft' => '1.20.1']);

        $this->addModversion('fabric-loader', '1.20.1-0.14.9', ['bin/version.json' => '{"id":"fabric"}']);
        $this->addModversion('sodium', '1.20.1-0.5.13', ['mods/sodium.jar' => $this->sodiumJar]);
        $this->addModversion('mystery', '1.0', ['mods/mystery.jar' => $this->makeFabricJar('mystery', '1.0')]);
        $this->addModversion('export-pack-overrides', '1.0.0', ['config/sodium.json' => '{"quality":"fast"}']);
    }

    /**
     * @param  array<string, string>  $files
     */
    private function addModversion(string $modName, string $version, array $files, ?Build $build = null): Modversion
    {
        $mod = Mod::firstOrCreate(['name' => $modName], ['pretty_name' => ucfirst($modName)]);
        $this->putModversionZip($modName, $version, $files);
        $modversion = Modversion::create([
            'mod_id' => $mod->id,
            'version' => $version,
            'md5' => md5_file($this->modRepository."mods/$modName/$modName-$version.zip"),
            'filesize' => filesize($this->modRepository."mods/$modName/$modName-$version.zip"),
        ]);
        ($build ?? $this->build)->modversions()->attach($modversion->id);

        return $modversion;
    }

    /**
     * Download an export and return its entries as name => contents.
     *
     * @return array<string, string>
     */
    private function export(string $format, ?Build $build = null): array
    {
        $response = $this->get('/modpack/build/'.($build ?? $this->build)->id."/export/$format");
        $response->assertOk();
        $this->assertInstanceOf(BinaryFileResponse::class, $response->baseResponse);

        $zip = new ZipArchive;
        $zip->open($response->baseResponse->getFile()->getPathname());
        $entries = [];
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $entries[$zip->getNameIndex($i)] = $zip->getFromIndex($i);
        }
        $zip->close();
        ksort($entries);

        return $entries;
    }

    public function test_client_zip_merges_every_mod_version(): void
    {
        $response = $this->get("/modpack/build/{$this->build->id}/export/technic");
        $response->assertDownload('export-pack-1.0.0.zip');

        $this->assertSame(
            ['bin/version.json', 'config/sodium.json', 'mods/mystery.jar', 'mods/sodium.jar'],
            array_keys($this->export('technic'))
        );
    }

    public function test_server_zip_leaves_out_the_client_profile_and_explains_the_loader(): void
    {
        $entries = $this->export('server');

        $this->assertSame(['README.txt', 'config/sodium.json', 'mods/mystery.jar', 'mods/sodium.jar'], array_keys($entries));
        $this->assertStringContainsString('Fabric Loader 0.14.9', $entries['README.txt']);
        $this->assertStringContainsString('https://fabricmc.net/use/server/', $entries['README.txt']);
    }

    public function test_server_zip_includes_the_forge_installer(): void
    {
        $build = Build::create(['modpack_id' => $this->modpack->id, 'version' => '2.0.0', 'minecraft' => '1.20.1']);
        $this->addModversion('forge', '1.20.1-forge-47.2.0', ['bin/modpack.jar' => $this->makeArchive(['install_profile.json' => '{}'])], $build);

        $entries = $this->export('server', $build);

        $this->assertArrayHasKey('installer.jar', $entries);
        $this->assertArrayNotHasKey('bin/modpack.jar', $entries);
        $this->assertStringContainsString('java -jar installer.jar --installServer', $entries['README.txt']);
    }

    public function test_mrpack_references_modrinth_hosted_jars_and_bundles_the_rest(): void
    {
        Http::fake([
            'api.modrinth.com/v2/version_files' => Http::response([
                sha1($this->sodiumJar) => ['files' => [[
                    'url' => 'https://cdn.modrinth.com/data/AANobbMI/versions/v1/sodium.jar',
                    'hashes' => ['sha1' => sha1($this->sodiumJar), 'sha512' => hash('sha512', $this->sodiumJar)],
                ]]],
            ]),
        ]);

        $entries = $this->export('mrpack');
        $index = json_decode($entries['modrinth.index.json'], true);

        $this->assertSame(['modrinth.index.json', 'overrides/config/sodium.json', 'overrides/mods/mystery.jar'], array_keys($entries));
        $this->assertSame('1.0.0', $index['versionId']);
        $this->assertSame(['minecraft' => '1.20.1', 'fabric-loader' => '0.14.9'], $index['dependencies']);
        $this->assertSame([[
            'path' => 'mods/sodium.jar',
            'hashes' => ['sha1' => sha1($this->sodiumJar), 'sha512' => hash('sha512', $this->sodiumJar)],
            'env' => ['client' => 'required', 'server' => 'required'],
            'downloads' => ['https://cdn.modrinth.com/data/AANobbMI/versions/v1/sodium.jar'],
            'fileSize' => strlen($this->sodiumJar),
        ]], $index['files']);
    }

    public function test_curseforge_zip_has_manifest_and_overrides(): void
    {
        $entries = $this->export('curseforge');
        $manifest = json_decode($entries['manifest.json'], true);

        $this->assertSame(
            ['manifest.json', 'overrides/config/sodium.json', 'overrides/mods/mystery.jar', 'overrides/mods/sodium.jar'],
            array_keys($entries)
        );
        $this->assertSame([['id' => 'fabric-0.14.9', 'primary' => true]], $manifest['minecraft']['modLoaders']);
        $this->assertSame('minecraftModpack', $manifest['manifestType']);
        $this->assertSame('overrides', $manifest['overrides']);
    }

    public function test_missing_files_are_listed_instead_of_failing_the_export(): void
    {
        unlink($this->modRepository.'mods/mystery/mystery-1.0.zip');

        $entries = $this->export('technic');

        $this->assertArrayNotHasKey('mods/mystery.jar', $entries);
        $this->assertStringContainsString('mystery 1.0', $entries['EXPORT_WARNINGS.txt']);
    }

    public function test_unknown_format_is_not_found(): void
    {
        $this->get("/modpack/build/{$this->build->id}/export/zipfile")->assertNotFound();
    }

    public function test_exports_require_access_to_the_modpack(): void
    {
        $user = new User;
        $user->forceFill([
            'username' => 'outsider', 'email' => 'outsider@example.com', 'password' => 'password',
            'created_ip' => '127.0.0.1', 'created_by_user_id' => 1, 'updated_by_user_id' => 1, 'updated_by_ip' => '127.0.0.1',
        ])->save();
        $permission = new UserPermission;
        $permission->user_id = $user->id;
        $permission->save();
        $this->be($user->fresh('permission'));

        $this->get("/modpack/build/{$this->build->id}/export/technic")->assertRedirect('dashboard');
        $this->get("/modpack/export/{$this->modpack->id}")->assertRedirect('dashboard');
    }

    public function test_backup_restores_builds_and_mod_versions(): void
    {
        $this->modpack->update(['recommended' => '1.0.0', 'latest' => '1.0.0']);

        $response = $this->get("/modpack/export/{$this->modpack->id}");
        $response->assertDownload('export-pack-solder-backup.json');
        $backup = $response->streamedContent();

        $this->assertSame('solder-modpack', json_decode($backup, true)['format']);

        $this->post('/modpack/import', [
            'name' => 'Restored Pack',
            'slug' => 'restored-pack',
            'source' => 'file',
            'file' => UploadedFile::fake()->createWithContent('backup.json', $backup),
        ])->assertSessionHasNoErrors();

        $restored = Modpack::where('slug', 'restored-pack')->firstOrFail();
        $this->assertSame('1.0.0', $restored->recommended);
        $restoredBuild = $restored->builds()->sole();
        $this->assertSame('1.20.1', $restoredBuild->minecraft);
        $this->assertEqualsCanonicalizing(
            $this->build->modversions()->pluck('modversions.id')->all(),
            $restoredBuild->modversions()->pluck('modversions.id')->all()
        );
    }
}
