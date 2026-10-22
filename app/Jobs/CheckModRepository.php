<?php

namespace App\Jobs;

use App\Models\Modversion;
use App\Services\DiscordNotifier;
use App\Services\ModRepository;
use App\Services\TaskTracker;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Str;
use Throwable;

/**
 * Compare every mod version's stored checksum and size with the file in the mod repository.
 */
class CheckModRepository implements ShouldQueue
{
    use Queueable;

    public int $timeout = 3600;

    public int $tries = 1;

    public function __construct(public string $taskId) {}

    public function handle(): void
    {
        $total = Modversion::count();
        $problems = [];
        $checked = 0;

        Modversion::with('mod')->orderBy('mod_id')->orderBy('id')->lazy(200)->each(function (Modversion $modversion) use (&$problems, &$checked, $total) {
            if ($checked % 10 === 0) {
                TaskTracker::progress($this->taskId, $checked, $total, "Checking {$modversion->mod->pretty_name} {$modversion->version}");
            }
            $checked++;

            $actual = ModRepository::checksum($modversion);
            $problem = [
                'modversion_id' => $modversion->id,
                'mod_id' => $modversion->mod_id,
                'mod' => $modversion->mod->pretty_name ?: $modversion->mod->name,
                'version' => $modversion->version,
                'path' => $modversion->repositoryPath(),
            ];

            if (! $actual['success']) {
                $problems[] = $problem + ['problem' => 'missing', 'message' => $actual['message']];
            } elseif (strtolower((string) $modversion->md5) !== strtolower($actual['md5'])) {
                $problems[] = $problem + ['problem' => 'changed', 'message' => 'The file differs from the stored checksum'];
            }
        });

        if ($problems !== []) {
            DiscordNotifier::send(
                'Mod repository check found '.count($problems).' '.Str::plural('problem', count($problems)),
                implode("\n", array_map(fn (array $problem) => "{$problem['mod']} {$problem['version']}: {$problem['message']}", array_slice($problems, 0, 15))),
                route('solder.repository', ['task' => $this->taskId]),
                DiscordNotifier::WARNING,
            );
        }

        TaskTracker::complete($this->taskId, [
            'url' => route('solder.repository', ['task' => $this->taskId]),
            'label' => 'View results',
            'message' => $problems === []
                ? "All $checked mod versions match the files in the repository."
                : count($problems)." of $checked mod versions have a problem.",
            'problems' => $problems,
            'checked' => $checked,
        ]);
    }

    public function failed(?Throwable $exception): void
    {
        TaskTracker::fail($this->taskId, 'The check stopped unexpectedly: '.Str::limit((string) $exception?->getMessage(), 300));
    }
}
