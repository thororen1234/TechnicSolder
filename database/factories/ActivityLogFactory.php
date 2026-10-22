<?php

namespace Database\Factories;

use App\Models\ActivityLog;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<ActivityLog>
 */
class ActivityLogFactory extends Factory
{
    /**
     * Define the model's default state.
     *
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'user_id' => null,
            'modpack_id' => null,
            'build_id' => null,
            'action' => 'build.mod_added',
            'description' => 'Added '.fake()->word().' '.fake()->semver(),
            'properties' => null,
        ];
    }
}
