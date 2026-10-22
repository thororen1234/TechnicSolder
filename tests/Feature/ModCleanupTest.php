<?php

namespace Tests\Feature;

use App\Models\Build;
use App\Models\Mod;
use App\Models\Modpack;
use App\Models\Modversion;
use App\Models\User;
use App\Models\UserPermission;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\FakesModProviders;
use Tests\TestCase;

final class ModCleanupTest extends TestCase
{
    use FakesModProviders;
    use RefreshDatabase;

    private Modversion $used;

    private Modversion $oldVersion;

    private Modversion $orphan;

    protected function setUp(): void
    {
        parent::setUp();

        $this->seed();
        $this->be(User::find(1));
        $this->setUpModRepository();

        // The seeded mod versions aren't in any build either; start from a clean slate
        Modversion::doesntHave('builds')->delete();

        $sodium = Mod::create(['name' => 'sodium', 'pretty_name' => 'Sodium']);
        $orphanMod = Mod::create(['name' => 'orphan', 'pretty_name' => 'Orphan']);
        $this->used = $this->version($sodium, '0.5.1');
        $this->oldVersion = $this->version($sodium, '0.5.0');
        $this->orphan = $this->version($orphanMod, '1.0');

        $modpack = Modpack::create(['name' => 'Pack', 'slug' => 'pack']);
        Build::create(['modpack_id' => $modpack->id, 'version' => '1.0', 'minecraft' => '1.20.1'])->modversions()->attach($this->used->id);
    }

    /**
     * IDs of the mod versions created by this test that still exist.
     *
     * @return list<int>
     */
    private function remaining(): array
    {
        return Modversion::whereIn('id', [$this->used->id, $this->oldVersion->id, $this->orphan->id])->orderBy('id')->pluck('id')->all();
    }

    private function version(Mod $mod, string $version): Modversion
    {
        $this->putModversionZip($mod->name, $version, ['mods/'.$mod->name.'.jar' => str_repeat('x', 2048)]);

        return Modversion::create(['mod_id' => $mod->id, 'version' => $version, 'md5' => 'x', 'filesize' => 2048]);
    }

    private function zip(Modversion $modversion): string
    {
        return $this->modRepository.$modversion->repositoryPath();
    }

    public function test_lists_only_versions_no_build_uses(): void
    {
        $response = $this->get('/mod/unused');

        $response->assertOk();
        $this->assertEqualsCanonicalizing([$this->oldVersion->id, $this->orphan->id], $response->viewData('modversions')->pluck('id')->all());
    }

    public function test_deletes_selected_versions_and_their_files(): void
    {
        $response = $this->post('/mod/unused', [
            'modversions' => [$this->orphan->id, $this->used->id],
            'delete_files' => 1,
        ]);

        $response->assertRedirect('mod/unused');
        $this->assertStringStartsWith('Deleted 1 unused mod version and freed', session('success'));
        $this->assertNull(Modversion::find($this->orphan->id));
        $this->assertFileDoesNotExist($this->zip($this->orphan));
        $this->assertDirectoryDoesNotExist($this->modRepository.'mods/orphan');
        // In use, so never deleted even when submitted
        $this->assertNotNull(Modversion::find($this->used->id));
        $this->assertFileExists($this->zip($this->used));
        $this->assertNotNull(Modversion::find($this->oldVersion->id));
    }

    public function test_delete_all_can_keep_the_files(): void
    {
        $this->post('/mod/unused', ['all' => 1])->assertSessionHas('success', 'Deleted 2 unused mod versions. Their files were kept in the repository.');

        $this->assertSame([$this->used->id], $this->remaining());
        $this->assertFileExists($this->zip($this->oldVersion));
    }

    public function test_nothing_selected_is_an_error(): void
    {
        $this->post('/mod/unused', [])->assertSessionHasErrors();
        $this->assertCount(3, $this->remaining());
    }

    public function test_cleanup_requires_permission_to_delete_mods(): void
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

        $this->get('/mod/unused')->assertRedirect('dashboard');
        $this->post('/mod/unused', ['all' => 1])->assertRedirect('dashboard');
        $this->assertCount(3, $this->remaining());
    }
}
