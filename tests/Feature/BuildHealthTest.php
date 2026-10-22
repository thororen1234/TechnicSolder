<?php

namespace Tests\Feature;

use App\Models\Build;
use App\Models\Mod;
use App\Models\Modpack;
use App\Models\Modversion;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\FakesModProviders;
use Tests\TestCase;

final class BuildHealthTest extends TestCase
{
    use FakesModProviders;
    use RefreshDatabase;

    private Build $build;

    protected function setUp(): void
    {
        parent::setUp();

        $this->seed();
        $this->be(User::find(1));
        $this->setUpModRepository();

        $modpack = Modpack::create(['name' => 'Health Pack', 'slug' => 'health-pack']);
        $this->build = Build::create(['modpack_id' => $modpack->id, 'version' => '1.0', 'minecraft' => '1.20.1']);
    }

    /**
     * @param  array<string, string>  $files
     */
    private function add(string $modName, string $version, array $files, bool $storeFile = true): void
    {
        $mod = Mod::firstOrCreate(['name' => $modName], ['pretty_name' => ucfirst($modName)]);
        if ($storeFile) {
            $this->putModversionZip($modName, $version, $files);
        }
        $modversion = Modversion::create(['mod_id' => $mod->id, 'version' => $version, 'md5' => md5($modName.$version)]);
        $this->build->modversions()->attach($modversion->id);
    }

    private function fabricJar(string $id, array $depends = [], array $extra = [], array $files = []): string
    {
        return $this->makeArchive([
            'fabric.mod.json' => json_encode(['id' => $id, 'version' => '1.0', 'depends' => (object) $depends] + $extra),
        ] + $files);
    }

    private function messages(): array
    {
        $response = $this->getJson("/modpack/build/{$this->build->id}/health");
        $response->assertOk();

        return array_map(fn ($issue) => "{$issue['severity']}: {$issue['message']}", $response->json('issues'));
    }

    private function addHealthyFabricBase(): void
    {
        $this->add('fabric-loader', '1.20.1-0.14.9', ['bin/version.json' => '{}']);
        $this->add('fabric-api', '0.92.0', ['mods/fabric-api.jar' => $this->fabricJar(
            'fabric-api',
            ['fabricloader' => '>=0.14', 'minecraft' => '~1.20.1'],
            ['jars' => [['file' => 'META-INF/jars/fabric-api-base.jar']]],
            ['META-INF/jars/fabric-api-base.jar' => $this->fabricJar('fabric-api-base')],
        )]);
        $this->add('sodium', '0.5.0', ['mods/sodium.jar' => $this->fabricJar('sodium', ['minecraft' => '1.20.x', 'fabric-api-base' => '*'])]);
    }

    public function test_healthy_build_has_no_issues(): void
    {
        $this->addHealthyFabricBase();

        $this->assertSame([], $this->messages());
        $this->getJson("/modpack/build/{$this->build->id}/health")->assertJson(['checked' => 3]);
    }

    public function test_reports_problems_that_stop_a_build_launching(): void
    {
        $this->addHealthyFabricBase();
        $this->add('create', '0.5.1', ['mods/create.jar' => $this->makeArchive(['META-INF/mods.toml' => "[[mods]]\nmodId=\"create\"\nversion=\"0.5.1\""])]);
        $this->add('oldmod', '1.0', ['mods/oldmod.jar' => $this->fabricJar('oldmod', ['minecraft' => '1.19.2'])]);
        $this->add('needy', '1.0', ['mods/needy.jar' => $this->fabricJar('needy', ['cloth-config' => '*'])]);
        $this->add('sodium-copy', '0.5.0', ['mods/sodium-copy.jar' => $this->fabricJar('sodium')]);
        $this->add('ghost', '1.0', [], storeFile: false);

        $messages = $this->messages();

        $this->assertContains('error: create.jar is a forge mod, but this build uses fabric.', $messages);
        $this->assertContains('error: needy.jar requires "cloth-config", which isn\'t in this build.', $messages);
        $this->assertContains('error: 1.0: mods/ghost/ghost-1.0.zip is missing from the mod repository', $messages);
        $this->assertContains('warning: oldmod.jar is made for Minecraft 1.19.2, but this build is 1.20.1.', $messages);
        $this->assertContains('warning: sodium is included by both Sodium and Sodium-copy.', $messages);
        $this->assertSame('error', $this->getJson("/modpack/build/{$this->build->id}/health")->json('issues.0.severity'));
    }

    public function test_reports_a_missing_mod_loader(): void
    {
        $this->add('sodium', '0.5.0', ['mods/sodium.jar' => $this->fabricJar('sodium')]);

        $this->assertContains(
            'error: This build has no mod loader. Add Forge, NeoForge, Fabric or Quilt from Mods → Import → Mod loader.',
            $this->messages()
        );
    }

    public function test_quilt_builds_accept_fabric_mods(): void
    {
        $this->add('quilt-loader', '1.20.1-0.29.1', ['bin/version.json' => '{}']);
        $this->add('sodium', '0.5.0', ['mods/sodium.jar' => $this->fabricJar('sodium')]);

        $this->assertSame([], $this->messages());
    }
}
