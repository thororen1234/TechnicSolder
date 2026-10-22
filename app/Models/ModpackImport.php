<?php

namespace App\Models;

use Database\Factories\ModpackImportFactory;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Storage;

/**
 * One modpack import: where it came from, what it went into, the problems it hit and a log of what it did.
 *
 * An import into an existing modpack that already has the build version stops as "waiting" and keeps its archive
 * until someone overwrites the build, imports it under another version or cancels. Like activity logs, imports
 * keep their history after the modpack or build is deleted, so the IDs are not foreign keys.
 *
 * @property int $id
 * @property int|null $user_id
 * @property int|null $modpack_id The modpack imported into, or created by the import
 * @property int|null $build_id
 * @property string $name
 * @property string|null $slug Slug for a new modpack; null when importing into an existing one
 * @property string $source The uploaded file's name or the URL
 * @property string|null $archive_path Path of the archive on the local disk, kept until the import is done
 * @property string|null $build_version Build version to use instead of the one in the archive
 * @property bool $overwrite Whether to replace an existing build with the same version
 * @property string $status
 * @property int $imported
 * @property int $skipped
 * @property list<string>|null $problems
 * @property list<array{time: string, level: 'info'|'error', message: string}>|null $log
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property-read User|null $user
 * @property-read Modpack|null $modpack
 * @property-read Build|null $build
 */
class ModpackImport extends Model
{
    /** @use HasFactory<ModpackImportFactory> */
    use HasFactory;

    public const QUEUED = 'queued';

    public const RUNNING = 'running';

    public const WAITING = 'waiting';

    public const COMPLETED = 'completed';

    public const FAILED = 'failed';

    public const CANCELLED = 'cancelled';

    /** Imports waiting for a decision are cancelled, and their archives deleted, after this many days */
    public const WAITING_DAYS = 7;

    protected $fillable = [
        'user_id',
        'modpack_id',
        'build_id',
        'name',
        'slug',
        'source',
        'archive_path',
        'build_version',
        'overwrite',
        'status',
        'imported',
        'skipped',
        'problems',
        'log',
    ];

    protected function casts(): array
    {
        return [
            'overwrite' => 'boolean',
            'problems' => 'array',
            'log' => 'array',
        ];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    public function modpack(): BelongsTo
    {
        return $this->belongsTo(Modpack::class);
    }

    public function build(): BelongsTo
    {
        return $this->belongsTo(Build::class);
    }

    /**
     * @param  'info'|'error'  $level
     */
    public function addLogEntry(string $level, string $message): void
    {
        $this->log = [...($this->log ?? []), ['time' => now()->toIso8601String(), 'level' => $level, 'message' => $message]];
        $this->save();
    }

    public function isFinished(): bool
    {
        return in_array($this->status, [self::COMPLETED, self::FAILED, self::CANCELLED], true);
    }

    public function archiveExists(): bool
    {
        return $this->archive_path !== null && Storage::disk('local')->exists($this->archive_path);
    }

    public function deleteArchive(): void
    {
        if ($this->archive_path !== null) {
            Storage::disk('local')->delete($this->archive_path);
            $this->archive_path = null;
            $this->save();
        }
    }

    /**
     * Cancel imports nobody decided on within WAITING_DAYS, freeing their archives.
     *
     * @return int How many were cancelled
     */
    public static function cancelAbandoned(): int
    {
        $abandoned = self::where('status', self::WAITING)->where('updated_at', '<', now()->subDays(self::WAITING_DAYS))->get();

        foreach ($abandoned as $import) {
            $import->deleteArchive();
            $import->status = self::CANCELLED;
            $import->addLogEntry('info', 'Cancelled after waiting '.self::WAITING_DAYS.' days for a decision.');
        }

        return $abandoned->count();
    }
}
