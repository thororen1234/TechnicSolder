<?php

namespace App\Jobs;

use App\Models\ActivityLog;
use App\Models\Build;
use App\Models\Modpack;
use App\Models\ModpackImport;
use App\Mods\ModProvider;
use App\Services\DiscordNotifier;
use App\Services\PackImportService;
use App\Services\TaskTracker;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Throwable;

/**
 * Run a modpack import in the background, reporting progress to a task and keeping a log on the import.
 *
 * An import into a modpack that already has the build version stops and keeps its archive until someone decides.
 */
class ImportModpack implements ShouldQueue
{
    use Queueable;

    public int $timeout = 3600;

    public int $tries = 1;

    public function __construct(public string $taskId, public int $importId) {}

    public function handle(): void
    {
        $import = ModpackImport::findOrFail($this->importId);
        $import->update(['status' => ModpackImport::RUNNING]);

        if ($import->archive_path === null && ($error = $this->download($import)) !== null) {
            $this->markFailed($import, "Could not download the archive: $error");

            return;
        }

        if (! $import->archiveExists()) {
            $this->markFailed($import, 'The archive is no longer available. Start the import again.');

            return;
        }

        if ($import->slug === null && $import->modpack === null) {
            $this->markFailed($import, 'The modpack this was being imported into has been deleted.');

            return;
        }

        $importer = new PackImportService(
            fn (int $done, int $total, string $message) => TaskTracker::progress($this->taskId, $done, $total, $message),
            fn (string $level, string $message) => $import->addLogEntry($level, $message),
        );
        $path = Storage::disk('local')->path((string) $import->archive_path);

        $result = $import->slug !== null
            ? $importer->importFromPath($path, $import->name, $import->slug)
            : $importer->importIntoModpack($path, $import->modpack, $import->build_version, $import->overwrite);

        if (isset($result['conflict'])) {
            $this->waitForDecision($import, $result['conflict']);

            return;
        }

        $import->deleteArchive();

        if (isset($result['error'])) {
            $this->markFailed($import, $result['error']);

            return;
        }

        $this->complete($import, $result);
    }

    public function failed(?Throwable $exception): void
    {
        $message = 'The import stopped unexpectedly: '.Str::limit((string) $exception?->getMessage(), 300);
        TaskTracker::fail($this->taskId, $message);

        $import = ModpackImport::find($this->importId);
        if ($import !== null && ! $import->isFinished()) {
            $import->deleteArchive();
            $import->update(['status' => ModpackImport::FAILED, 'problems' => [...($import->problems ?? []), $message]]);
            $import->addLogEntry('error', $message);
        }
    }

    /**
     * Download an import from a URL into the local disk, so it can be kept if the import has to wait.
     *
     * @return string|null An error message, or null once downloaded
     */
    private function download(ModpackImport $import): ?string
    {
        $extension = pathinfo((string) parse_url($import->source, PHP_URL_PATH), PATHINFO_EXTENSION);
        $relativePath = 'imports/'.Str::uuid().(preg_match('/^[A-Za-z0-9]{1,8}$/', $extension) ? ".$extension" : '');

        TaskTracker::progress($this->taskId, 0, 0, 'Downloading the archive');
        $import->addLogEntry('info', "Downloading {$import->source}");
        Storage::disk('local')->makeDirectory('imports');

        $error = ModProvider::download($import->source, Storage::disk('local')->path($relativePath));
        if ($error !== null) {
            Storage::disk('local')->delete($relativePath);

            return $error;
        }

        $import->update(['archive_path' => $relativePath]);

        return null;
    }

    private function waitForDecision(ModpackImport $import, string $version): void
    {
        $message = "{$import->modpack->name} already has a build $version.";

        $import->update(['status' => ModpackImport::WAITING, 'build_version' => $version, 'problems' => [$message]]);
        $import->addLogEntry('info', "$message Waiting for a decision: overwrite it, import under another version or cancel.");

        TaskTracker::complete($this->taskId, [
            'url' => route('modpack.import.show', $import->id),
            'label' => 'Choose what to do',
            'message' => $message,
            'redirect' => true,
        ]);
    }

    private function markFailed(ModpackImport $import, string $error): void
    {
        $import->deleteArchive();
        $import->update(['status' => ModpackImport::FAILED, 'problems' => [...($import->problems ?? []), $error]]);
        $import->addLogEntry('error', $error);

        TaskTracker::fail($this->taskId, $error);
        DiscordNotifier::send("Import of {$import->name} failed", $error, route('modpack.import.show', $import->id), DiscordNotifier::DANGER);
    }

    /**
     * @param  array{modpack_id: int, build_id: int, imported: int, skipped: int, errors: list<string>}  $result
     */
    private function complete(ModpackImport $import, array $result): void
    {
        $intoExisting = $import->slug === null;
        $modpack = Modpack::find($result['modpack_id']);
        $build = Build::find($result['build_id']);

        $message = "{$result['imported']} mod(s) imported.";
        if ($result['skipped'] > 0) {
            $message .= " {$result['skipped']} skipped.";
        }

        $import->update([
            'status' => ModpackImport::COMPLETED,
            'modpack_id' => $result['modpack_id'],
            'build_id' => $result['build_id'],
            'imported' => $result['imported'],
            'skipped' => $result['skipped'],
            'problems' => $result['errors'],
        ]);
        $import->addLogEntry('info', 'Finished. '.$message);

        $properties = ['imported' => $result['imported'], 'skipped' => $result['skipped'], 'import_id' => $import->id];
        if ($intoExisting) {
            ActivityLog::record('build.imported', ($import->overwrite ? 'Overwrote' : 'Imported')." build {$build?->version} from {$import->source}", build: $build, userId: $import->user_id, properties: $properties);
        } else {
            $import->user?->permission?->grantModpackAccess($result['modpack_id']);
            ActivityLog::record('modpack.imported', "Imported modpack {$import->name}", $modpack, userId: $import->user_id, properties: $properties);
            Cache::forget('modpacks');
            Cache::forget('allmodpacks');
        }

        $url = $intoExisting ? url("modpack/build/{$result['build_id']}") : url("modpack/view/{$result['modpack_id']}");
        $problems = count($result['errors']);

        DiscordNotifier::send(
            $intoExisting ? "Imported {$modpack?->name} {$build?->version}" : "Imported modpack {$import->name}",
            $message.($problems ? "\n$problems ".Str::plural('problem', $problems).' need attention.' : ''),
            $problems ? route('modpack.import.show', $import->id) : $url,
            $problems ? DiscordNotifier::WARNING : DiscordNotifier::SUCCESS,
        );

        TaskTracker::complete($this->taskId, [
            'url' => $url,
            'label' => $intoExisting ? 'Open build' : 'Open modpack',
            'message' => $message,
            'report_url' => route('modpack.import.show', $import->id),
        ], $result['errors']);
    }
}
