<?php

namespace App\Http\Controllers;

use App\Jobs\CheckModRepository;
use App\Libraries\MinecraftUtils;
use App\Libraries\UpdateUtils;
use App\Models\ActivityLog;
use App\Models\Modversion;
use App\Services\DiscordNotifier;
use App\Services\ModRepository;
use App\Services\TaskTracker;
use Exception;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\RedirectResponse;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Request;
use Illuminate\Support\Str;
use Illuminate\View\View;

class SolderController extends Controller
{
    public function getConfigure()
    {
        return view('solder.configure');
    }

    public function postTestNotification(): RedirectResponse
    {
        if (! DiscordNotifier::isConfigured()) {
            return redirect('solder/configure')->withErrors(['Set SOLDER_DISCORD_WEBHOOK, or SOLDER_DISCORD_BOT_TOKEN and SOLDER_DISCORD_USER_ID, in your .env file first.']);
        }

        $sent = DiscordNotifier::send('Test message from Technic Solder', 'Notifications are working.', url('dashboard'), DiscordNotifier::SUCCESS);

        return $sent
            ? redirect('solder/configure')->with('success', 'Test message sent to Discord.')
            : redirect('solder/configure')->withErrors(['Discord did not accept the message. Check the webhook URL, bot token and user IDs, and that the bot shares a server with each user; details are in the log.']);
    }

    /**
     * Everything that changed, newest first. Users without full access only see modpacks they can manage.
     */
    public function getActivity(): View
    {
        $permission = Auth::user()->permission;

        $entries = ActivityLog::with('user', 'modpack', 'build')
            ->when(! $permission?->solder_full, fn ($query) => $query->whereIn('modpack_id', $permission->modpacks ?? []))
            ->when(Request::query('modpack'), fn ($query, $modpackId) => $query->where('modpack_id', $modpackId))
            ->latest('id')
            ->paginate(50)
            ->withQueryString();

        return view('solder.activity', ['entries' => $entries]);
    }

    /**
     * Mod repository check: results of a previous run (?task=...) or a button to start one.
     */
    public function getRepository(): View
    {
        $this->authorize('update', Modversion::class);

        $task = Request::query('task') ? TaskTracker::get((string) Request::query('task')) : null;
        if ($task !== null && $task['user_id'] !== Auth::id()) {
            $task = null;
        }

        return view('solder.repository', [
            'task' => $task,
            'isRemote' => ModRepository::isRemote(),
            'location' => config('solder.repo_location'),
            'modversionCount' => Modversion::count(),
        ]);
    }

    public function postRepository(): RedirectResponse
    {
        $this->authorize('update', Modversion::class);

        $taskId = TaskTracker::create(Auth::id(), 'Checking the mod repository');

        try {
            dispatch(new CheckModRepository($taskId));
        } catch (\Throwable $e) {
            report($e);
        }

        return TaskTracker::get($taskId)['status'] === 'completed'
            ? redirect()->route('solder.repository', ['task' => $taskId])
            : redirect()->route('task.show', $taskId);
    }

    /**
     * Store the current checksum and size of files that changed on purpose.
     */
    public function postRepositoryFix(): RedirectResponse
    {
        $this->authorize('update', Modversion::class);

        $updated = 0;
        $errors = [];

        foreach (Modversion::with('mod')->whereIn('id', (array) Request::input('modversions', []))->get() as $modversion) {
            $actual = ModRepository::checksum($modversion);

            if (! $actual['success']) {
                $errors[] = "{$modversion->mod->name} {$modversion->version}: {$actual['message']}";

                continue;
            }

            $modversion->update(['md5' => $actual['md5'], 'filesize' => $actual['filesize']]);
            $updated++;
        }

        $redirect = redirect()->route('solder.repository', array_filter(['task' => Request::input('task')]))
            ->with('success', "Updated the stored checksum of $updated mod ".Str::plural('version', $updated).'.');

        return empty($errors) ? $redirect : $redirect->withErrors($errors);
    }

    public function getUpdate(): View
    {
        $rawChangeLog = UpdateUtils::getLatestChangeLog();
        $changelog = array_key_exists('error', $rawChangeLog) ? $rawChangeLog : array_slice($rawChangeLog, 0, 10);
        $latestCommit = array_key_exists('error', $rawChangeLog) ? $rawChangeLog : $rawChangeLog[0];

        $rawLatestVersion = UpdateUtils::getLatestVersion();
        $latestVersion = array_key_exists('error', $rawLatestVersion) ? $rawLatestVersion : $rawLatestVersion['name'];

        $latestData = [
            'version' => $latestVersion,
            'commit' => $latestCommit,
        ];

        return view('solder.update')->with('changelog', $changelog)->with('currentVersion', SOLDER_VERSION)->with('latestData', $latestData);
    }

    public function getUpdateCheck(): JsonResponse
    {
        if (! Request::ajax()) {
            abort(404);
        }

        if (UpdateUtils::getUpdateCheck(true)) {
            Cache::put('update', true, now()->addMinutes(60));

            return response()->json([
                'success' => true,
                'update' => true,
            ]);
        } else {
            if (Cache::has('update')) {
                Cache::forget('update');
            }

            return response()->json([
                'success' => true,
                'update' => false,
            ]);
        }
    }

    public function getCacheMinecraft(): JsonResponse
    {
        if (! Request::ajax()) {
            abort(404);
        }

        try {
            $versions = MinecraftUtils::getMinecraftVersions(true);
        } catch (Exception $e) {
            return response()->json([
                'success' => false,
                'message' => $e->getMessage(),
            ]);
        }

        // Sanity check in case the refetch fails
        if (empty($versions)) {
            return response()->json([
                'success' => false,
                'message' => 'Fetch failed, check the Solder logs',
            ]);
        }

        return response()->json([
            'success' => true,
        ]);
    }
}
