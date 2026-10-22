<?php

namespace Tests\Feature;

use App\Models\Build;
use App\Models\Mod;
use App\Models\Modpack;
use App\Models\Modversion;
use App\Models\User;
use App\Mods\Providers\CurseForge;
use App\Mods\Providers\Modrinth;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Http;
use Tests\FakesModProviders;
use Tests\TestCase;
use ZipArchive;

final class ModEnvironmentTest extends TestCase
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

    public function test_modrinth_projects_that_dont_run_on_servers_are_client_only(): void
    {
        Http::fake([
            'api.modrinth.com/v2/project/xaero' => Http::response(['id' => 'xaero', 'slug' => 'xaeros-minimap', 'title' => "Xaero's Minimap", 'client_side' => 'required', 'server_side' => 'unsupported']),
            'api.modrinth.com/v2/project/xaero/members' => Http::response([]),
            'api.modrinth.com/v2/project/xaero/version' => Http::response([[
                'id' => 'v1', 'version_number' => '24.0', 'game_versions' => ['1.20.1'], 'loaders' => ['fabric'],
                'files' => [['url' => 'https://cdn.modrinth.com/data/xaero/versions/v1/minimap.jar', 'filename' => 'minimap.jar', 'primary' => true]],
            ]]),
            'cdn.modrinth.com/*' => Http::response($this->makeFabricJar('xaerominimap', '24.0')),
        ]);

        $result = Modrinth::install('xaero', ['v1']);

        $this->assertSame('client', Modversion::find($result->modversionIds['v1'])->environment);
    }

    public function test_curseforge_files_tagged_for_one_side(): void
    {
        config(['solder.curseforge_api_key' => 'test-key']);
        Http::fake([
            'api.curseforge.com/v1/mods/1' => Http::response(['data' => ['id' => 1, 'slug' => 'mod', 'name' => 'Mod', 'classId' => 6]]),
            'api.curseforge.com/v1/mods/1/files*' => Http::response(['data' => [
                ['id' => 10, 'modId' => 1, 'fileName' => 'a.jar', 'gameVersions' => ['1.20.1', 'Forge', 'Server']],
                ['id' => 11, 'modId' => 1, 'fileName' => 'b.jar', 'gameVersions' => ['1.20.1', 'Forge', 'Client', 'Server']],
            ]]),
        ]);

        $versions = CurseForge::mod('1')->versions;

        $this->assertSame('server', $versions['10']->environment);
        $this->assertNull($versions['11']->environment);
    }

    public function test_uploaded_jars_use_the_side_they_declare(): void
    {
        $jar = $this->makeArchive(['fabric.mod.json' => json_encode(['id' => 'zoom', 'version' => '1.0', 'environment' => 'client'])]);

        $this->post('/mod/upload', ['files' => [UploadedFile::fake()->createWithContent('zoom.jar', $jar)]]);

        $this->assertSame('client', Mod::where('name', 'zoom')->firstOrFail()->versions()->sole()->environment);
    }

    public function test_side_can_be_changed_by_hand(): void
    {
        $mod = Mod::create(['name' => 'zoom', 'pretty_name' => 'Zoom']);
        $modversion = Modversion::create(['mod_id' => $mod->id, 'version' => '1.0', 'md5' => 'x']);
        $headers = ['X-Requested-With' => 'XMLHttpRequest'];

        $this->postJson("/mod/version-environment/{$modversion->id}", ['environment' => 'client'], $headers)->assertJson(['status' => 'success']);
        $this->assertSame('client', $modversion->fresh()->environment);

        $this->postJson("/mod/version-environment/{$modversion->id}", ['environment' => ''], $headers)->assertJson(['status' => 'success']);
        $this->assertNull($modversion->fresh()->environment);

        $this->postJson("/mod/version-environment/{$modversion->id}", ['environment' => 'toaster'], $headers)->assertUnprocessable();
    }

    /**
     * A build with one mod for each side.
     */
    private function sidedBuild(): Build
    {
        $modpack = Modpack::create(['name' => 'Sided', 'slug' => 'sided']);
        $build = Build::create(['modpack_id' => $modpack->id, 'version' => '1.0', 'minecraft' => '1.20.1']);

        foreach (['shared' => null, 'minimap' => 'client', 'backups' => 'server'] as $name => $environment) {
            $mod = Mod::create(['name' => $name, 'pretty_name' => ucfirst($name)]);
            $this->putModversionZip($name, '1.0', ["mods/$name.jar" => "$name-jar", "config/$name.toml" => 'x=1']);
            $build->modversions()->attach(Modversion::create(['mod_id' => $mod->id, 'version' => '1.0', 'md5' => 'x', 'environment' => $environment])->id);
        }

        return $build;
    }

    private function exportEntries(Build $build, string $format): array
    {
        $response = $this->get("/modpack/build/{$build->id}/export/$format");
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

    public function test_exports_leave_out_mods_for_the_other_side(): void
    {
        $build = $this->sidedBuild();
        Http::fake(['api.modrinth.com/v2/version_files' => Http::response([])]);

        $server = array_keys($this->exportEntries($build, 'server'));
        $this->assertContains('mods/backups.jar', $server);
        $this->assertNotContains('mods/minimap.jar', $server);

        $client = array_keys($this->exportEntries($build, 'technic'));
        $this->assertContains('mods/minimap.jar', $client);
        $this->assertNotContains('mods/backups.jar', $client);

        $curseforge = array_keys($this->exportEntries($build, 'curseforge'));
        $this->assertContains('overrides/mods/minimap.jar', $curseforge);
        $this->assertNotContains('overrides/mods/backups.jar', $curseforge);

        $mrpack = array_keys($this->exportEntries($build, 'mrpack'));
        $this->assertContains('client-overrides/mods/minimap.jar', $mrpack);
        $this->assertContains('server-overrides/mods/backups.jar', $mrpack);
        $this->assertContains('overrides/mods/shared.jar', $mrpack);
    }

    public function test_mrpack_marks_hosted_files_with_their_side(): void
    {
        $build = $this->sidedBuild();
        Http::fake(['api.modrinth.com/v2/version_files' => Http::response([
            sha1('minimap-jar') => ['files' => [['url' => 'https://cdn.modrinth.com/minimap.jar', 'hashes' => ['sha1' => sha1('minimap-jar')]]]],
        ])]);

        $index = json_decode($this->exportEntries($build, 'mrpack')['modrinth.index.json'], true);

        $this->assertSame(['client' => 'required', 'server' => 'unsupported'], $index['files'][0]['env']);
    }
}
