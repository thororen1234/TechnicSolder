<?php

namespace App\Jobs;

use App\Services\BuildUpdateService;
use App\Services\DiscordNotifier;
use App\Services\TaskTracker;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Str;
use Throwable;

/**
 * Check every modpack's latest build for updates, show the results on the dashboard and post them to Discord.
 */
class CheckAllBuildUpdates implements ShouldQueue
{
    use Queueable;

    public int $timeout = 3600;

    public int $tries = 1;

    /**
     * @param  string|null  $taskId  Task to report progress to, when started from the dashboard
     */
    public function __construct(public ?string $taskId = null) {}

    /**
     * @return array{checked_at: string, builds: list<array{modpack_id: int, modpack: string, build_id: int, build: string, count: int, mods: list<string>}>}
     */
    public function handle(): array
    {
        $service = new BuildUpdateService($this->taskId === null ? null
            : fn (int $done, int $total, string $message) => TaskTracker::progress($this->taskId, $done, $total, $message));

        $summary = $service->checkAllModpacks();

        if ($summary['builds'] !== []) {
            $lines = array_map(fn (array $build) => "**{$build['modpack']}** {$build['build']}: {$build['count']} "
                .Str::plural('update', $build['count']).' ('.Str::limit(implode(', ', $build['mods']), 120).')', $summary['builds']);

            DiscordNotifier::send(
                'Mod updates available for '.count($summary['builds']).' '.Str::plural('modpack', count($summary['builds'])),
                implode("\n", $lines),
                url('dashboard'),
                DiscordNotifier::WARNING,
            );
        }

        if ($this->taskId !== null) {
            $count = count($summary['builds']);
            TaskTracker::complete($this->taskId, [
                'url' => url('dashboard'),
                'label' => 'Back to the overview',
                'message' => $count === 0 ? 'Every modpack is up to date.' : "$count ".Str::plural('modpack', $count).($count === 1 ? ' has' : ' have').' updates available.',
            ]);
        }

        return $summary;
    }

    public function failed(?Throwable $exception): void
    {
        if ($this->taskId !== null) {
            TaskTracker::fail($this->taskId, 'The update check stopped unexpectedly: '.Str::limit((string) $exception?->getMessage(), 300));
        }
    }
}
