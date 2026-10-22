<?php

namespace Tests\Feature;

use App\Models\Build;
use App\Models\BuildDownload;
use App\Models\Modpack;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

final class BuildDownloadTest extends TestCase
{
    use RefreshDatabase;

    private Modpack $modpack;

    private Build $build;

    protected function setUp(): void
    {
        parent::setUp();

        $this->seed();

        $this->modpack = Modpack::create(['name' => 'Popular Pack', 'slug' => 'popular-pack']);
        $this->build = Build::create(['modpack_id' => $this->modpack->id, 'version' => '1.0', 'minecraft' => '1.20.1', 'is_published' => true]);
    }

    public function test_launcher_requests_are_counted_per_day(): void
    {
        $this->getJson('api/modpack/popular-pack/1.0')->assertOk();
        $this->getJson('api/modpack/popular-pack/1.0')->assertOk();

        $this->assertSame(2, BuildDownload::where('build_id', $this->build->id)->whereDate('date', today())->value('count'));

        $this->travel(1)->day();
        $this->getJson('api/modpack/popular-pack/1.0')->assertOk();

        $this->assertSame([$this->build->id => 3], BuildDownload::totals([$this->build->id]));
        $daily = BuildDownload::daily($this->build->id);
        $this->assertCount(30, $daily);
        $this->assertSame([2, 1], array_slice(array_values($daily), -2));
    }

    public function test_requests_for_hidden_builds_are_not_counted(): void
    {
        $this->build->update(['is_published' => false]);

        $this->getJson('api/modpack/popular-pack/1.0')->assertNotFound();

        $this->assertSame(0, BuildDownload::count());
    }

    public function test_old_requests_drop_out_of_the_totals(): void
    {
        BuildDownload::create(['build_id' => $this->build->id, 'date' => now()->subDays(40)->toDateString(), 'count' => 99]);
        BuildDownload::create(['build_id' => $this->build->id, 'date' => now()->subDays(3)->toDateString(), 'count' => 5]);

        $this->assertSame([$this->build->id => 5], BuildDownload::totals([$this->build->id]));
    }

    public function test_modpack_and_build_pages_show_launches(): void
    {
        BuildDownload::create(['build_id' => $this->build->id, 'date' => today()->toDateString(), 'count' => 1234]);
        $this->be(User::find(1));

        $this->get("/modpack/view/{$this->modpack->id}")->assertOk()->assertSee('Launches (30 days)')->assertSee('1,234');
        $this->get("/modpack/build/{$this->build->id}")->assertOk()->assertSee('1,234</span> in the last 30 days', false);
    }
}
