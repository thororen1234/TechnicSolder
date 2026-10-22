<?php

namespace App\Models;

use Database\Factories\ActivityLogFactory;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Auth;

/**
 * A record of a change to a modpack or build: who did what, and when.
 *
 * Modpacks and builds keep their history after being deleted, so the IDs are not foreign keys.
 *
 * @property int $id
 * @property int|null $user_id
 * @property int|null $modpack_id
 * @property int|null $build_id
 * @property string $action e.g. "build.mod_added"
 * @property string $description
 * @property array<string, mixed>|null $properties
 * @property Carbon $created_at
 * @property-read User|null $user
 * @property-read Modpack|null $modpack
 * @property-read Build|null $build
 */
class ActivityLog extends Model
{
    /** @use HasFactory<ActivityLogFactory> */
    use HasFactory;

    public const UPDATED_AT = null;

    protected $fillable = [
        'user_id',
        'modpack_id',
        'build_id',
        'action',
        'description',
        'properties',
    ];

    protected function casts(): array
    {
        return [
            'properties' => 'array',
        ];
    }

    /**
     * Record a change. The acting user defaults to whoever is signed in (web session or API token).
     *
     * @param  array<string, mixed>  $properties
     */
    public static function record(
        string $action,
        string $description,
        ?Modpack $modpack = null,
        ?Build $build = null,
        array $properties = [],
        ?int $userId = null,
    ): self {
        return self::create([
            'user_id' => $userId ?? Auth::id() ?? Auth::guard('sanctum')->id(),
            'modpack_id' => $modpack?->id ?? $build?->modpack_id,
            'build_id' => $build?->id,
            'action' => $action,
            'description' => $description,
            'properties' => $properties ?: null,
        ]);
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
}
