<?php

namespace App\Console\Commands;

use App\Jobs\CheckAllBuildUpdates;
use Illuminate\Console\Command;

class CheckBuildUpdates extends Command
{
    protected $signature = 'solder:check-updates';

    protected $description = 'Check the latest build of every modpack for mod updates and post the results to Discord';

    public function handle(): int
    {
        $summary = (new CheckAllBuildUpdates)->handle();

        if ($summary['builds'] === []) {
            $this->info('Every modpack is up to date.');

            return self::SUCCESS;
        }

        $this->table(
            ['Modpack', 'Build', 'Updates', 'Mods'],
            array_map(fn (array $build) => [$build['modpack'], $build['build'], $build['count'], implode(', ', $build['mods'])], $summary['builds'])
        );

        return self::SUCCESS;
    }
}
