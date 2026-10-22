<?php

namespace Tests\Feature;

use App\Models\Mod;
use App\Models\Modversion;
use App\Models\User;
use App\Models\UserPermission;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Tests\FakesModProviders;
use Tests\TestCase;
use ZipArchive;

final class ModUploadTest extends TestCase
{
    use FakesModProviders;
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        $this->seed();
        $this->be(User::find(1));
        $this->setUpModRepository();
    }

    private function jar(string $name, string $contents): UploadedFile
    {
        return UploadedFile::fake()->createWithContent($name, $contents);
    }

    private function iris(string $version = '1.7.0'): string
    {
        return $this->makeArchive(['fabric.mod.json' => json_encode([
            'id' => 'iris',
            'name' => 'Iris',
            'version' => $version,
            'description' => 'Shaders',
            'authors' => ['coderbot', ['name' => 'IMS']],
            'contact' => ['homepage' => 'https://irisshaders.dev'],
            'depends' => ['minecraft' => '~1.20.1', 'sodium' => '*'],
        ])]);
    }

    private function zipEntries(string $mod, string $version): array
    {
        $zip = new ZipArchive;
        $zip->open($this->modRepository."mods/$mod/$mod-$version.zip");
        $entries = [];
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $entries[] = $zip->getNameIndex($i);
        }
        $zip->close();

        return $entries;
    }

    public function test_uploading_jars_creates_mods_from_their_metadata(): void
    {
        $response = $this->post('/mod/upload', ['files' => [$this->jar('iris-1.7.0.jar', $this->iris())]]);

        $mod = Mod::where('name', 'iris')->firstOrFail();
        $response->assertRedirect("mod/view/{$mod->id}");
        $response->assertSessionHas('success', 'Added Iris 1.20.1-1.7.0.');
        $this->assertSame('Iris', $mod->pretty_name);
        $this->assertSame('coderbot, IMS', $mod->author);
        $this->assertSame('https://irisshaders.dev', $mod->link);

        $modversion = $mod->versions()->sole();
        $this->assertSame('1.20.1-1.7.0', $modversion->version);
        $this->assertSame(['mods/iris-1.7.0.jar'], $this->zipEntries('iris', '1.20.1-1.7.0'));
        $this->assertSame(md5_file($this->modRepository.'mods/iris/iris-1.20.1-1.7.0.zip'), $modversion->md5);
    }

    public function test_uploading_several_jars_reports_each_one(): void
    {
        $response = $this->post('/mod/upload', ['files' => [
            $this->jar('iris.jar', $this->iris()),
            $this->jar('broken.jar', 'not a zip'),
            $this->jar('notes.txt', 'hello'),
        ]]);

        // Only one mod was added, so the response opens it
        $response->assertRedirect('mod/view/'.Mod::where('name', 'iris')->value('id'));
        $response->assertSessionHas('success', 'Added Iris 1.20.1-1.7.0.');
        $errors = session('errors')->all();
        $this->assertContains('broken.jar: not a valid jar or zip file', $errors);
        $this->assertContains('notes.txt: only .jar and .zip files can be uploaded', $errors);
    }

    public function test_uploading_versions_to_an_existing_mod(): void
    {
        $mod = Mod::create(['name' => 'iris', 'pretty_name' => 'Iris']);

        $this->post("/mod/upload/{$mod->id}", ['files' => [$this->jar('iris.jar', $this->iris('1.8.0'))]])
            ->assertRedirect("mod/view/{$mod->id}#versions");
        $this->post("/mod/upload/{$mod->id}", [
            'files' => [$this->jar('iris-pack.zip', $this->makeArchive(['mods/iris.jar' => 'jar', 'config/iris.properties' => 'x']))],
            'version' => 'custom 2',
        ]);

        $this->assertSame(['1.20.1-1.8.0', 'custom-2'], $mod->versions()->orderBy('id')->pluck('version')->all());
        $this->assertSame(['mods/iris.jar', 'config/iris.properties'], $this->zipEntries('iris', 'custom-2'));
    }

    public function test_mod_page_offers_uploads_and_shows_where_versions_came_from(): void
    {
        $mod = Mod::create(['name' => 'iris', 'pretty_name' => 'Iris']);
        Modversion::create(['mod_id' => $mod->id, 'version' => '1.7.0', 'md5' => 'x', 'provider' => 'modrinth', 'provider_project_id' => 'YL57xq9U', 'provider_version_id' => 'v1']);

        $response = $this->get("/mod/view/{$mod->id}");

        $response->assertOk();
        $response->assertSee(route('mod.upload_versions', ['mod_id' => $mod->id]), false);
        // @js() escapes quotes in the row data it embeds
        // @js() escapes quotes in the row data it embeds
        $response->assertSee(str_replace('"', '\u0022', '"provider":"Modrinth"'), false);
    }

    public function test_existing_versions_are_not_overwritten(): void
    {
        $mod = Mod::create(['name' => 'iris', 'pretty_name' => 'Iris']);
        Modversion::create(['mod_id' => $mod->id, 'version' => '1.20.1-1.7.0', 'md5' => 'original']);

        $response = $this->post("/mod/upload/{$mod->id}", ['files' => [$this->jar('iris.jar', $this->iris())]]);

        $this->assertSame(['iris.jar: iris 1.20.1-1.7.0 already exists'], session('errors')->all());
        $this->assertSame('original', $mod->versions()->sole()->md5);
        $response->assertSessionMissing('success');
    }

    public function test_uploads_need_a_local_repository(): void
    {
        config(['solder.repo_location' => 'https://mods.example.com/']);

        $this->post('/mod/upload', ['files' => [$this->jar('iris.jar', $this->iris())]]);

        $this->assertStringContainsString('remote URL', session('errors')->first());
        $this->assertFalse(Mod::where('name', 'iris')->exists());
    }

    public function test_uploading_requires_permission(): void
    {
        $user = new User;
        $user->forceFill([
            'username' => 'viewer', 'email' => 'viewer@example.com', 'password' => 'password',
            'created_ip' => '127.0.0.1', 'created_by_user_id' => 1, 'updated_by_user_id' => 1, 'updated_by_ip' => '127.0.0.1',
        ])->save();
        $permission = new UserPermission;
        $permission->user_id = $user->id;
        $permission->save();
        $this->be($user->fresh('permission'));

        $this->post('/mod/upload', ['files' => [$this->jar('iris.jar', $this->iris())]])->assertRedirect('dashboard');
        $this->assertFalse(Mod::where('name', 'iris')->exists());
    }
}
