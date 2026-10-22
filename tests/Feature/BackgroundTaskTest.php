<?php

namespace Tests\Feature;

use App\Jobs\ExportBuild;
use App\Jobs\ImportModpack;
use App\Models\Build;
use App\Models\Mod;
use App\Models\Modpack;
use App\Models\ModpackImport;
use App\Models\Modversion;
use App\Models\User;
use App\Models\UserPermission;
use App\Services\TaskTracker;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Storage;
use RuntimeException;
use Tests\FakesModProviders;
use Tests\TestCase;

final class BackgroundTaskTest extends TestCase
{
    use FakesModProviders;
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        $this->seed();
        $this->be(User::find(1));
        $this->setUpModRepository();
        Storage::fake('local');
    }

    private function taskIdFrom(string $location): string
    {
        $this->assertMatchesRegularExpression('#/task/([0-9a-f-]{36})$#', $location);

        return basename($location);
    }

    private function otherUser(): User
    {
        $user = new User;
        $user->forceFill([
            'username' => 'other', 'email' => 'other@example.com', 'password' => 'password',
            'created_ip' => '127.0.0.1', 'created_by_user_id' => 1, 'updated_by_user_id' => 1, 'updated_by_ip' => '127.0.0.1',
        ])->save();
        $permission = new UserPermission;
        $permission->user_id = $user->id;
        $permission->solder_full = true;
        $permission->save();

        return $user->fresh('permission');
    }

    public function test_queued_import_reports_progress_and_links_to_the_modpack(): void
    {
        Queue::fake();

        $pack = $this->makeArchive(['modrinth.index.json' => json_encode([
            'formatVersion' => 1, 'game' => 'minecraft', 'versionId' => '1.0', 'files' => [],
            'dependencies' => ['minecraft' => '1.20.1'],
        ])]);

        $response = $this->post('/modpack/import', [
            'name' => 'Queued Pack',
            'slug' => 'queued-pack',
            'source' => 'file',
            'file' => UploadedFile::fake()->createWithContent('pack.mrpack', $pack),
        ]);

        $taskId = $this->taskIdFrom($response->headers->get('Location'));
        $this->get("/task/$taskId")->assertOk()->assertSee('Importing Queued Pack');
        $this->getJson("/task/$taskId/status")->assertJson(['status' => 'queued']);

        $jobs = Queue::pushed(ImportModpack::class);
        $this->assertCount(1, $jobs);
        $archivePath = ModpackImport::findOrFail($jobs->first()->importId)->archive_path;
        Storage::disk('local')->assertExists($archivePath);
        $jobs->first()->handle();

        $modpack = Modpack::where('slug', 'queued-pack')->firstOrFail();
        $import = ModpackImport::findOrFail($jobs->first()->importId);
        $this->getJson("/task/$taskId/status")->assertJson([
            'status' => 'completed',
            'url' => url("modpack/view/{$modpack->id}"),
            'download' => false,
            'report_url' => route('modpack.import.show', $import->id),
        ]);
        Storage::disk('local')->assertMissing($archivePath);
        $this->assertNull($import->archive_path);
    }

    public function test_queued_export_is_downloadable_by_its_owner_only(): void
    {
        Queue::fake();

        $modpack = Modpack::create(['name' => 'Export Pack', 'slug' => 'export-pack']);
        $build = Build::create(['modpack_id' => $modpack->id, 'version' => '1.0.0', 'minecraft' => '1.20.1']);
        $mod = Mod::create(['name' => 'example', 'pretty_name' => 'Example']);
        $this->putModversionZip('example', '1.0', ['mods/example.jar' => 'jar']);
        $build->modversions()->attach(Modversion::create(['mod_id' => $mod->id, 'version' => '1.0', 'md5' => 'x'])->id);

        $response = $this->get("/modpack/build/{$build->id}/export/technic");
        $taskId = $this->taskIdFrom($response->headers->get('Location'));

        Queue::pushed(ExportBuild::class)->first()->handle();

        $this->getJson("/task/$taskId/status")->assertJson(['status' => 'completed', 'download' => true]);
        $this->get("/task/$taskId/download")->assertDownload('export-pack-1.0.0.zip');

        $this->be($this->otherUser());
        $this->get("/task/$taskId")->assertNotFound();
        $this->get("/task/$taskId/download")->assertNotFound();
    }

    public function test_failed_job_is_reported_on_its_task(): void
    {
        $taskId = TaskTracker::create(1, 'Exporting');

        (new ExportBuild($taskId, 1, 'technic'))->failed(new RuntimeException('Disk full'));

        $this->getJson("/task/$taskId/status")->assertJson([
            'status' => 'failed',
            'errors' => ['The export stopped unexpectedly: Disk full'],
        ]);
    }

    public function test_unknown_task_is_not_found(): void
    {
        $this->get('/task/00000000-0000-0000-0000-000000000000')->assertNotFound();
    }
}
