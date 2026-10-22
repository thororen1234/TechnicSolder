<?php

namespace App\Services;

use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Str;

/**
 * Progress and results of long-running background tasks (imports, exports, update checks),
 * stored in the cache so the web process can follow a job running in the queue worker.
 *
 * @phpstan-type Task array{
 *     id: string,
 *     user_id: int,
 *     title: string,
 *     status: 'queued'|'running'|'completed'|'failed',
 *     done: int,
 *     total: int,
 *     message: string,
 *     result: array<string, mixed>|null,
 *     errors: list<string>,
 *     updated_at: int,
 * }
 */
final class TaskTracker
{
    private const TTL_SECONDS = 86400;

    public static function create(int $userId, string $title): string
    {
        $id = (string) Str::uuid();

        self::put($id, [
            'id' => $id,
            'user_id' => $userId,
            'title' => $title,
            'status' => 'queued',
            'done' => 0,
            'total' => 0,
            'message' => 'Waiting for a worker…',
            'result' => null,
            'errors' => [],
        ]);

        return $id;
    }

    /**
     * @return Task|null
     */
    public static function get(string $id): ?array
    {
        return Cache::get(self::key($id));
    }

    public static function progress(string $id, int $done, int $total, string $message): void
    {
        self::update($id, ['status' => 'running', 'done' => $done, 'total' => $total, 'message' => $message]);
    }

    /**
     * @param  array<string, mixed>  $result  e.g. ['url' => ..., 'message' => ...] or ['download' => ..., 'filename' => ...]
     * @param  list<string>  $errors  Problems that didn't stop the task
     */
    public static function complete(string $id, array $result, array $errors = []): void
    {
        $task = self::get($id);

        self::update($id, [
            'status' => 'completed',
            'done' => max(1, $task['total'] ?? 1),
            'total' => max(1, $task['total'] ?? 1),
            'message' => $result['message'] ?? 'Done',
            'result' => $result,
            'errors' => $errors,
        ]);
    }

    public static function fail(string $id, string $error): void
    {
        self::update($id, ['status' => 'failed', 'message' => $error, 'errors' => [$error]]);
    }

    /**
     * @param  array<string, mixed>  $changes
     */
    private static function update(string $id, array $changes): void
    {
        $task = self::get($id);
        if ($task === null) {
            return;
        }

        self::put($id, array_merge($task, $changes));
    }

    private static function put(string $id, array $task): void
    {
        Cache::put(self::key($id), array_merge($task, ['updated_at' => time()]), self::TTL_SECONDS);
    }

    private static function key(string $id): string
    {
        return "solder-task:$id";
    }
}
