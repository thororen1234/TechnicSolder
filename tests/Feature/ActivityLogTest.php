<?php

namespace Tests\Feature;

use App\Models\ActivityLog;
use App\Models\Build;
use App\Models\Mod;
use App\Models\Modpack;
use App\Models\Modversion;
use App\Models\User;
use App\Models\UserPermission;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

final class ActivityLogTest extends TestCase
{
    use RefreshDatabase;

    private Modpack $modpack;

    private Build $build;

    private Mod $mod;

    protected function setUp(): void
    {
        parent::setUp();

        $this->seed();
        $this->be(User::find(1));

        $this->modpack = Modpack::create(['name' => 'Logged Pack', 'slug' => 'logged-pack']);
        $this->build = Build::create(['modpack_id' => $this->modpack->id, 'version' => '1.0', 'minecraft' => '1.20.1']);
        $this->mod = Mod::create(['name' => 'sodium', 'pretty_name' => 'Sodium']);
        Modversion::create(['mod_id' => $this->mod->id, 'version' => '0.5.0', 'md5' => 'x']);
        Modversion::create(['mod_id' => $this->mod->id, 'version' => '0.5.1', 'md5' => 'x']);
    }

    private function modify(string $action, array $data): void
    {
        $this->post("/modpack/modify/$action", $data, ['X-Requested-With' => 'XMLHttpRequest'])->assertOk();
    }

    private function descriptions(): array
    {
        return ActivityLog::orderBy('id')->pluck('description')->all();
    }

    public function test_build_edits_are_recorded_with_the_user(): void
    {
        $old = Modversion::where('version', '0.5.0')->value('id');
        $new = Modversion::where('version', '0.5.1')->value('id');

        $this->modify('add', ['build' => $this->build->id, 'mod-name' => 'sodium', 'mod-version' => '0.5.0']);
        $this->modify('version', ['build_id' => $this->build->id, 'modversion_id' => $old, 'version' => $new]);
        $this->modify('published', ['build' => $this->build->id, 'published' => 1, 'force' => 1]);
        $this->modify('delete', ['build_id' => $this->build->id, 'modversion_id' => $new]);

        $this->assertSame([
            'Added Sodium 0.5.0 to build 1.0',
            'Changed Sodium from 0.5.0 to 0.5.1 in build 1.0',
            'Published build 1.0',
            'Removed Sodium 0.5.1 from build 1.0',
        ], $this->descriptions());

        $entry = ActivityLog::first();
        $this->assertSame(1, $entry->user_id);
        $this->assertSame($this->modpack->id, $entry->modpack_id);
        $this->assertSame($this->build->id, $entry->build_id);
        $this->assertSame(['mod' => 'sodium', 'version' => '0.5.0'], $entry->properties);
    }

    public function test_api_changes_are_recorded_with_the_token_user(): void
    {
        $token = User::find(1)->createToken('test')->plainTextToken;
        auth()->forgetGuards();

        $this->postJson('api/modpack/logged-pack/1.0/mod', ['mod_slug' => 'sodium', 'mod_version' => '0.5.0'], ['Authorization' => 'Bearer '.$token])
            ->assertCreated();

        $this->assertSame(['Added Sodium 0.5.0 to build 1.0 (API)'], $this->descriptions());
        $this->assertSame(1, ActivityLog::first()->user_id);
    }

    public function test_modpack_and_build_pages_show_their_activity(): void
    {
        ActivityLog::record('build.mod_added', 'Added Sodium 0.5.0 to build 1.0', build: $this->build);

        $this->get("/modpack/view/{$this->modpack->id}")->assertOk()->assertSee('Added Sodium 0.5.0 to build 1.0');
        $this->get("/modpack/build/{$this->build->id}")->assertOk()->assertSee('Added Sodium 0.5.0 to build 1.0');
    }

    public function test_activity_page_only_shows_modpacks_the_user_can_manage(): void
    {
        $other = Modpack::create(['name' => 'Secret Pack', 'slug' => 'secret-pack']);
        ActivityLog::record('modpack.edited', 'Edited the details of Logged Pack', $this->modpack);
        ActivityLog::record('modpack.edited', 'Edited the details of Secret Pack', $other);

        $this->get('/solder/activity')->assertOk()->assertSee('Logged Pack')->assertSee('Secret Pack');

        $user = new User;
        $user->forceFill([
            'username' => 'packdev', 'email' => 'packdev@example.com', 'password' => 'password',
            'created_ip' => '127.0.0.1', 'created_by_user_id' => 1, 'updated_by_user_id' => 1, 'updated_by_ip' => '127.0.0.1',
        ])->save();
        $permission = new UserPermission;
        $permission->user_id = $user->id;
        $permission->modpacks = [$this->modpack->id];
        $permission->save();
        $this->be($user->fresh('permission'));

        $this->get('/solder/activity')->assertOk()
            ->assertSee('Edited the details of Logged Pack')
            ->assertDontSee('Edited the details of Secret Pack');
    }
}
