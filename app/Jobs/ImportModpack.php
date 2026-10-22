<?php

namespace App\Jobs;

use App\Models\User;
use App\Services\PackImportService;
use App\Services\TaskTracker;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Str;
use Throwable;

/**
 * Import a modpack archive (uploaded file or URL) in the background, reporting progress to a task.
 */
class ImportModpack implements ShouldQueue
{
    use Queueable;

    public int $timeout = 3600;

    public int $tries = 1;

    /**
     * @param  string|null  $path  Absolute path of an uploaded archive, deleted once imported
     * @param  string|null  $url  URL to download the archive from instead
     */
    public function __construct(
        public string $taskId,
        public int $userId,
        public string $name,
        public string $slug,
        public ?string $path = null,
        public ?string $url = null,
    ) {}

    public function handle(): void
    {
        $importer = new PackImportService(
            fn (int $done, int $total, string $message) => TaskTracker::progress($this->taskId, $done, $total, $message)
        );

        try {
            $result = $this->url !== null
                ? $importer->importFromUrl($this->url, $this->name, $this->slug)
                : $importer->importFromPath((string) $this->path, $this->name, $this->slug);
        } finally {
            if ($this->path !== null && file_exists($this->path)) {
                unlink($this->path);
            }
        }

        if (isset($result['error'])) {
            TaskTracker::fail($this->taskId, $result['error']);

            return;
        }

        User::find($this->userId)?->permission?->grantModpackAccess($result['modpack_id']);
        Cache::forget('modpacks');
        Cache::forget('allmodpacks');

        $message = "{$result['imported']} mod(s) imported.";
        if ($result['skipped'] > 0) {
            $message .= " {$result['skipped']} skipped.";
        }

        TaskTracker::complete($this->taskId, [
            'url' => url("modpack/view/{$result['modpack_id']}"),
            'label' => 'Open modpack',
            'message' => $message,
        ], $result['errors']);
    }

    public function failed(?Throwable $exception): void
    {
        TaskTracker::fail($this->taskId, 'The import stopped unexpectedly: '.Str::limit((string) $exception?->getMessage(), 300));
    }
}
