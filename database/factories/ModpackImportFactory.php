<?php

namespace Database\Factories;

use App\Models\ModpackImport;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<ModpackImport>
 */
class ModpackImportFactory extends Factory
{
    /**
     * Define the model's default state.
     *
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        $name = fake()->words(2, true);

        return [
            'user_id' => null,
            'modpack_id' => null,
            'build_id' => null,
            'name' => $name,
            'slug' => str($name)->slug()->toString(),
            'source' => 'pack.mrpack',
            'status' => ModpackImport::COMPLETED,
            'imported' => fake()->numberBetween(1, 200),
            'skipped' => 0,
            'problems' => [],
            'log' => [],
        ];
    }

    public function waiting(string $archivePath, string $version): static
    {
        return $this->state(fn () => [
            'status' => ModpackImport::WAITING,
            'archive_path' => $archivePath,
            'slug' => null,
            'problems' => ["This modpack already has a build $version."],
        ]);
    }
}
