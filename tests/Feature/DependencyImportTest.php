<?php

namespace Tests\Feature;

use App\Models\Mod;
use App\Models\Modversion;
use App\Models\User;
use App\Mods\Providers\CurseForge;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Testing\TestResponse;
use Tests\FakesModProviders;
use Tests\TestCase;

final class DependencyImportTest extends TestCase
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
     * Fake a Modrinth project with one version.
     *
     * @param  list<array{project_id: string, dependency_type: string}>  $dependencies
     */
    private function modrinthProject(string $id, string $slug, string $title, string $versionId, string $version, array $dependencies = []): array
    {
        return [
            "api.modrinth.com/v2/project/$id" => Http::response(['id' => $id, 'slug' => $slug, 'title' => $title, 'project_type' => 'mod']),
            "api.modrinth.com/v2/project/$id/members" => Http::response([]),
            "api.modrinth.com/v2/project/$id/version*" => Http::response([[
                'id' => $versionId,
                'version_number' => $version,
                'version_type' => 'release',
                'game_versions' => ['1.20.1'],
                'loaders' => ['fabric'],
                'dependencies' => $dependencies,
                'files' => [['url' => "https://cdn.modrinth.com/data/$id/versions/$versionId/$slug.jar", 'filename' => "$slug.jar", 'primary' => true]],
            ]]),
            "cdn.modrinth.com/data/$id/versions/$versionId/$slug.jar" => Http::response($this->makeFabricJar($slug, $version)),
        ];
    }

    private function fakeIrisAndSodium(): void
    {
        Http::fake(
            $this->modrinthProject('YL57xq9U', 'iris', 'Iris', 'iris-v1', '1.7.0', [
                ['project_id' => 'AANobbMI', 'dependency_type' => 'required'],
                ['project_id' => 'optional', 'dependency_type' => 'optional'],
            ])
            + $this->modrinthProject('AANobbMI', 'sodium', 'Sodium', 'sodium-v1', '0.5.0')
        );
    }

    private function importIris(bool $withDependencies): TestResponse
    {
        return $this->post('/mod/import/details/modrinth/YL57xq9U', array_filter([
            'versions' => [base64_encode('iris-v1')],
            'with_dependencies' => $withDependencies ? 1 : null,
        ]));
    }

    public function test_importing_a_mod_also_imports_its_required_mods(): void
    {
        $this->fakeIrisAndSodium();

        $response = $this->importIris(true);

        $response->assertSessionHasNoErrors();
        $response->assertSessionHas('success', 'Imported 1 version. Also imported required mods: Sodium 0.5.0.');
        $this->assertSame('1.20.1-0.5.0', Mod::where('name', 'sodium')->firstOrFail()->versions()->sole()->version);
        Http::assertNotSent(fn (Request $request) => str_contains($request->url(), 'project/optional'));
    }

    public function test_required_mods_already_in_the_library_are_not_imported_again(): void
    {
        $this->fakeIrisAndSodium();
        $sodium = Mod::create(['name' => 'sodium', 'pretty_name' => 'Sodium']);
        Modversion::create(['mod_id' => $sodium->id, 'version' => '0.4.0', 'md5' => 'x', 'provider' => 'modrinth', 'provider_project_id' => 'AANobbMI', 'provider_version_id' => 'old']);

        $this->importIris(true)->assertSessionHas('success', 'Imported 1 version.');

        $this->assertSame(['0.4.0'], $sodium->versions()->pluck('version')->all());
        Http::assertNotSent(fn (Request $request) => str_contains($request->url(), 'project/AANobbMI'));
    }

    public function test_required_mods_are_left_alone_when_not_asked_for(): void
    {
        $this->fakeIrisAndSodium();

        $this->importIris(false)->assertSessionHas('success', 'Imported 1 version.');

        $this->assertFalse(Mod::where('name', 'sodium')->exists());
    }

    public function test_missing_compatible_version_of_a_required_mod_is_reported(): void
    {
        Http::fake(
            $this->modrinthProject('YL57xq9U', 'iris', 'Iris', 'iris-v1', '1.7.0', [['project_id' => 'AANobbMI', 'dependency_type' => 'required']])
            + ['api.modrinth.com/v2/project/AANobbMI' => Http::response(['id' => 'AANobbMI', 'slug' => 'sodium', 'title' => 'Sodium']),
                'api.modrinth.com/v2/project/AANobbMI/members' => Http::response([]),
                'api.modrinth.com/v2/project/AANobbMI/version*' => Http::response([])]
        );

        $response = $this->importIris(true);

        $this->assertSame(['Iris requires Sodium, but no version for 1.20.1 fabric was found. Add it by hand.'], session('errors')->all());
        $this->assertTrue(Mod::where('name', 'iris')->exists());
    }

    public function test_curseforge_files_record_their_required_mods(): void
    {
        config(['solder.curseforge_api_key' => 'test-key']);
        Http::fake([
            'api.curseforge.com/v1/mods/111' => Http::response(['data' => ['id' => 111, 'slug' => 'create', 'name' => 'Create', 'classId' => 6]]),
            'api.curseforge.com/v1/mods/111/files*' => Http::response(['data' => [[
                'id' => 9, 'modId' => 111, 'fileName' => 'create.jar', 'downloadUrl' => 'https://edge.forgecdn.net/create.jar',
                'gameVersions' => ['1.20.1', 'Forge'],
                'dependencies' => [['modId' => 222, 'relationType' => 3], ['modId' => 333, 'relationType' => 2]],
            ]]]),
        ]);

        $this->assertSame(['222'], CurseForge::mod('111')->versions['9']->dependencies);
    }
}
