<?php

namespace Tests\Feature;

use App\Models\Build;
use App\Models\Mod;
use App\Models\Modpack;
use App\Models\Modversion;
use App\Models\User;
use App\Models\UserPermission;
use App\Services\BuildUpdateService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Tests\FakesModProviders;
use Tests\TestCase;

final class NotificationTest extends TestCase
{
    use FakesModProviders;
    use RefreshDatabase;

    private const WEBHOOK = 'https://discord.test/api/webhooks/1/abc';

    private Modpack $modpack;

    private Build $build;

    protected function setUp(): void
    {
        parent::setUp();

        $this->seed();
        $this->be(User::find(1));
        $this->setUpModRepository();
        config(['solder.discord_webhook' => self::WEBHOOK]);

        $this->modpack = Modpack::create(['name' => 'Watched Pack', 'slug' => 'watched-pack', 'latest' => '1.0']);
        $this->build = Build::create(['modpack_id' => $this->modpack->id, 'version' => '1.0', 'minecraft' => '1.20.1']);
        $mod = Mod::create(['name' => 'sodium', 'pretty_name' => 'Sodium']);
        $this->build->modversions()->attach(Modversion::create([
            'mod_id' => $mod->id, 'version' => '0.5.0', 'md5' => 'x',
            'provider' => 'modrinth', 'provider_project_id' => 'AANobbMI', 'provider_version_id' => 'v1',
        ])->id);
    }

    private function fakeSodium(array $versions): void
    {
        Http::fake([
            'discord.test/*' => Http::response(null, 204),
            'api.modrinth.com/v2/project/AANobbMI' => Http::response(['id' => 'AANobbMI', 'slug' => 'sodium', 'title' => 'Sodium']),
            'api.modrinth.com/v2/project/AANobbMI/members' => Http::response([]),
            'api.modrinth.com/v2/project/AANobbMI/version*' => Http::response(array_map(fn ($id) => [
                'id' => $id, 'version_number' => $id, 'version_type' => 'release', 'game_versions' => ['1.20.1'], 'loaders' => ['fabric'],
                'files' => [['url' => "https://cdn.modrinth.com/$id.jar", 'filename' => 'sodium.jar', 'primary' => true]],
            ], $versions)),
        ]);
    }

    private function discordMessages(): array
    {
        return Http::recorded(fn (Request $request) => $request->url() === self::WEBHOOK)
            ->map(fn ($pair) => $pair[0]['embeds'][0]['title'])
            ->values()
            ->all();
    }

    public function test_update_check_posts_outdated_modpacks_and_feeds_the_dashboard(): void
    {
        $this->fakeSodium(['v2', 'v1']);

        $this->artisan('solder:check-updates')->assertSuccessful();

        $this->assertSame(['Mod updates available for 1 modpack'], $this->discordMessages());
        $summary = Cache::get(BuildUpdateService::SUMMARY_CACHE_KEY);
        $this->assertSame([['modpack_id' => $this->modpack->id, 'modpack' => 'Watched Pack', 'build_id' => $this->build->id, 'build' => '1.0', 'count' => 1, 'mods' => ['Sodium']]], $summary['builds']);

        $this->get('/dashboard')->assertOk()->assertSee('1 modpack has mod updates')->assertSee('Watched Pack');
    }

    public function test_up_to_date_modpacks_send_nothing(): void
    {
        $this->fakeSodium(['v1']);

        $this->artisan('solder:check-updates')->expectsOutput('Every modpack is up to date.')->assertSuccessful();

        $this->assertSame([], $this->discordMessages());
        $this->get('/dashboard')->assertSee('Every modpack is up to date');
    }

    public function test_nothing_is_posted_without_a_webhook(): void
    {
        config(['solder.discord_webhook' => null]);
        $this->fakeSodium(['v2', 'v1']);

        $this->artisan('solder:check-updates')->assertSuccessful();

        Http::assertNotSent(fn (Request $request) => str_contains($request->url(), 'discord'));
    }

    public function test_dashboard_only_lists_modpacks_the_user_manages(): void
    {
        Cache::forever(BuildUpdateService::SUMMARY_CACHE_KEY, ['checked_at' => now()->toIso8601String(), 'builds' => [
            ['modpack_id' => $this->modpack->id, 'modpack' => 'Watched Pack', 'build_id' => $this->build->id, 'build' => '1.0', 'count' => 1, 'mods' => ['Sodium']],
            ['modpack_id' => 999, 'modpack' => 'Secret Pack', 'build_id' => 999, 'build' => '1.0', 'count' => 2, 'mods' => ['Iris']],
        ]]);
        $user = new User;
        $user->forceFill([
            'username' => 'packdev', 'email' => 'packdev@example.com', 'password' => 'password',
            'created_ip' => '127.0.0.1', 'created_by_user_id' => 1, 'updated_by_user_id' => 1, 'updated_by_ip' => '127.0.0.1',
        ])->save();
        $permission = new UserPermission;
        $permission->user_id = $user->id;
        $permission->modpacks = [$this->modpack->id];
        $permission->save();
        $this->be($user->fresh('permission'));

        $this->get('/dashboard')->assertOk()->assertSee('Watched Pack')->assertDontSee('Secret Pack');
    }

    public function test_check_now_runs_the_check_straight_away(): void
    {
        $this->fakeSodium(['v2', 'v1']);

        $this->post('/dashboard/check-updates')
            ->assertRedirect('dashboard')
            ->assertSessionHas('success', '1 modpack has updates available.');
    }

    public function test_publishing_a_build_is_announced(): void
    {
        Http::fake(['discord.test/*' => Http::response(null, 204)]);

        $this->post('/modpack/modify/published', ['build' => $this->build->id, 'published' => 1, 'force' => 1], ['X-Requested-With' => 'XMLHttpRequest'])->assertOk();

        $this->assertSame(['Watched Pack 1.0 published'], $this->discordMessages());
    }

    public function test_test_message_button(): void
    {
        Http::fake(['discord.test/*' => Http::response(null, 204)]);

        $this->post('/solder/notifications/test')->assertRedirect('solder/configure')->assertSessionHas('success', 'Test message sent to Discord.');
        $this->assertSame(['Test message from Technic Solder'], $this->discordMessages());

        config(['solder.discord_webhook' => null]);
        $this->post('/solder/notifications/test')->assertSessionHasErrors();
    }

    public function test_nightly_check_is_scheduled(): void
    {
        $this->artisan('schedule:list')->expectsOutputToContain('solder:check-updates')->assertSuccessful();
    }
}
