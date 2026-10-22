<?php

namespace App\Http\Controllers;

use App\Jobs\CheckAllBuildUpdates;
use App\Libraries\UpdateUtils;
use App\Models\Build;
use App\Models\Modversion;
use App\Services\BuildUpdateService;
use App\Services\TaskTracker;
use Illuminate\Http\RedirectResponse;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Cache;
use Illuminate\View\View;

class DashboardController extends Controller
{
    public function getIndex(): View
    {
        $perm = Auth::user()->permission;

        $builds = Build::with('modpack')
            ->withCount('modversions')
            ->where('is_published', '=', '1')
            ->when(! $perm->solder_full, fn ($q) => $q->whereHas('modpack', fn ($q) => $q->whereIn('id', $perm->modpacks)
            ))
            ->orderBy('updated_at', 'desc')
            ->take(5)
            ->get();

        $modversions = Modversion::with('mod')
            ->whereNotNull('md5')
            ->orderBy('updated_at', 'desc')
            ->take(5)
            ->get();

        $unusedModversions = Modversion::with('mod')
            ->doesntHave('builds')
            ->orderBy('created_at', 'desc')
            ->limit(20)
            ->get();

        $rawChangeLog = UpdateUtils::getLatestChangeLog();
        $changelogJson = array_key_exists('error', $rawChangeLog) ? $rawChangeLog : array_slice($rawChangeLog, 0, 10);

        // Results of the last update check, limited to the modpacks this user manages
        $updateSummary = Cache::get(BuildUpdateService::SUMMARY_CACHE_KEY);
        if ($updateSummary !== null && ! $perm->solder_full) {
            $updateSummary['builds'] = array_values(array_filter(
                $updateSummary['builds'],
                fn (array $build) => $perm->canAccessModpack($build['modpack_id'])
            ));
        }

        return view('dashboard.index')
            ->with('modversions', $modversions)
            ->with('builds', $builds)
            ->with('unusedModversions', $unusedModversions)
            ->with('changelog', $changelogJson)
            ->with('updateSummary', $updateSummary);
    }

    /**
     * Run the update check for every modpack now instead of waiting for the nightly run.
     */
    public function postCheckUpdates(): RedirectResponse
    {
        $taskId = TaskTracker::create(Auth::id(), 'Checking every modpack for mod updates');

        try {
            dispatch(new CheckAllBuildUpdates($taskId));
        } catch (\Throwable $e) {
            report($e);
        }

        return TaskTracker::get($taskId)['status'] === 'completed'
            ? redirect('dashboard')->with('success', TaskTracker::get($taskId)['result']['message'])
            : redirect()->route('task.show', $taskId);
    }
}
