<?php

namespace Database\Factories;

use App\Models\BuildDownload;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<BuildDownload>
 */
class BuildDownloadFactory extends Factory
{
    /**
     * Define the model's default state.
     *
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'build_id' => 1,
            'date' => fake()->dateTimeBetween('-29 days')->format('Y-m-d'),
            'count' => fake()->numberBetween(1, 500),
        ];
    }
}
