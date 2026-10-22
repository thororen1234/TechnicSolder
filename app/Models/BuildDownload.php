<?php

namespace App\Models;

use Database\Factories\BuildDownloadFactory;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * How many times the launcher fetched a build on a given day (GET /api/modpack/{slug}/{version}).
 *
 * @property int $id
 * @property int $build_id
 * @property Carbon $date
 * @property int $count
 */
class BuildDownload extends Model
{
    /** @use HasFactory<BuildDownloadFactory> */
    use HasFactory;

    public $timestamps = false;

    protected $fillable = [
        'build_id',
        'date',
        'count',
    ];

    protected function casts(): array
    {
        return [
            'date' => 'date',
        ];
    }

    /**
     * Count one launcher request for a build today, in a single query.
     */
    public static function record(int $buildId): void
    {
        DB::table('build_downloads')->upsert(
            [['build_id' => $buildId, 'date' => now()->toDateString(), 'count' => 1]],
            ['build_id', 'date'],
            ['count' => DB::raw('build_downloads.count + 1')],
        );
    }

    /**
     * Total requests per build over the last $days days.
     *
     * @param  list<int>  $buildIds
     * @return array<int, int> build ID => count
     */
    public static function totals(array $buildIds, int $days = 30): array
    {
        return self::whereIn('build_id', $buildIds)
            ->where('date', '>', now()->subDays($days)->toDateString())
            ->groupBy('build_id')
            ->selectRaw('build_id, SUM(count) as total')
            ->pluck('total', 'build_id')
            ->map(fn ($total) => (int) $total)
            ->all();
    }

    /**
     * Requests per day for one build over the last $days days, oldest first, including empty days.
     *
     * @return array<string, int> Y-m-d => count
     */
    public static function daily(int $buildId, int $days = 30): array
    {
        $counts = self::where('build_id', $buildId)
            ->where('date', '>', now()->subDays($days)->toDateString())
            ->pluck('count', 'date')
            ->mapWithKeys(fn ($count, $date) => [Carbon::parse($date)->toDateString() => (int) $count]);

        $series = [];
        for ($day = $days - 1; $day >= 0; $day--) {
            $date = now()->subDays($day)->toDateString();
            $series[$date] = $counts[$date] ?? 0;
        }

        return $series;
    }
}
