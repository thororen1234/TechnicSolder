<?php

namespace App\Services;

use App\Models\Build;
use App\Models\Modpack;
use App\Models\Modversion;
use App\Mods\ImportedModData;
use App\Mods\ModProvider;
use App\Mods\ModProviders;
use Closure;
use Illuminate\Support\Facades\Cache;

/**
 * Finds newer versions of a build's mods on the providers they were imported from,
 * and creates new builds with those updates applied.
 *
 * @phpstan-type ModUpdate array{
 *     modversion_id: int,
 *     mod: string,
 *     name: string,
 *     current: string,
 *     latest_key: string,
 *     latest_label: string,
 *     provider: string,
 * }
 */
class BuildUpdateService
{
    private const LOADER_PROVIDERS = ['fabric', 'quilt', 'forge', 'neoforge'];

    private const CACHE_SECONDS = 1800;

    /**
     * @param  (Closure(int $done, int $total, string $message): void)|null  $progress
     */
    public function __construct(private ?Closure $progress = null) {}

    /** Where the latest results of checkAllModpacks() are kept for the dashboard */
    public const SUMMARY_CACHE_KEY = 'solder-update-summary';

    /**
     * Check the latest build of every modpack (the one marked Latest, or else the newest) and remember the results.
     *
     * @return array{checked_at: string, builds: list<array{modpack_id: int, modpack: string, build_id: int, build: string, count: int, mods: list<string>}>}
     */
    public function checkAllModpacks(): array
    {
        $modpacks = Modpack::with('builds')->orderBy('name')->get();
        $builds = [];

        foreach ($modpacks->values() as $index => $modpack) {
            $build = $modpack->builds->firstWhere('version', $modpack->latest) ?? $modpack->builds->sortByDesc('id')->first();
            if ($build === null) {
                continue;
            }

            $this->report($index, $modpacks->count(), "Checking {$modpack->name} {$build->version}");

            try {
                $updates = $this->check($build);
            } catch (\Throwable $e) {
                report($e);

                continue;
            }

            if ($updates !== []) {
                $builds[] = [
                    'modpack_id' => $modpack->id,
                    'modpack' => $modpack->name,
                    'build_id' => $build->id,
                    'build' => $build->version,
                    'count' => count($updates),
                    'mods' => array_column($updates, 'name'),
                ];
            }
        }

        $summary = ['checked_at' => now()->toIso8601String(), 'builds' => $builds];
        Cache::forever(self::SUMMARY_CACHE_KEY, $summary);

        return $summary;
    }

    /**
     * Mods in the build with a newer version available. Mods added by hand (with no provider) are skipped.
     *
     * @return list<ModUpdate>
     */
    public function check(Build $build): array
    {
        $build->loadMissing('modversions.mod');

        $tracked = $build->modversions->filter(fn (Modversion $modversion) => $this->providerFor($modversion) !== null)->values();
        $updates = [];

        foreach ($tracked as $index => $modversion) {
            $this->report($index, $tracked->count(), "Checking {$modversion->mod->pretty_name}");

            $modData = $this->lookup($build, $modversion);
            if ($modData === null) {
                continue;
            }

            $latest = $this->latestFor($build, $modversion, $modData);
            if ($latest === null) {
                continue;
            }

            $updates[] = [
                'modversion_id' => $modversion->id,
                'mod' => $modversion->mod->name,
                'name' => $modversion->mod->pretty_name ?: $modversion->mod->name,
                'current' => $modversion->version,
                'latest_key' => $latest,
                'latest_label' => $modData->versions[$latest]->label ?? $latest,
                'provider' => $this->providerFor($modversion)::name(),
            ];
        }

        return $updates;
    }

    /**
     * Copy the build under a new version and swap in the latest versions of the given mod versions.
     *
     * @param  list<int>  $modversionIds  Mod versions to update; others are copied unchanged
     * @return array{build: Build, updated: int, errors: list<string>}
     */
    public function apply(Build $build, string $newVersion, array $modversionIds): array
    {
        $build->loadMissing('modversions.mod');

        $newBuild = $build->replicate();
        $newBuild->version = $newVersion;
        $newBuild->is_published = false;
        $newBuild->save();

        $ids = $build->modversions->pluck('id')->all();
        $chosen = $build->modversions->whereIn('id', $modversionIds)->values();
        $updated = 0;
        $errors = [];

        foreach ($chosen as $index => $modversion) {
            $this->report($index, $chosen->count(), "Updating {$modversion->mod->pretty_name}");

            $provider = $this->providerFor($modversion);
            $modData = $provider ? $this->lookup($build, $modversion) : null;
            $latest = $modData ? $this->latestFor($build, $modversion, $modData) : null;

            if ($latest === null) {
                continue;
            }

            $result = $provider::install((string) $modversion->provider_project_id, [$latest], $modData);

            if (isset($result->modversionIds[$latest])) {
                $ids[array_search($modversion->id, $ids, true)] = $result->modversionIds[$latest];
                $updated++;
            } else {
                array_push($errors, ...($result->errors ?: ["{$modversion->mod->pretty_name}: update failed"]));
            }
        }

        $newBuild->modversions()->sync(array_values(array_unique($ids)));

        return ['build' => $newBuild, 'updated' => $updated, 'errors' => $errors];
    }

    /**
     * Copy the build to another Minecraft version: the loader and every mod imported from a provider are
     * swapped for their newest version for that Minecraft version. Mods added by hand are copied unchanged,
     * and mods without a compatible version are left out.
     *
     * @return array{build: Build, updated: int, errors: list<string>}
     */
    public function copyToMinecraft(Build $build, string $newVersion, string $minecraft): array
    {
        $build->loadMissing('modversions.mod');

        $newBuild = $build->replicate();
        $newBuild->version = $newVersion;
        $newBuild->minecraft = $minecraft;
        $newBuild->forge = null;
        $newBuild->is_published = false;
        $newBuild->save();

        $loaders = $this->compatibleLoaders($build);
        $ids = [];
        $updated = 0;
        $errors = [];

        foreach ($build->modversions->values() as $index => $modversion) {
            $name = $modversion->mod->pretty_name ?: $modversion->mod->name;
            $this->report($index, $build->modversions->count(), "Finding $name for Minecraft $minecraft");

            $provider = $this->providerFor($modversion);
            if ($provider === null) {
                $ids[] = $modversion->id;
                $errors[] = "$name {$modversion->version} was added by hand, so it was copied unchanged. Check that it works on Minecraft $minecraft.";

                continue;
            }

            $isLoader = $this->isLoader($modversion);
            $projectId = $isLoader ? $minecraft : (string) $modversion->provider_project_id;
            $modData = $provider::modFor($projectId, $isLoader ? '' : $minecraft, $isLoader ? '' : ($loaders[0] ?? ''));
            $latest = $modData
                ? ModProvider::latestStableVersionForGame($modData->versions, $isLoader ? '' : $minecraft, '', $isLoader ? [] : $loaders)
                : null;

            if ($latest === null) {
                $errors[] = "$name has no version for Minecraft $minecraft, so it was left out.";

                continue;
            }

            $result = $provider::install($projectId, [$latest], $modData);
            if (isset($result->modversionIds[$latest])) {
                $ids[] = (int) $result->modversionIds[$latest];
                $updated++;
            } else {
                array_push($errors, ...($result->errors ?: ["$name could not be imported for Minecraft $minecraft."]));
            }
        }

        $newBuild->modversions()->sync(array_values(array_unique($ids)));

        return ['build' => $newBuild, 'updated' => $updated, 'errors' => $errors];
    }

    /**
     * @return class-string<ModProvider>|null
     */
    private function providerFor(Modversion $modversion): ?string
    {
        if (empty($modversion->provider) || empty($modversion->provider_project_id) || empty($modversion->provider_version_id)) {
            return null;
        }

        return ModProviders::providers()[$modversion->provider] ?? null;
    }

    private function isLoader(Modversion $modversion): bool
    {
        return in_array($modversion->provider, self::LOADER_PROVIDERS, true);
    }

    /**
     * Mod loaders whose mods can run in this build. Quilt also runs Fabric mods.
     *
     * @return list<string>
     */
    private function compatibleLoaders(Build $build): array
    {
        return match ($build->loader()['type'] ?? null) {
            null => [],
            'quilt' => ['quilt', 'fabric'],
            default => [$build->loader()['type']],
        };
    }

    private function lookup(Build $build, Modversion $modversion): ?ImportedModData
    {
        $provider = $this->providerFor($modversion);
        $isLoader = $this->isLoader($modversion);
        $minecraft = $isLoader ? '' : (string) $build->minecraft;
        $loader = $isLoader ? '' : ($this->compatibleLoaders($build)[0] ?? '');

        $key = "solder-updates:{$modversion->provider}:{$modversion->provider_project_id}:$minecraft:$loader";

        return Cache::remember($key, self::CACHE_SECONDS, fn () => $provider::modFor((string) $modversion->provider_project_id, $minecraft, $loader));
    }

    /**
     * Key of the newest suitable version if it is newer than the one in the build, otherwise null.
     */
    private function latestFor(Build $build, Modversion $modversion, ImportedModData $modData): ?string
    {
        $isLoader = $this->isLoader($modversion);

        $latest = ModProvider::latestStableVersionForGame(
            $modData->versions,
            $isLoader ? '' : (string) $build->minecraft,
            '',
            $isLoader ? [] : $this->compatibleLoaders($build),
        );

        if ($latest === null || $latest === $modversion->provider_version_id) {
            return null;
        }

        // Versions are listed newest first: never offer something older than what the build has
        $keys = array_map('strval', array_keys($modData->versions));
        $currentPosition = array_search((string) $modversion->provider_version_id, $keys, true);
        $latestPosition = array_search($latest, $keys, true);

        return $currentPosition !== false && $latestPosition > $currentPosition ? null : $latest;
    }

    private function report(int $done, int $total, string $message): void
    {
        if ($this->progress !== null) {
            ($this->progress)($done, $total, $message);
        }
    }
}
