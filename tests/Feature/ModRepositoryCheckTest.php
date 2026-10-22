<?php

namespace Tests\Feature;

use App\Models\Mod;
use App\Models\Modversion;
use App\Models\User;
use App\Models\UserPermission;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\FakesModProviders;
use Tests\TestCase;

final class ModRepositoryCheckTest extends TestCase
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

    private function modversion(string $name, string $version, ?string $storedMd5 = null, bool $storeFile = true): Modversion
    {
        $mod = Mod::firstOrCreate(['name' => $name], ['pretty_name' => ucfirst($name)]);
        $md5 = 'missing';
        if ($storeFile) {
            $this->putModversionZip($name, $version, ['mods/'.$name.'.jar' => $name.$version]);
            $md5 = md5_file($this->modRepository."mods/$name/$name-$version.zip");
        }

        return Modversion::create(['mod_id' => $mod->id, 'version' => $version, 'md5' => $storedMd5 ?? $md5, 'filesize' => 1]);
    }

    /**
     * Run the check and return its problems for the mods created in the test, keyed by mod name.
     */
    private function runCheck(): array
    {
        $response = $this->post('/solder/repository');
        $response->assertRedirect();
        $page = $this->get($response->headers->get('Location'));
        $page->assertOk();

        return collect($page->viewData('task')['result']['problems'])
            ->whereIn('mod', ['Good', 'Edited', 'Gone'])
            ->keyBy('mod')
            ->map(fn ($problem) => $problem['problem'])
            ->all();
    }

    public function test_check_reports_missing_and_changed_files(): void
    {
        $this->modversion('good', '1.0');
        $this->modversion('edited', '1.0', storedMd5: str_repeat('0', 32));
        $this->modversion('gone', '1.0', storeFile: false);

        $this->assertSame(['Edited' => 'changed', 'Gone' => 'missing'], $this->runCheck());
    }

    public function test_updating_checksums_accepts_changed_files(): void
    {
        $edited = $this->modversion('edited', '1.0', storedMd5: str_repeat('0', 32));

        $response = $this->post('/solder/repository/fix', ['modversions' => [$edited->id]]);

        $response->assertRedirect(route('solder.repository'));
        $response->assertSessionHas('success', 'Updated the stored checksum of 1 mod version.');
        $this->assertSame(md5_file($this->modRepository.'mods/edited/edited-1.0.zip'), $edited->fresh()->md5);
        $this->assertSame([], $this->runCheck());
    }

    public function test_page_explains_when_no_check_has_run(): void
    {
        $this->get('/solder/repository')->assertOk()->assertSee('No check has been run yet');
    }

    public function test_repository_check_requires_permission_to_manage_mods(): void
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

        $this->get('/solder/repository')->assertRedirect('dashboard');
        $this->post('/solder/repository')->assertRedirect('dashboard');
        $this->post('/solder/repository/fix', ['modversions' => [1]])->assertRedirect('dashboard');
    }
}
