<?php

namespace Tests\Feature;

use App\Models\ActivityLog;
use App\Models\Build;
use App\Models\Mod;
use App\Models\Modpack;
use App\Models\ModpackImport;
use App\Models\Modversion;
use App\Models\User;
use App\Models\UserPermission;
use App\Services\PackExportService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Storage;
use Illuminate\Testing\TestResponse;
use Tests\FakesModProviders;
use Tests\TestCase;

final class ModpackImportTest extends TestCase
{
    use FakesModProviders;
    use RefreshDatabase;

    private Modpack $modpack;

    private Build $existingBuild;

    protected function setUp(): void
    {
        parent::setUp();

        $this->seed();
        $this->be(User::find(1));
        $this->setUpModRepository();
        Storage::fake('local');

        $this->modpack = Modpack::create(['name' => 'DeceasedCraft', 'slug' => 'deceasedcraft']);
        $this->existingBuild = Build::create(['modpack_id' => $this->modpack->id, 'version' => '5.5.5', 'minecraft' => '1.20.1', 'is_published' => true]);
        $oldMod = Mod::create(['name' => 'old-mod', 'pretty_name' => 'Old Mod']);
        $this->existingBuild->modversions()->attach(Modversion::create(['mod_id' => $oldMod->id, 'version' => '1.0', 'md5' => 'x'])->id);
    }

    /**
     * A Modrinth pack with no mods, only an override file, so importing it needs no network.
     *
     * @param  array<string, string>  $dependencies
     */
    private function pack(string $version, array $dependencies = ['minecraft' => '1.20.1']): string
    {
        return $this->makeArchive([
            'modrinth.index.json' => json_encode([
                'formatVersion' => 1, 'game' => 'minecraft', 'versionId' => $version, 'name' => 'DeceasedCraft',
                'files' => [], 'dependencies' => $dependencies,
            ]),
            'overrides/config/pack.txt' => "version $version",
        ]);
    }

    /**
     * @param  array<string, mixed>  $fields
     */
    private function importInto(string $pack, array $fields = []): TestResponse
    {
        return $this->post('/modpack/import', [
            'target' => 'existing',
            'modpack_id' => $this->modpack->id,
            'source' => 'file',
            'file' => UploadedFile::fake()->createWithContent('deceasedcraft.mrpack', $pack),
        ] + $fields);
    }

    /**
     * @return list<string> "mod version" for every mod in the build
     */
    private function buildMods(Build $build): array
    {
        return $build->modversions()->with('mod')->get()
            ->map(fn (Modversion $modversion) => "{$modversion->mod->name} {$modversion->version}")
            ->sort()->values()->all();
    }

    private function userWithPermissions(array $permissions, array $modpacks = []): User
    {
        $user = new User;
        $user->forceFill([
            'username' => 'packdev', 'email' => 'packdev@example.com', 'password' => 'password',
            'created_ip' => '127.0.0.1', 'created_by_user_id' => 1, 'updated_by_user_id' => 1, 'updated_by_ip' => '127.0.0.1',
        ])->save();
        $permission = new UserPermission;
        $permission->user_id = $user->id;
        $permission->forceFill($permissions);
        $permission->modpacks = $modpacks;
        $permission->save();

        return $user->fresh('permission');
    }

    public function test_a_new_version_becomes_a_build_of_the_existing_modpack(): void
    {
        $modpackCount = Modpack::count();

        $response = $this->importInto($this->pack('5.5.4'));

        $build = $this->modpack->builds()->where('version', '5.5.4')->sole();
        $response->assertRedirect("modpack/build/{$build->id}");
        $response->assertSessionHas('success', '0 mod(s) imported.');
        $this->assertFalse((bool) $build->is_published);
        $this->assertSame(['deceasedcraft-overrides 5.5.4'], $this->buildMods($build));
        $this->assertSame($modpackCount, Modpack::count());

        $import = ModpackImport::sole();
        $this->assertSame(ModpackImport::COMPLETED, $import->status);
        $this->assertSame($build->id, $import->build_id);
        $this->assertNull($import->archive_path);
        $this->assertContains('Adding build 5.5.4 to DeceasedCraft', array_column($import->log, 'message'));
        $this->assertSame('Imported build 5.5.4 from deceasedcraft.mrpack', ActivityLog::where('action', 'build.imported')->sole()->description);
    }

    public function test_the_build_version_can_be_chosen(): void
    {
        $this->importInto($this->pack('5.5.5'), ['build_version' => '5.5.5-hotfix']);

        $this->assertTrue($this->modpack->builds()->where('version', '5.5.5-hotfix')->exists());
        $this->assertSame(['old-mod 1.0'], $this->buildMods($this->existingBuild));
    }

    public function test_an_existing_build_version_waits_for_a_decision_without_changing_anything(): void
    {
        $response = $this->importInto($this->pack('5.5.5'));

        $import = ModpackImport::sole();
        $response->assertRedirect(route('modpack.import.show', $import->id));
        $this->assertSame(ModpackImport::WAITING, $import->status);
        $this->assertSame('5.5.5', $import->build_version);
        Storage::disk('local')->assertExists($import->archive_path);
        $this->assertSame(['old-mod 1.0'], $this->buildMods($this->existingBuild));
        $this->assertSame(1, $this->modpack->builds()->count());

        $this->get(route('modpack.import.show', $import->id))
            ->assertOk()
            ->assertSee('DeceasedCraft already has a build 5.5.5.')
            ->assertSee('Overwrite 5.5.5')
            ->assertSee('Import as new build')
            ->assertSee('Cancel import');
    }

    public function test_overwriting_replaces_the_builds_mods_and_keeps_the_build(): void
    {
        $this->importInto($this->pack('5.5.5'));
        $import = ModpackImport::sole();
        $archivePath = $import->archive_path;

        $response = $this->post(route('modpack.import.show', $import->id), ['action' => 'overwrite']);

        $response->assertRedirect("modpack/build/{$this->existingBuild->id}");
        $this->assertSame(['deceasedcraft-overrides 5.5.5'], $this->buildMods($this->existingBuild));
        $this->assertTrue((bool) $this->existingBuild->fresh()->is_published);
        $this->assertSame(1, $this->modpack->builds()->count());

        $import->refresh();
        $this->assertSame(ModpackImport::COMPLETED, $import->status);
        $this->assertTrue($import->overwrite);
        $this->assertSame([], $import->problems);
        Storage::disk('local')->assertMissing($archivePath);
        $this->assertContains(User::find(1)->username.' chose to overwrite build 5.5.5.', array_column($import->log, 'message'));
        $this->assertSame('Overwrote build 5.5.5 from deceasedcraft.mrpack', ActivityLog::where('action', 'build.imported')->sole()->description);
    }

    public function test_a_downloaded_pack_is_kept_while_waiting_so_it_isnt_downloaded_twice(): void
    {
        Http::fake(['example.com/*' => Http::response($this->pack('5.5.5'))]);

        $this->post('/modpack/import', ['target' => 'existing', 'modpack_id' => $this->modpack->id, 'source' => 'url', 'url' => 'https://example.com/deceasedcraft-5.5.5.mrpack']);

        $import = ModpackImport::sole();
        $this->assertSame(ModpackImport::WAITING, $import->status);
        $this->assertSame('https://example.com/deceasedcraft-5.5.5.mrpack', $import->source);
        $this->assertStringEndsWith('.mrpack', $import->archive_path);
        Storage::disk('local')->assertExists($import->archive_path);

        $this->post(route('modpack.import.show', $import->id), ['action' => 'overwrite']);

        $this->assertSame(ModpackImport::COMPLETED, $import->fresh()->status);
        Http::assertSentCount(1);
    }

    public function test_importing_under_another_version_adds_a_build(): void
    {
        $this->importInto($this->pack('5.5.5'));
        $import = ModpackImport::sole();

        $this->post(route('modpack.import.show', $import->id), ['action' => 'rename', 'version' => '5.5.5'])
            ->assertSessionHasErrors(['version' => 'This modpack already has a build 5.5.5 too.']);
        $this->assertSame(ModpackImport::WAITING, $import->fresh()->status);

        $this->post(route('modpack.import.show', $import->id), ['action' => 'rename', 'version' => '5.5.6']);

        $build = $this->modpack->builds()->where('version', '5.5.6')->sole();
        $this->assertSame(['deceasedcraft-overrides 5.5.6'], $this->buildMods($build));
        $this->assertSame(['old-mod 1.0'], $this->buildMods($this->existingBuild));
        $this->assertSame(ModpackImport::COMPLETED, $import->fresh()->status);
    }

    public function test_cancelling_discards_the_archive(): void
    {
        $this->importInto($this->pack('5.5.5'));
        $import = ModpackImport::sole();
        $archivePath = $import->archive_path;

        $this->post(route('modpack.import.show', $import->id), ['action' => 'cancel'])
            ->assertRedirect(route('modpack.import.show', $import->id))
            ->assertSessionHas('success', 'Import cancelled. Nothing was changed.');

        $this->assertSame(ModpackImport::CANCELLED, $import->fresh()->status);
        Storage::disk('local')->assertMissing($archivePath);
        $this->assertSame(['old-mod 1.0'], $this->buildMods($this->existingBuild));

        $this->post(route('modpack.import.show', $import->id), ['action' => 'overwrite'])
            ->assertSessionHasErrors();
    }

    public function test_abandoned_decisions_are_cancelled_after_a_week(): void
    {
        $this->importInto($this->pack('5.5.5'));
        $import = ModpackImport::sole();
        $archivePath = $import->archive_path;

        $this->travel(ModpackImport::WAITING_DAYS - 1)->days();
        $this->assertSame(0, ModpackImport::cancelAbandoned());

        $this->travel(2)->days();
        $this->assertSame(1, ModpackImport::cancelAbandoned());
        $this->assertSame(ModpackImport::CANCELLED, $import->fresh()->status);
        Storage::disk('local')->assertMissing($archivePath);

        $this->artisan('schedule:list')->expectsOutputToContain('cancel-abandoned-imports')->assertSuccessful();
    }

    public function test_report_lists_problems_and_the_log(): void
    {
        $this->fakeFabricMeta();

        $this->importInto($this->pack('5.6.0', ['minecraft' => '1.20.1', 'fabric-loader' => '9.9.9']));

        $import = ModpackImport::sole();
        $this->assertSame(['Could not find fabric 9.9.9 for Minecraft 1.20.1. Add the mod loader to the build manually.'], $import->problems);
        $this->assertSame('error', collect($import->log)->firstWhere('message', $import->problems[0])['level']);

        $this->get(route('modpack.import.show', $import->id))
            ->assertOk()
            ->assertSee('1 problem')
            ->assertSee('Could not find fabric 9.9.9 for Minecraft 1.20.1')
            ->assertSee('Modrinth pack DeceasedCraft 5.6.0: 0 files for Minecraft 1.20.1, fabric 9.9.9')
            ->assertSee('Only problems (1)');

        $this->get("modpack/view/{$this->modpack->id}")->assertOk()->assertSee('Imports')->assertSee(route('modpack.import.show', $import->id));
    }

    public function test_failed_imports_keep_a_report(): void
    {
        $response = $this->importInto($this->makeArchive(['readme.txt' => 'hi']));

        $response->assertRedirect('modpack/import');
        $import = ModpackImport::sole();
        $this->assertSame(ModpackImport::FAILED, $import->status);
        $this->assertStringContainsString('Unrecognized modpack format', $import->problems[0]);
        $this->assertNull($import->archive_path);

        $this->get('modpack/import')->assertOk()->assertSee('Recent imports')->assertSee('Failed');
        $this->get(route('modpack.import.show', $import->id))->assertOk()->assertSee('Unrecognized modpack format');
    }

    public function test_solder_backups_cannot_be_imported_into_an_existing_modpack(): void
    {
        $this->importInto(json_encode(['format' => PackExportService::BACKUP_FORMAT, 'modpack' => ['name' => 'x'], 'builds' => []]));

        $this->assertStringContainsString('can only be restored as a new modpack', ModpackImport::sole()->problems[0]);
    }

    public function test_importing_into_a_modpack_needs_permission_to_manage_it(): void
    {
        $other = Modpack::create(['name' => 'Other', 'slug' => 'other']);
        $this->be($this->userWithPermissions(['modpacks_manage' => true], [$other->id]));

        $this->get('modpack/import')->assertOk()->assertSee('Other')->assertDontSee('DeceasedCraft');
        $this->importInto($this->pack('5.5.4'))->assertRedirect('dashboard');
        $this->assertSame(0, ModpackImport::count());

        $this->post('/modpack/import', ['target' => 'new', 'name' => 'New', 'slug' => 'new', 'source' => 'url', 'url' => 'https://example.com/pack.mrpack'])
            ->assertRedirect('dashboard');
    }

    public function test_reports_are_only_visible_to_the_importer_and_modpack_managers(): void
    {
        $this->importInto($this->pack('5.5.5'));
        $import = ModpackImport::sole();

        $this->be($this->userWithPermissions(['modpacks_manage' => true]));
        $this->get(route('modpack.import.show', $import->id))->assertRedirect('dashboard');
        $this->post(route('modpack.import.show', $import->id), ['action' => 'cancel'])->assertRedirect('dashboard');
        $this->assertSame(ModpackImport::WAITING, $import->fresh()->status);

        $this->get(route('modpack.import.show', 999))->assertRedirect('modpack/import');
    }
}
