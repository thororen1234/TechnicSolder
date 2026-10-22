<?php

namespace Tests\Feature;

use App\Models\Build;
use App\Models\Mod;
use App\Models\Modpack;
use App\Models\Modversion;
use App\Models\User;
use App\Models\UserPermission;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

final class BuildCompareTest extends TestCase
{
    use RefreshDatabase;

    private Modpack $modpack;

    protected function setUp(): void
    {
        parent::setUp();

        $this->seed();
        $this->be(User::find(1));

        $this->modpack = Modpack::create(['name' => 'Compare Pack', 'slug' => 'compare-pack']);
    }

    /**
     * @param  array<string, string>  $mods  mod name => version
     */
    private function build(string $version, array $mods): Build
    {
        $build = Build::create(['modpack_id' => $this->modpack->id, 'version' => $version, 'minecraft' => '1.20.1']);

        foreach ($mods as $name => $modVersion) {
            $mod = Mod::firstOrCreate(['name' => $name], ['pretty_name' => ucfirst($name)]);
            $modversion = Modversion::firstOrCreate(['mod_id' => $mod->id, 'version' => $modVersion], ['md5' => 'x']);
            $build->modversions()->attach($modversion->id);
        }

        return $build;
    }

    public function test_compares_with_the_previous_build_by_default(): void
    {
        $this->build('1.0', ['sodium' => '0.5.0', 'iris' => '1.6', 'optifine' => 'HD_U']);
        $this->build('1.1', ['sodium' => '0.5.1', 'iris' => '1.6', 'lithium' => '0.11']);
        $this->build('1.2', ['sodium' => '0.5.2']);
        $build = Build::where('version', '1.1')->firstOrFail();

        $response = $this->get("/modpack/build/{$build->id}/compare");

        $response->assertOk();
        $response->assertSeeInOrder(['Added', 'Lithium', 'Updated', 'Sodium', '0.5.0', '0.5.1', 'Removed', 'Optifine']);
        $this->assertSame(
            "## Compare Pack 1.1\n\nChanges since 1.0:\n\n### Added\n- Lithium 0.11\n\n### Updated\n- Sodium 0.5.0 → 0.5.1\n\n### Removed\n- Optifine",
            $response->viewData('markdown')
        );
        $this->assertSame(1, $response->viewData('unchanged'));
    }

    public function test_compares_with_a_chosen_build(): void
    {
        $first = $this->build('1.0', ['sodium' => '0.5.0']);
        $this->build('1.1', ['sodium' => '0.5.1']);
        $latest = $this->build('1.2', ['sodium' => '0.5.2']);

        $response = $this->get("/modpack/build/{$latest->id}/compare?with={$first->id}");

        $this->assertSame('1.0', $response->viewData('base')->version);
        $this->assertStringContainsString('- Sodium 0.5.0 → 0.5.2', $response->viewData('markdown'));
    }

    public function test_only_build_has_nothing_to_compare(): void
    {
        $build = $this->build('1.0', ['sodium' => '0.5.0']);

        $this->get("/modpack/build/{$build->id}/compare")->assertOk()->assertSee('nothing to compare');
    }

    public function test_compare_requires_access_to_the_modpack(): void
    {
        $build = $this->build('1.0', ['sodium' => '0.5.0']);
        $user = new User;
        $user->forceFill([
            'username' => 'outsider', 'email' => 'outsider@example.com', 'password' => 'password',
            'created_ip' => '127.0.0.1', 'created_by_user_id' => 1, 'updated_by_user_id' => 1, 'updated_by_ip' => '127.0.0.1',
        ])->save();
        $permission = new UserPermission;
        $permission->user_id = $user->id;
        $permission->save();
        $this->be($user->fresh('permission'));

        $this->get("/modpack/build/{$build->id}/compare")->assertRedirect('dashboard');
    }
}
