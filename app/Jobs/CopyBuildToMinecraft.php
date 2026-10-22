<?php

namespace App\Jobs;

use App\Models\ActivityLog;
use App\Models\Build;
use App\Services\BuildUpdateService;
use App\Services\TaskTracker;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Str;
use Throwable;

/**
 * Copy a build to another Minecraft version in the background.
 */
class CopyBuildToMinecraft implements ShouldQueue
{
    use Queueable;

    public int $timeout = 3600;

    public int $tries = 1;

    public function __construct(
        public string $taskId,
        public int $buildId,
        public string $newVersion,
        public string $minecraft,
        public ?int $userId = null,
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
        $result = $service->copyToMinecraft($build, $this->newVersion, $this->minecraft);

        ActivityLog::record(
            'build.created',
            "Created build {$result['build']->version} for Minecraft {$this->minecraft} from build {$build->version}",
            build: $result['build'],
            userId: $this->userId,
        );

        TaskTracker::complete($this->taskId, [
            'url' => url('modpack/build/'.$result['build']->id),
            'label' => "Open build {$result['build']->version}",
            'message' => "Build {$result['build']->version} for Minecraft {$this->minecraft} created; {$result['updated']} ".Str::plural('mod', $result['updated']).' moved to a compatible version.',
        ], $result['errors']);
    }

    public function failed(?Throwable $exception): void
    {
        TaskTracker::fail($this->taskId, 'The copy stopped unexpectedly: '.Str::limit((string) $exception?->getMessage(), 300));
    }
}
