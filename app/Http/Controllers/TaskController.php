<?php

namespace App\Http\Controllers;

use App\Services\TaskTracker;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Storage;
use Illuminate\View\View;
use Symfony\Component\HttpFoundation\BinaryFileResponse;

/**
 * Progress pages for background tasks. Tasks are only visible to the user who started them.
 */
class TaskController extends Controller
{
    public function show(string $taskId): View
    {
        return view('task.show', ['task' => $this->findTask($taskId)]);
    }

    public function status(string $taskId): JsonResponse
    {
        $task = $this->findTask($taskId);

        return response()->json([
            'status' => $task['status'],
            'done' => $task['done'],
            'total' => $task['total'],
            'message' => $task['message'],
            'errors' => $task['errors'],
            'url' => $task['result']['url'] ?? (isset($task['result']['path']) ? route('task.download', $taskId) : null),
            'label' => $task['result']['label'] ?? null,
            'download' => isset($task['result']['path']),
        ]);
    }

    public function download(string $taskId): BinaryFileResponse
    {
        $task = $this->findTask($taskId);
        $path = $task['result']['path'] ?? null;

        abort_if($path === null || ! Storage::disk('local')->exists($path), 404, 'This export has expired. Export the build again.');

        return response()->download(Storage::disk('local')->path($path), $task['result']['filename']);
    }

    /**
     * @return array<string, mixed>
     */
    private function findTask(string $taskId): array
    {
        $task = TaskTracker::get($taskId);

        abort_if($task === null || $task['user_id'] !== Auth::id(), 404);

        return $task;
    }
}
