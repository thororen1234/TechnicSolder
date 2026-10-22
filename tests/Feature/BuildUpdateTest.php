<?php

namespace Tests\Feature;

use App\Models\Build;
use App\Models\Mod;
use App\Models\Modpack;
use App\Models\Modversion;
use App\Models\User;
use App\Mods\Providers\Modrinth;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Tests\FakesModProviders;
use Tests\TestCase;
use ZipArchive;

final class BuildUpdateTest extends TestCase
{
    use FakesModProviders;
    use RefreshDatabase;

    private Modpack $modpack;

    private Build $build;

    protected function setUp(): void
    {
        parent::setUp();

        $this->seed();
        $this->be(User::find(1));
        $this->setUpModRepository();

        $this->modpack = Modpack::create(['name' => 'Update Pack', 'slug' => 'update-pack']);
        $this->build = Build::create(['modpack_id' => $this->modpack->id, 'version' => '1.0.0', 'minecraft' => '1.20.1']);

        $this->addToBuild('fabric-loader', '1.20.1-0.14.9', ['provider' => 'fabric', 'provider_project_id' => '1.20.1', 'provider_version_id' => '1.20.1-0.14.9']);
        $this->addToBuild('sodium', '1.20.1-0.5.0', ['provider' => 'modrinth', 'provider_project_id' => 'AANobbMI', 'provider_version_id' => 'v1']);
        $this->addToBuild('handmade', '1.0', []);

        $this->fakeFabricMeta();
    }

    private function addToBuild(string $modName, string $version, array $source): Modversion
    {
        $mod = Mod::firstOrCreate(['name' => $modName], ['pretty_name' => ucfirst($modName)]);
        $modversion = Modversion::create(['mod_id' => $mod->id, 'version' => $version, 'md5' => 'x'] + $source);
        $this->build->modversions()->attach($modversion->id);

        return $modversion;
    }

    /**
     * @param  array<string, string>  $versions  Modrinth version ID => mod version, newest first
     */
    private function fakeSodiumVersions(array $versions): void
    {
        $fakes = [
            'api.modrinth.com/v2/project/AANobbMI' => Http::response(['id' => 'AANobbMI', 'slug' => 'sodium', 'title' => 'Sodium', 'project_type' => 'mod']),
            'api.modrinth.com/v2/project/AANobbMI/members' => Http::response([]),
            'api.modrinth.com/v2/project/AANobbMI/version*' => Http::response(collect($versions)->map(fn ($number, $id) => [
                'id' => $id,
                'version_number' => $number,
                'version_type' => 'release',
                'game_versions' => ['1.20.1'],
                'loaders' => ['fabric'],
                'files' => [['url' => "https://cdn.modrinth.com/data/AANobbMI/versions/$id/sodium.jar", 'filename' => 'sodium.jar', 'primary' => true]],
            ])->values()->all()),
        ];

        foreach ($versions as $id => $number) {
            $fakes["cdn.modrinth.com/data/AANobbMI/versions/$id/sodium.jar"] = Http::response($this->makeFabricJar('sodium', $number));
        }

        Http::fake($fakes);
    }

    public function test_imports_record_where_each_version_came_from(): void
    {
        $this->fakeSodiumVersions(['v2' => '0.5.1', 'v1' => '0.5.0']);
        $result = Modrinth::install('AANobbMI', ['v2']);

        $modversion = Modversion::findOrFail($result->modversionIds['v2']);
        $this->assertSame('modrinth', $modversion->provider);
        $this->assertSame('AANobbMI', $modversion->provider_project_id);
        $this->assertSame('v2', $modversion->provider_version_id);
    }

    public function test_reimporting_an_untracked_version_records_its_source(): void
    {
        $this->fakeSodiumVersions(['v2' => '0.5.1', 'v1' => '0.5.0']);
        $handmade = Modversion::create(['mod_id' => Mod::where('name', 'sodium')->value('id'), 'version' => '1.20.1-0.5.1', 'md5' => 'x']);

        Modrinth::install('AANobbMI', ['v2']);

        $this->assertSame('v2', $handmade->fresh()->provider_version_id);
    }

    public function test_check_lists_newer_versions_of_tracked_mods_only(): void
    {
        $this->fakeSodiumVersions(['v2' => '0.5.1', 'v1' => '0.5.0']);
        $response = $this->getJson("/modpack/build/{$this->build->id}/updates");

        $response->assertOk();
        $updates = $response->json('updates');
        $this->assertCount(1, $updates);
        $this->assertSame('sodium', $updates[0]['mod']);
        $this->assertSame('1.20.1-0.5.0', $updates[0]['current']);
        $this->assertSame('v2', $updates[0]['latest_key']);
        $this->assertSame('0.5.1', $updates[0]['latest_label']);
        $this->assertSame('Modrinth', $updates[0]['provider']);

        Http::assertSent(fn ($request) => str_contains($request->url(), '/project/AANobbMI/version?')
            && str_contains(urldecode($request->url()), 'game_versions=["1.20.1"]')
            && str_contains(urldecode($request->url()), 'loaders=["fabric"]'));
    }

    public function test_check_never_offers_an_older_version(): void
    {
        // The build already has a beta that is newer than the latest release
        $this->fakeSodiumVersions(['v3-beta' => '0.6.0', 'v2' => '0.5.1', 'v1' => '0.5.0']);
        Modversion::where('provider_version_id', 'v1')->update(['provider_version_id' => 'v3-beta']);

        $this->getJson("/modpack/build/{$this->build->id}/updates")->assertExactJson(['updates' => []]);
    }

    public function test_applying_updates_creates_a_new_build_and_keeps_the_old_one(): void
    {
        $this->fakeSodiumVersions(['v2' => '0.5.1', 'v1' => '0.5.0']);
        $sodiumV1 = Modversion::where('provider_version_id', 'v1')->value('id');

        $response = $this->post("/modpack/build/{$this->build->id}/updates", [
            'version' => '1.0.1',
            'modversions' => [$sodiumV1],
        ]);

        $newBuild = Build::where('modpack_id', $this->modpack->id)->where('version', '1.0.1')->firstOrFail();
        $response->assertRedirect(url("modpack/build/{$newBuild->id}"));
        $response->assertSessionHas('success', 'Build 1.0.1 created with 1 update.');
        $this->assertFalse((bool) $newBuild->is_published);

        $versions = fn (Build $build) => $build->modversions()->with('mod')->get()->mapWithKeys(fn ($mv) => [$mv->mod->name => $mv->version])->sortKeys()->all();
        $this->assertSame(['fabric-loader' => '1.20.1-0.14.9', 'handmade' => '1.0', 'sodium' => '1.20.1-0.5.1'], $versions($newBuild));
        $this->assertSame(['fabric-loader' => '1.20.1-0.14.9', 'handmade' => '1.0', 'sodium' => '1.20.1-0.5.0'], $versions($this->build));
    }

    public function test_build_page_offers_compare_health_and_updates(): void
    {
        $response = $this->get("/modpack/build/{$this->build->id}");

        $response->assertOk();
        $response->assertSee(route('modpack.build.compare', ['build_id' => $this->build->id]), false);
        // The status endpoints are embedded with @js(), which escapes slashes
        $response->assertSee(str_replace('/', '\/', route('modpack.build.health', ['build_id' => $this->build->id])), false);
        $response->assertSee(str_replace('/', '\/', route('modpack.build.updates', ['build_id' => $this->build->id])), false);
        // Suggested version for the updated build
        $response->assertSee('1.0.1');
    }

    public function test_new_build_version_must_be_unused(): void
    {
        $response = $this->post("/modpack/build/{$this->build->id}/updates", [
            'version' => '1.0.0',
            'modversions' => [1],
        ]);

        $response->assertSessionHasErrors('version');
        $this->assertSame(1, Build::where('modpack_id', $this->modpack->id)->count());
    }

    public function test_curseforge_export_lists_tracked_curseforge_mods_in_the_manifest(): void
    {
        $jei = $this->addToBuild('jei', '1.20.1-15.2.0', ['provider' => 'curseforge', 'provider_project_id' => '238222', 'provider_version_id' => '111']);
        $this->putModversionZip('jei', '1.20.1-15.2.0', ['mods/jei.jar' => 'jar']);
        $this->putModversionZip('handmade', '1.0', ['mods/handmade.jar' => 'jar']);
        $this->putModversionZip('sodium', '1.20.1-0.5.0', ['mods/sodium.jar' => 'jar']);
        $this->putModversionZip('fabric-loader', '1.20.1-0.14.9', ['bin/version.json' => '{}']);

        $response = $this->get("/modpack/build/{$this->build->id}/export/curseforge");

        $zip = new ZipArchive;
        $zip->open($response->baseResponse->getFile()->getPathname());
        $manifest = json_decode($zip->getFromName('manifest.json'), true);
        $this->assertSame([['projectID' => 238222, 'fileID' => 111, 'required' => true]], $manifest['files']);
        $this->assertFalse($zip->locateName('overrides/mods/jei.jar'));
        $this->assertNotFalse($zip->locateName('overrides/mods/handmade.jar'));
        $zip->close();
        $this->assertNotNull($jei);
    }
}
