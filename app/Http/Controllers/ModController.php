<?php

namespace App\Http\Controllers;

use App\Libraries\UrlUtils;
use App\Models\Mod;
use App\Models\Modversion;
use App\Mods\ModProviders;
use App\Services\ModRepository;
use App\Services\ModUploadService;
use Exception;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\RedirectResponse;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Request;
use Illuminate\Support\Facades\Session;
use Illuminate\Support\Facades\Validator;
use Illuminate\Support\Str;
use Illuminate\View\View;

class ModController extends Controller
{
    public function getIndex(): RedirectResponse
    {
        return redirect('mod/list');
    }

    public function getList(): View
    {
        $this->authorize('viewAny', Mod::class);

        $mods = Mod::with('latestVersion')->get();

        return view('mod.list')->with(['mods' => $mods]);
    }

    public function getView($mod_id = null)
    {
        $mod = Mod::with('versions')
            ->with('versions.builds')
            ->with('versions.builds.modpack')
            ->find($mod_id);

        if (empty($mod)) {
            return redirect('mod/list')->withErrors(['Mod not found']);
        }

        $this->authorize('update', $mod);

        $perm = Auth::user()->permission;
        $accessibleModpackIds = $perm->solder_full
            ? null
            : $perm->modpacks;

        return view('mod.view')->with([
            'mod' => $mod,
            'accessibleModpackIds' => $accessibleModpackIds,
        ]);
    }

    public function getCreate(): View
    {
        $this->authorize('create', Mod::class);

        return view('mod.create');
    }

    public function postCreate(): RedirectResponse
    {
        $this->authorize('create', Mod::class);

        $rules = [
            'name' => 'required|unique:mods',
            'pretty_name' => 'required',
            'link' => 'nullable|url',
        ];
        $messages = [
            'name.required' => 'You must fill in a mod slug name.',
            'name.unique' => 'The slug you entered is already taken',
            'pretty_name.required' => 'You must enter in a mod name',
            'link.url' => 'You must enter a properly formatted Website',
        ];

        $validation = Validator::make(Request::all(), $rules, $messages);
        if ($validation->fails()) {
            return redirect('mod/create')->withErrors($validation->messages());
        }

        $mod = new Mod;
        $mod->name = Str::slug(Request::input('name'));
        $mod->pretty_name = Request::input('pretty_name');
        $mod->author = Request::input('author');
        $mod->description = Request::input('description');
        $mod->link = Request::input('link');
        $mod->notes = Request::input('notes');
        $mod->save();
        Cache::forget('mods');

        return redirect('mod/view/'.$mod->id);
    }

    public function getImport($provider = '', $query = ''): View
    {
        $this->authorize('create', Mod::class);

        $providers = ModProviders::providers();

        $provider = (string) Request::query('provider', $provider) ?: array_key_first($providers);
        $query = (string) Request::query('query', $query);
        $gameVersion = (string) Request::query('game_version', '');
        $releaseType = (string) Request::query('release_type', 'release');
        $loader = (string) Request::query('loader', '');
        $page = max(1, (int) Request::query('page', 1));

        $search = (object) [
            'mods' => [],
            'pagination' => (object) [
                'currentPage' => 1,
                'totalPages' => 1,
                'totalItems' => 0,
            ],
        ];

        $errors = [];

        if (! array_key_exists($provider, $providers)) {
            $errors['invalid_provider'] = 'Invalid provider specified';
        } else {
            $search = $providers[$provider]::search($query, $page, $gameVersion, $loader);
            $errors = array_merge($errors, $search->errors ?? []);
        }

        return view('mod.import')
            ->with([
                'providers' => $providers,
                'provider' => $provider,
                'query' => $query,
                'gameVersion' => $gameVersion,
                'releaseType' => $releaseType,
                'loader' => $loader,
                'mods' => $search->mods,
                'pagination' => $search->pagination,
            ])
            ->withErrors(Session::has('errors')
                ? Session::get('errors')->merge($errors)
                : $errors);
    }

    public function getImportDetails($provider, $modId): View|RedirectResponse
    {
        $this->authorize('create', Mod::class);

        $providers = ModProviders::providers();
        if (! isset($providers[$provider])) {
            return redirect('mod/import')->withErrors(['invalid_provider' => 'Invalid provider selected']);
        }

        $gameVersion = (string) Request::query('game_version', '');
        $loader = (string) Request::query('loader', '');

        $mod = $providers[$provider]::modFor($modId, $gameVersion, $loader);
        if ($mod === null) {
            return redirect('mod/import?provider='.urlencode($provider))
                ->withErrors(['mod_not_found' => 'Could not load that mod from '.$providers[$provider]::name().'.']);
        }

        return view('mod.import_details')
            ->with([
                'mod' => $mod,
                'provider' => $provider,
                'providerName' => $providers[$provider]::name(),
                'gameVersion' => $gameVersion,
                'loader' => $loader,
            ]);
    }

    public function postImportDetails($provider, $modId): RedirectResponse
    {
        $this->authorize('create', Mod::class);

        $providers = ModProviders::providers();
        $detailsUrl = "mod/import/details/$provider/$modId";

        if (! isset($providers[$provider])) {
            return redirect('mod/import')->withErrors(['invalid_provider' => 'Invalid provider selected']);
        }

        $versions = [];
        foreach ((array) Request::input('versions', []) as $encoded) {
            $decoded = base64_decode((string) $encoded, true);
            if ($decoded !== false) {
                $versions[] = $decoded;
            }
        }

        if (empty($versions)) {
            return redirect($detailsUrl)->withErrors(['no_versions' => 'Select at least one version to import']);
        }

        $modData = $providers[$provider]::modFor($modId, (string) Request::input('game_version', ''), (string) Request::input('loader', ''));
        if ($modData === null) {
            return redirect($detailsUrl)->withErrors(['mod_not_found' => 'Mod or versions could not be loaded']);
        }

        if (array_diff($versions, array_map('strval', array_keys($modData->versions)))) {
            return redirect($detailsUrl)->withErrors(['invalid_versions' => 'Invalid versions specified']);
        }

        set_time_limit(0);

        $result = Request::boolean('with_dependencies')
            ? $providers[$provider]::installWithDependencies($modId, $versions, $modData, (string) Request::input('game_version', ''), (string) Request::input('loader', ''))
            : $providers[$provider]::install($modId, $versions, $modData);

        if (! $result->success) {
            return redirect($detailsUrl)->withErrors($result->errors);
        }

        $message = trim(
            ($result->created ? "Imported {$result->created} ".Str::plural('version', $result->created).'. ' : '')
            .($result->existing ? "{$result->existing} ".Str::plural('version', $result->existing).' already existed. ' : '')
            .(! empty($result->dependencies) ? 'Also imported required mods: '.implode(', ', $result->dependencies).'.' : '')
        );

        $redirect = redirect('mod/view/'.$result->id);
        if ($message !== '') {
            $redirect->with('success', $message);
        }

        return empty($result->errors) ? $redirect : $redirect->withErrors($result->errors);
    }

    public function postImportBatch(): RedirectResponse
    {
        $this->authorize('create', Mod::class);

        $providers = ModProviders::providers();

        $provider = (string) Request::input('provider', '');
        $gameVersion = (string) Request::input('game_version', '');
        $releaseType = (string) Request::input('release_type', 'release');
        $loader = (string) Request::input('loader', '');
        $modIds = array_filter((array) Request::input('mods', []), 'is_scalar');

        if (! isset($providers[$provider])) {
            return redirect()->back()->withErrors(['invalid_provider' => 'Invalid provider selected']);
        }

        if (empty($modIds)) {
            return redirect()->back()->withErrors(['no_mods' => 'No mods selected for import']);
        }

        set_time_limit(0);

        $errors = [];
        $importedCount = 0;
        $dependencies = [];
        $withDependencies = Request::boolean('with_dependencies');
        // Shared across the batch so a library several mods need is only imported once
        $visited = array_fill_keys(array_map('strval', $modIds), true);

        foreach ($modIds as $modId) {
            $modId = (string) $modId;
            $modData = $providers[$provider]::modFor($modId, $gameVersion, $loader);

            if (! $modData || empty($modData->versions)) {
                $errors[] = "Could not load versions for mod ID: $modId";

                continue;
            }

            $version = $providers[$provider]::latestStableVersionForGame($modData->versions, $gameVersion, $releaseType, $loader);

            if ($version === null) {
                $typePart = $releaseType !== '' && $releaseType !== 'any' ? " $releaseType" : '';
                $gamePart = $gameVersion !== '' ? " for $gameVersion" : '';
                $loaderPart = $loader !== '' ? " ($loader)" : '';
                $errors[] = "No{$typePart} version found for {$modData->name}{$gamePart}{$loaderPart}";

                continue;
            }

            $result = $withDependencies
                ? $providers[$provider]::installWithDependencies($modId, [$version], $modData, $gameVersion, $loader, visited: $visited)
                : $providers[$provider]::install($modId, [$version], $modData);

            if (isset($result->modversionIds[$version])) {
                $importedCount++;
            }
            $errors = array_merge($errors, $result->errors);
            $dependencies = array_merge($dependencies, $result->dependencies ?? []);
        }

        $redirect = redirect('mod/import?'.http_build_query(array_filter([
            'provider' => $provider,
            'game_version' => $gameVersion,
            'release_type' => $releaseType,
            'loader' => $loader,
        ])));

        if ($importedCount > 0) {
            $redirect->with('success', trim("$importedCount ".Str::plural('mod', $importedCount).' imported successfully. '
                .($dependencies ? 'Also imported required mods: '.implode(', ', $dependencies).'.' : '')));
        }

        return empty($errors) ? $redirect : $redirect->withErrors($errors);
    }

    /**
     * Mark a mod version as client-only, server-only, or needed on both sides.
     */
    public function postVersionEnvironment($version_id): JsonResponse
    {
        $this->authorize('update', Modversion::class);

        $modversion = Modversion::find($version_id);
        if (empty($modversion)) {
            return response()->json(['status' => 'error', 'reason' => 'Mod version not found'], 404);
        }

        $environment = Request::input('environment') ?: null;
        if (! in_array($environment, [null, Modversion::CLIENT_ONLY, Modversion::SERVER_ONLY], true)) {
            return response()->json(['status' => 'error', 'reason' => 'Unknown environment'], 422);
        }

        $modversion->update(['environment' => $environment]);

        return response()->json(['status' => 'success', 'environment' => $environment]);
    }

    /**
     * Mod versions that no build uses, for cleaning up.
     */
    public function getUnused(): View
    {
        $this->authorize('delete', Modversion::class);

        $modversions = Modversion::with('mod')
            ->doesntHave('builds')
            ->get()
            ->sortBy(fn (Modversion $modversion) => [strtolower($modversion->mod->pretty_name ?: $modversion->mod->name), $modversion->id])
            ->values();

        return view('mod.unused', [
            'modversions' => $modversions,
            'isRemote' => ModRepository::isRemote(),
        ]);
    }

    /**
     * Delete unused mod versions (the selected ones, or all of them) and optionally their files.
     */
    public function postUnused(): RedirectResponse
    {
        $this->authorize('delete', Modversion::class);

        $query = Modversion::with('mod')->doesntHave('builds');
        if (! Request::boolean('all')) {
            $query->whereIn('id', (array) Request::input('modversions', []));
        }

        $deleteFiles = Request::boolean('delete_files') && ! ModRepository::isRemote();
        $deleted = 0;
        $freed = 0;

        // Re-checked here: a version added to a build since the page loaded is left alone
        foreach ($query->get() as $modversion) {
            if ($deleteFiles) {
                $path = ModRepository::location($modversion);
                if (is_file($path)) {
                    $freed += filesize($path);
                    unlink($path);
                }
                if (is_dir(dirname($path)) && count(scandir(dirname($path))) === 2) {
                    rmdir(dirname($path));
                }
            }

            $modversion->delete();
            $deleted++;
        }

        if ($deleted === 0) {
            return redirect('mod/unused')->withErrors(['Select at least one unused version to delete.']);
        }

        Cache::forget('mods');

        $message = "Deleted $deleted unused mod ".Str::plural('version', $deleted);
        $message .= $deleteFiles ? ' and freed '.Modversion::formatFilesize($freed).'.' : '. Their files were kept in the repository.';

        return redirect('mod/unused')->with('success', $message);
    }

    /**
     * Create mods (or new versions of existing mods) from uploaded jars.
     */
    public function postUpload(ModUploadService $uploads): RedirectResponse
    {
        $this->authorize('create', Mod::class);

        $validation = Validator::make(Request::all(), [
            'files' => ['required', 'array', 'min:1'],
            'files.*' => ['file'],
        ], ['files.required' => 'Choose at least one .jar file to upload.']);

        if ($validation->fails()) {
            return redirect('mod/list')->withErrors($validation->messages());
        }

        $result = $uploads->upload(Request::file('files'));

        $redirect = count($result['created']) === 1
            ? redirect('mod/view/'.$result['created'][0]['mod_id'])
            : redirect('mod/list');

        return $this->uploadResponse($redirect, $result);
    }

    /**
     * Add uploaded files as new versions of a mod.
     */
    public function postUploadVersions(ModUploadService $uploads, $mod_id): RedirectResponse
    {
        $mod = Mod::find($mod_id);
        if (empty($mod)) {
            return redirect('mod/list')->withErrors(['Mod not found']);
        }

        $this->authorize('create', Modversion::class);

        $validation = Validator::make(Request::all(), [
            'files' => ['required', 'array', 'min:1'],
            'files.*' => ['file'],
            'version' => ['nullable', 'string', 'max:255'],
        ], ['files.required' => 'Choose at least one file to upload.']);

        if ($validation->fails()) {
            return redirect('mod/view/'.$mod->id.'#versions')->withErrors($validation->messages());
        }

        $result = $uploads->upload(Request::file('files'), $mod, Request::input('version'));

        return $this->uploadResponse(redirect('mod/view/'.$mod->id.'#versions'), $result);
    }

    /**
     * @param  array{created: list<array{mod_id: int, mod: string, version: string}>, errors: list<string>}  $result
     */
    private function uploadResponse(RedirectResponse $redirect, array $result): RedirectResponse
    {
        if (! empty($result['created'])) {
            $added = collect($result['created'])->map(fn ($created) => "{$created['mod']} {$created['version']}")->implode(', ');
            $redirect->with('success', 'Added '.$added.'.');
        }

        return empty($result['errors']) ? $redirect : $redirect->withErrors($result['errors']);
    }

    public function getDelete($mod_id = null)
    {
        $mod = Mod::find($mod_id);
        if (empty($mod)) {
            return redirect('mod/list')->withErrors(['Mod not found']);
        }

        $this->authorize('delete', $mod);

        return view('mod.delete')->with(['mod' => $mod]);
    }

    public function postModify($mod_id = null): RedirectResponse
    {
        $mod = Mod::find($mod_id);
        if (empty($mod)) {
            return redirect('mod/list')->withErrors(['Error modifying mod - Mod not found']);
        }

        $this->authorize('update', $mod);

        $rules = [
            'pretty_name' => 'required',
            'name' => 'required|unique:mods,name,'.$mod->id,
            'link' => 'nullable|url',
        ];

        $messages = [
            'name.required' => 'You must fill in a mod slug name.',
            'name.unique' => 'The slug you entered is already in use by another mod',
            'pretty_name.required' => 'You must enter in a mod name',
            'link.url' => 'You must enter a properly formatted Website',
        ];

        $validation = Validator::make(Request::all(), $rules, $messages);
        if ($validation->fails()) {
            return redirect('mod/view/'.$mod->id)->withErrors($validation->messages());
        }

        $mod->pretty_name = Request::input('pretty_name');
        $mod->name = Request::input('name');
        $mod->author = Request::input('author');
        $mod->description = Request::input('description');
        $mod->link = Request::input('link');
        $mod->notes = Request::input('notes');
        $mod->save();
        Cache::forget('mod:'.$mod->name);
        Cache::forget('mods');

        return redirect('mod/view/'.$mod->id)->with('success', 'Mod successfully edited.');
    }

    public function postDelete($mod_id = null): RedirectResponse
    {
        $mod = Mod::find($mod_id);
        if (empty($mod)) {
            return redirect('mod/list')->withErrors(['Error deleting mod - Mod not found']);
        }

        $this->authorize('delete', $mod);

        foreach ($mod->versions as $ver) {
            $ver->builds()->sync([]);
            $ver->delete();
        }
        $mod->delete();
        Cache::forget('mod:'.$mod->name);
        Cache::forget('mods');

        return redirect('mod/list')->with('success', 'Mod deleted!');
    }

    public function anyRehash(): JsonResponse
    {
        if (! Request::ajax()) {
            abort(404);
        }

        $this->authorize('update', Modversion::class);

        $md5 = Request::input('md5');
        $ver_id = Request::input('version-id');
        if (empty($ver_id)) {
            return response()->json([
                'status' => 'error',
                'reason' => 'Missing Post Data',
            ]);
        }

        $ver = Modversion::find($ver_id);
        if (empty($ver)) {
            return response()->json([
                'status' => 'error',
                'reason' => 'Could not pull mod version from database',
            ]);
        }

        $md5 = is_string($md5) ? $md5 : '';

        if ($md5 !== '' && ! preg_match('/^[a-f0-9]{32}$/i', $md5)) {
            return response()->json([
                'status' => 'error',
                'reason' => 'Invalid MD5 hash format',
            ]);
        }

        if ($md5 !== '') {
            $ver->md5 = $md5;
            $ver->save();

            return response()->json([
                'status' => 'success',
                'version_id' => $ver->id,
                'md5' => $ver->md5,
                'filesize' => $ver->humanFilesize(),
            ]);
        }

        $md5Request = $this->mod_md5($ver->mod, $ver->version);

        if (! $md5Request['success']) {
            return response()->json([
                'status' => 'error',
                'reason' => 'MD5 hashing failed. '.$md5Request['message'],
            ]);
        }

        $ver->filesize = $md5Request['filesize'];
        $ver->md5 = $md5Request['md5'];
        $ver->save();

        return response()->json([
            'status' => 'success',
            'version_id' => $ver->id,
            'md5' => $ver->md5,
            'filesize' => $ver->humanFilesize(),
        ]);
    }

    public function anyAddVersion(): JsonResponse
    {
        if (! Request::ajax()) {
            abort(404);
        }

        $this->authorize('create', Modversion::class);

        $mod_id = Request::input('mod-id');
        $md5 = Request::input('add-md5');
        $version = Request::input('add-version');
        if (empty($mod_id) || empty($version)) {
            return response()->json([
                'status' => 'error',
                'reason' => 'Missing Post Data',
            ]);
        }

        $mod = Mod::find($mod_id);
        if (empty($mod)) {
            return response()->json([
                'status' => 'error',
                'reason' => 'Could not pull mod from database',
            ]);
        }

        if (Modversion::where([
            'mod_id' => $mod_id,
            'version' => $version,
        ])->count() > 0) {
            return response()->json([
                'status' => 'error',
                'reason' => 'That mod version already exists',
            ]);
        }

        $md5 = is_string($md5) ? $md5 : '';

        if ($md5 !== '' && ! preg_match('/^[a-f0-9]{32}$/i', $md5)) {
            return response()->json([
                'status' => 'error',
                'reason' => 'Invalid MD5 hash format',
            ]);
        }

        $ver = new Modversion;
        $ver->mod_id = $mod->id;
        $ver->version = $version;

        if ($md5 !== '') {
            $ver->md5 = $md5;
            $ver->save();

            return response()->json([
                'status' => 'success',
                'version' => $ver->version,
                'version_id' => $ver->id,
                'md5' => $ver->md5,
                'filesize' => $ver->humanFilesize(),
            ]);
        }

        $file_md5 = $this->mod_md5($mod, $version);

        if (! $file_md5['success']) {
            return response()->json([
                'status' => 'error',
                'reason' => 'MD5 hashing failed. '.$file_md5['message'],
            ]);
        }

        $ver->filesize = $file_md5['filesize'];
        $ver->md5 = $file_md5['md5'];
        $ver->save();

        return response()->json([
            'status' => 'success',
            'version' => $ver->version,
            'md5' => $ver->md5,
            'filesize' => $ver->humanFilesize(),
        ]);
    }

    public function anyUpdateVersion($ver_id = null): JsonResponse
    {
        if (! Request::ajax()) {
            abort(404);
        }

        $this->authorize('update', Modversion::class);

        $ver = Modversion::find($ver_id);
        if (empty($ver)) {
            return response()->json([
                'status' => 'error',
                'reason' => 'Could not find mod version',
            ]);
        }

        $ver->notes = Request::input('notes');
        $ver->save();

        Cache::forget('mod:'.$ver->mod->name);

        return response()->json([
            'status' => 'success',
            'version_id' => $ver->id,
        ]);
    }

    public function anyDeleteVersion($ver_id = null): JsonResponse
    {
        if (! Request::ajax()) {
            abort(404);
        }

        $this->authorize('delete', Modversion::class);

        if (empty($ver_id)) {
            return response()->json([
                'status' => 'error',
                'reason' => 'Missing Post Data',
            ]);
        }

        $ver = Modversion::find($ver_id);
        if (empty($ver)) {
            return response()->json([
                'status' => 'error',
                'reason' => 'Could not pull mod version from database',
            ]);
        }

        if ($ver->builds()->exists()) {
            return response()->json([
                'status' => 'error',
                'reason' => 'This version is in use by '.
                    $ver->builds()->count().' build(s) and cannot be deleted.',
            ]);
        }

        $old_id = $ver->id;
        $old_version = $ver->version;
        $ver->delete();

        return response()->json([
            'status' => 'success',
            'version' => $old_version,
            'version_id' => $old_id,
        ]);
    }

    public function getModVersions($modSlug)
    {
        if (! Request::ajax()) {
            abort(404);
        }

        if (empty($modSlug)) {
            return response()->json([
                'status' => 'error',
                'reason' => 'Missing data',
            ]);
        }

        $mod = Cache::remember('mod:'.$modSlug, now()->addMinutes(5), function () use ($modSlug) {
            return Mod::with('versions')->where('name', $modSlug)->first();
        });

        if (! $mod) {
            return response()->json([
                'status' => 'error',
                'reason' => 'Unknown mod',
            ]);
        }

        $response = $mod->only([
            'id',
            'name',
            'pretty_name',
            'author',
            'description',
            'link',
        ]);

        $response['versions'] = $mod->versions->pluck('version');

        return response()->json($response);
    }

    private function mod_md5($mod, $version)
    {
        $location = config('solder.repo_location');
        $URI = $location.'mods/'.$mod->name.'/'.$mod->name.'-'.$version.'.zip';

        if (filter_var($URI, FILTER_VALIDATE_URL)) {
            return $this->remote_mod_md5($mod, $version, $location);
        } elseif (file_exists($URI)) {
            Log::info('Found \''.$URI.'\'');
            try {
                $filesize = filesize($URI);
                $md5 = md5_file($URI);

                return ['success' => true, 'md5' => $md5, 'filesize' => $filesize];
            } catch (Exception $e) {
                Log::error('Error attempting to md5 the file: '.$URI);

                return ['success' => false, 'message' => $e->getMessage()];
            }
        } else {
            $error = $URI.' does not exist';
            Log::error($error);

            return ['success' => false, 'message' => $error];
        }
    }

    private function remote_mod_md5($mod, $version, $location)
    {
        $URL = $location.'mods/'.$mod->name.'/'.$mod->name.'-'.$version.'.zip';

        $attempts = 0;

        do {
            $result = UrlUtils::get_remote_md5($URL);

            if (! $result['success']) {
                Log::warning('Error attempting to remote MD5 file '.$mod->name.' version '.$version.' located at '.$URL.'.');
            }

            $attempts++;
        } while ($attempts < 3 && ! $result['success']);

        return $result;
    }
}
