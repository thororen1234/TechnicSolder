<?php

namespace App\Jobs;

use App\Models\Build;
use App\Services\PackExportService;
use App\Services\TaskTracker;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Throwable;

/**
 * Export a build in the background. The archive is kept in storage/app/private/exports for a day.
 */
class ExportBuild implements ShouldQueue
{
    use Queueable;

    public const DIRECTORY = 'exports';

    public int $timeout = 3600;

    public int $tries = 1;

    public function __construct(public string $taskId, public int $buildId, public string $format) {}

    public function handle(): void
    {
        $build = Build::with('modpack', 'modversions.mod')->find($this->buildId);
        if ($build === null) {
            TaskTracker::fail($this->taskId, 'The build no longer exists.');

            return;
        }

        static::pruneOldExports();

        $exporter = new PackExportService(
            fn (int $done, int $total, string $message) => TaskTracker::progress($this->taskId, $done, $total, $message)
        );
        $export = $exporter->exportBuild($build, $this->format);

        $disk = Storage::disk('local');
        $disk->makeDirectory(self::DIRECTORY);
        $relative = self::DIRECTORY."/{$this->taskId}";
        File::move($export['path'], $disk->path($relative));

        TaskTracker::complete($this->taskId, [
            'path' => $relative,
            'filename' => $export['filename'],
            'label' => 'Download '.$export['filename'],
            'message' => 'Your export is ready.',
        ], $export['warnings']);
    }

    public function failed(?Throwable $exception): void
    {
        TaskTracker::fail($this->taskId, 'The export stopped unexpectedly: '.Str::limit((string) $exception?->getMessage(), 300));
    }

    /**
     * Delete exports older than a day.
     */
    public static function pruneOldExports(): void
    {
        $disk = Storage::disk('local');

        foreach ($disk->files(self::DIRECTORY) as $file) {
            if ($disk->lastModified($file) < now()->subDay()->getTimestamp()) {
                $disk->delete($file);
            }
        }
    }
}
