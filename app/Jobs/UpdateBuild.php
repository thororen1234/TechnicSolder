<?php

namespace App\Jobs;

use App\Models\Build;
use App\Services\BuildUpdateService;
use App\Services\TaskTracker;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Str;
use Throwable;

/**
 * Create a new build with the chosen mod updates applied, in the background.
 */
class UpdateBuild implements ShouldQueue
{
    use Queueable;

    public int $timeout = 3600;

    public int $tries = 1;

    /**
     * @param  list<int>  $modversionIds
     */
    public function __construct(
        public string $taskId,
        public int $buildId,
        public string $newVersion,
        public array $modversionIds,
    ) {}

    public function handle(): void
    {
        $build = Build::find($this->buildId);
        if ($build === null) {
            TaskTracker::fail($this->taskId, 'The build no longer exists.');

            return;
        }

        $service = new BuildUpdateService(
            fn (int $done, int $total, string $message) => TaskTracker::progress($this->taskId, $done, $total, $message)
        );
        $result = $service->apply($build, $this->newVersion, $this->modversionIds);

        TaskTracker::complete($this->taskId, [
            'url' => url('modpack/build/'.$result['build']->id),
            'label' => "Open build {$result['build']->version}",
            'message' => "Build {$result['build']->version} created with {$result['updated']} ".Str::plural('update', $result['updated']).'.',
        ], $result['errors']);
    }

    public function failed(?Throwable $exception): void
    {
        TaskTracker::fail($this->taskId, 'The update stopped unexpectedly: '.Str::limit((string) $exception?->getMessage(), 300));
    }
}
