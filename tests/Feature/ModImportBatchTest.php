<?php

namespace Tests\Feature;

use App\Models\User;
use App\Mods\ModProvider;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

final class ModImportBatchTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        $this->seed();

        $user = User::find(1);
        $this->be($user);
    }

    public function test_batch_import_no_mods_selected(): void
    {
        $response = $this->post('/mod/import/batch', [
            'provider' => 'fabric',
            'game_version' => '1.18.2',
        ]);

        $response->assertSessionHasErrors('no_mods');
    }

    public function test_batch_import_invalid_provider(): void
    {
        $response = $this->post('/mod/import/batch', [
            'provider' => 'invalid_provider',
            'mods' => ['1.18.2'],
        ]);

        $response->assertSessionHasErrors('invalid_provider');
    }

    public function test_batch_import_with_game_version(): void
    {
        $response = $this->post('/mod/import/batch', [
            'provider' => 'fabric',
            'game_version' => '1.18.2',
            'release_type' => 'release',
            'mods' => ['1.18.2'],
        ]);

        $response->assertSessionHasNoErrors();
        $response->assertSessionHas('success');
    }

    public function test_batch_import_without_game_version(): void
    {
        $response = $this->post('/mod/import/batch', [
            'provider' => 'fabric',
            'game_version' => '',
            'release_type' => 'any',
            'mods' => ['1.18.2'],
        ]);

        $response->assertSessionHasNoErrors();
        $response->assertSessionHas('success');
    }

    public function test_batch_import_nonexistent_game_version(): void
    {
        $response = $this->post('/mod/import/batch', [
            'provider' => 'fabric',
            'game_version' => '9.99.99',
            'release_type' => 'release',
            'mods' => ['1.18.2'],
        ]);

        $response->assertSessionHasErrors();
    }

    public function test_batch_import_beta_release_type_finds_beta(): void
    {
        $response = $this->post('/mod/import/batch', [
            'provider' => 'fabric',
            'game_version' => '',
            'release_type' => 'beta',
            'mods' => ['1.18.2'],
        ]);

        // Fabric loader has no beta versions, so this should report an error
        $response->assertSessionHasErrors();
    }

    // --- latestStableVersionForGame unit tests ---

    public function test_latest_stable_returns_null_when_empty(): void
    {
        $this->assertNull(ModProvider::latestStableVersionForGame([], '1.19.2'));
    }

    public function test_latest_stable_no_matching_game_version(): void
    {
        $versions = [
            '1.0.0' => (object) ['gameVersions' => ['1.18.2'], 'versionType' => 'release'],
        ];

        $this->assertNull(ModProvider::latestStableVersionForGame($versions, '1.19.2'));
    }

    public function test_latest_stable_default_prefers_release_over_beta(): void
    {
        $versions = [
            '2.0.0-beta' => (object) ['gameVersions' => ['1.19.2'], 'versionType' => 'beta'],
            '1.9.0'      => (object) ['gameVersions' => ['1.19.2'], 'versionType' => 'release'],
        ];

        $this->assertSame('1.9.0', ModProvider::latestStableVersionForGame($versions, '1.19.2'));
    }

    public function test_latest_stable_default_falls_back_to_beta(): void
    {
        $versions = [
            '2.0.0-beta' => (object) ['gameVersions' => ['1.19.2'], 'versionType' => 'beta'],
        ];

        $this->assertSame('2.0.0-beta', ModProvider::latestStableVersionForGame($versions, '1.19.2'));
    }

    public function test_latest_stable_no_game_filter_returns_first_release(): void
    {
        $versions = [
            '3.0.0' => (object) ['gameVersions' => ['1.20.1'], 'versionType' => 'release'],
            '2.0.0' => (object) ['gameVersions' => ['1.19.2'], 'versionType' => 'release'],
        ];

        $this->assertSame('3.0.0', ModProvider::latestStableVersionForGame($versions, ''));
    }

    public function test_latest_stable_assumes_release_when_type_missing(): void
    {
        $versions = [
            '1.0.0' => (object) ['gameVersions' => ['1.19.2']],
        ];

        $this->assertSame('1.0.0', ModProvider::latestStableVersionForGame($versions, '1.19.2'));
    }

    public function test_release_type_release_excludes_beta(): void
    {
        $versions = [
            '2.0.0-beta' => (object) ['gameVersions' => ['1.19.2'], 'versionType' => 'beta'],
            '1.9.0'      => (object) ['gameVersions' => ['1.19.2'], 'versionType' => 'release'],
        ];

        $this->assertSame('1.9.0', ModProvider::latestStableVersionForGame($versions, '1.19.2', 'release'));
    }

    public function test_release_type_release_returns_null_when_no_release(): void
    {
        $versions = [
            '2.0.0-beta' => (object) ['gameVersions' => ['1.19.2'], 'versionType' => 'beta'],
        ];

        $this->assertNull(ModProvider::latestStableVersionForGame($versions, '1.19.2', 'release'));
    }

    public function test_release_type_beta_returns_beta(): void
    {
        $versions = [
            '2.0.0-beta' => (object) ['gameVersions' => ['1.19.2'], 'versionType' => 'beta'],
            '1.9.0'      => (object) ['gameVersions' => ['1.19.2'], 'versionType' => 'release'],
        ];

        $this->assertSame('2.0.0-beta', ModProvider::latestStableVersionForGame($versions, '1.19.2', 'beta'));
    }

    public function test_release_type_any_returns_first_regardless_of_type(): void
    {
        $versions = [
            '2.0.0-beta' => (object) ['gameVersions' => ['1.19.2'], 'versionType' => 'beta'],
            '1.9.0'      => (object) ['gameVersions' => ['1.19.2'], 'versionType' => 'release'],
        ];

        $this->assertSame('2.0.0-beta', ModProvider::latestStableVersionForGame($versions, '1.19.2', 'any'));
    }

    public function test_release_type_alpha_returns_null_when_no_alpha(): void
    {
        $versions = [
            '1.9.0' => (object) ['gameVersions' => ['1.19.2'], 'versionType' => 'release'],
        ];

        $this->assertNull(ModProvider::latestStableVersionForGame($versions, '1.19.2', 'alpha'));
    }
}
