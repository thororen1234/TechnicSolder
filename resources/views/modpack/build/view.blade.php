@extends('layouts.master')
@section('title')
    <title>{{ $build->version }} - {{ $build->modpack->name }} - Technic Solder</title>
@stop
@section('content')
    @php($loader = $build->loader())
    <div class="page-header">
        <div class="min-w-0">
            <a href="{{ url('modpack/view/'.$build->modpack->id) }}" class="inline-flex items-center gap-2 text-sm text-gray-500 hover:text-gray-950 dark:hover:text-white">
                <img src="{{ $build->modpack->icon_url ?? asset('/resources/default/icon.png') }}" alt="" class="size-4 rounded">
                {{ $build->modpack->name }}
            </a>
            <div class="mt-1 flex items-center gap-3 flex-wrap">
                <h1 class="page-title">Build <span class="font-mono">{{ $build->version }}</span></h1>
                @if ($build->modpack->recommended === $build->version)
                    <span class="ui-badge ui-badge-success">Recommended</span>
                @endif
                @if ($build->modpack->latest === $build->version)
                    <span class="ui-badge ui-badge-primary">Latest</span>
                @endif
                @if ($build->is_published)
                    <span class="ui-badge">Published</span>
                @else
                    <span class="ui-badge ui-badge-warning">Draft</span>
                @endif
                @if ($build->private)
                    <span class="ui-badge"><x-icons.lock-closed class="size-3" /> Private</span>
                @endif
            </div>
        </div>
        <div class="flex items-center gap-2 shrink-0">
            <div class="relative" x-data="{ open: {{ $errors->has('minecraft') ? 'true' : 'false' }} }" @keydown.escape="open = false">
                <button type="button" @click="open = !open" class="ui-btn ui-btn-secondary" :aria-expanded="open"
                        title="Copy this build to another Minecraft version, updating every mod that can be">Copy to…</button>
                <form x-show="open" x-transition.opacity.duration.100ms @click.outside="open = false" style="display: none"
                      method="POST" action="{{ route('modpack.build.copy', ['build_id' => $build->id]) }}"
                      class="ui-menu absolute right-0 z-20 mt-1 w-80 p-4 space-y-3">
                    @csrf
                    <p class="text-sm font-medium text-gray-950 dark:text-white">Copy to another Minecraft version</p>
                    <p class="text-xs text-gray-500">Mods imported from Modrinth, CurseForge and the loader sites move to their newest compatible version. Mods without one are left out.</p>
                    <div>
                        <label for="copy-minecraft" class="ui-label">Minecraft version</label>
                        <input id="copy-minecraft" name="minecraft" value="{{ old('minecraft') }}" placeholder="e.g. 1.21.1 or 26.1" class="ui-control font-mono" required>
                    </div>
                    <div>
                        <label for="copy-version" class="ui-label">New build version</label>
                        <input id="copy-version" name="version" value="{{ old('version') }}" class="ui-control font-mono" required>
                    </div>
                    <button type="submit" class="ui-btn ui-btn-primary w-full">Copy build</button>
                </form>
            </div>
            <a href="{{ route('modpack.build.compare', ['build_id' => $build->id]) }}" class="ui-btn ui-btn-secondary">Compare</a>
            <div class="relative" x-data="{ open: false }" @keydown.escape="open = false">
                <button type="button" @click="open = !open" @click.outside="open = false" class="ui-btn ui-btn-secondary" :aria-expanded="open">
                    Export
                    <svg class="size-3.5" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5"/></svg>
                </button>
                <div x-show="open" x-transition.opacity.duration.100ms style="display: none" class="ui-menu absolute right-0 z-20 mt-1 w-72">
                    @foreach (App\Services\PackExportService::FORMATS as $format => $exportFormat)
                        <a href="{{ route('modpack.build.export.archive', ['build_id' => $build->id, 'format' => $format]) }}"
                           class="ui-menu-item flex-col items-start! gap-0!" @click="open = false">
                            <span class="font-medium text-gray-950 dark:text-white">{{ $exportFormat['label'] }}</span>
                            <span class="text-xs text-gray-500">{{ $exportFormat['description'] }}</span>
                        </a>
                    @endforeach
                    <div class="my-1 h-px bg-gray-100 dark:bg-gray-900"></div>
                    <a href="{{ url('modpack/build/'.$build->id.'/export') }}" class="ui-menu-item flex-col items-start! gap-0!">
                        <span class="font-medium text-gray-950 dark:text-white">Mod list (.csv)</span>
                        <span class="text-xs text-gray-500">Names, versions and checksums</span>
                    </a>
                </div>
            </div>
            <a href="{{ url('modpack/build/'.$build->id.'/edit') }}" class="ui-btn ui-btn-primary">Edit build</a>
        </div>
    </div>

    @session('success')
        <div class="ui-alert ui-alert-success mb-6 p-4">{{ $value }}</div>
    @endsession
    @include('partial.form-errors')

    {{-- Build details --}}
    <div class="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-8">
        <div class="ui-stat">
            <p class="ui-stat-label">Minecraft</p>
            <p class="ui-stat-value font-mono text-xl">{{ $build->minecraft }}</p>
        </div>
        <div class="ui-stat">
            <p class="ui-stat-label">Mod loader</p>
            @if ($loader)
                <p class="ui-stat-value text-xl">{{ ['forge' => 'Forge', 'neoforge' => 'NeoForge', 'fabric' => 'Fabric', 'quilt' => 'Quilt'][$loader['type']] }}</p>
                <p class="mt-0.5 font-mono text-xs text-gray-500 truncate">{{ $loader['version'] }}</p>
            @else
                <p class="ui-stat-value text-xl text-gray-300 dark:text-gray-700">None</p>
            @endif
        </div>
        <div class="ui-stat">
            <p class="ui-stat-label">Java</p>
            <p class="ui-stat-value text-xl">{{ $build->min_java ?: '-' }}</p>
            @if (config('solder.advanced_mode') && $build->java_runtime)
                <p class="mt-0.5 text-xs text-gray-500 truncate">{{ \App\JavaRuntimesEnum::from($build->java_runtime)->label() }}</p>
            @endif
        </div>
        <div class="ui-stat">
            <p class="ui-stat-label">Memory</p>
            <p class="ui-stat-value text-xl">{{ $build->min_memory ? number_format($build->min_memory).' MB' : '-' }}</p>
        </div>
        <div class="ui-stat col-span-2 lg:col-span-1">
            <p class="ui-stat-label">Mods</p>
            <p class="ui-stat-value">{{ $build->modversions->count() }}</p>
        </div>
    </div>

    {{-- Launches over the last 30 days --}}
    @php($peak = max(1, max($launches)))
    <section class="ui-card px-5 py-4 mb-8">
        <div class="flex items-baseline justify-between gap-3 mb-3">
            <h2 class="section-title">Launches</h2>
            <p class="text-xs text-gray-500"><span class="font-medium text-gray-950 dark:text-white tabular-nums">{{ number_format(array_sum($launches)) }}</span> in the last 30 days</p>
        </div>
        <div class="flex items-end gap-0.5 h-16" role="img" aria-label="Launcher requests per day over the last 30 days">
            @foreach ($launches as $date => $count)
                <div class="flex-1 rounded-sm {{ $count ? 'bg-gray-950 dark:bg-white' : 'bg-gray-100 dark:bg-gray-900' }}"
                     style="height: {{ max(4, round($count / $peak * 100)) }}%"
                     title="{{ \Illuminate\Support\Carbon::parse($date)->format('M j') }}: {{ number_format($count) }}"></div>
            @endforeach
        </div>
    </section>

    <div x-data="{ tab: ['health', 'updates', 'activity'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'mods' }"
         x-init="$watch('tab', value => history.replaceState(null, '', value === 'mods' ? location.pathname : '#' + value))">
        <nav class="flex items-center gap-1 mb-6 border-b border-gray-200 dark:border-gray-800" aria-label="Build sections">
            @foreach (['mods' => 'Mods', 'health' => 'Health', 'updates' => 'Updates', 'activity' => 'Activity'] as $key => $title)
                <button type="button" @click="tab = '{{ $key }}'"
                        class="relative px-3 py-2 text-sm transition-colors"
                        :class="tab === '{{ $key }}' ? 'text-gray-950 dark:text-white' : 'text-gray-500 hover:text-gray-950 dark:hover:text-white'"
                        :aria-current="tab === '{{ $key }}' ? 'page' : null">
                    {{ $title }}
                    <span x-show="tab === '{{ $key }}'" class="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-gray-950 dark:bg-white"></span>
                </button>
            @endforeach
        </nav>

        {{-- Mods --}}
        <div x-show="tab === 'mods'">
            @if ($build->isLive())
                <div x-data="{ showPanels: false }">
                    <div class="ui-alert ui-alert-warning p-4 mb-6">
                        <p>This build is published and public. <strong>Changes reach players the next time they launch.</strong></p>
                        <p x-show="!showPanels" class="mt-2">
                            Editing is hidden to avoid accidents.
                            <button type="button" @click="showPanels = true" class="underline font-medium">Show the editor</button>
                        </p>
                    </div>
                    <template x-if="showPanels">
                        <div>@include('modpack.build._edit-panels')</div>
                    </template>
                </div>
            @else
                @include('modpack.build._edit-panels')
            @endif
        </div>

        {{-- Health --}}
        <section x-show="tab === 'health'" x-cloak class="ui-card overflow-hidden"
                 x-data="{
                     state: 'idle',
                     issues: [],
                     checked: 0,
                     get errors() { return this.issues.filter(issue => issue.severity === 'error').length },
                     async run() {
                         this.state = 'loading';
                         try {
                             const data = await window.ajax(@js(route('modpack.build.health', ['build_id' => $build->id])));
                             this.issues = data.issues;
                             this.checked = data.checked;
                             this.state = 'done';
                         } catch (e) {
                             this.state = 'error';
                         }
                     },
                 }"
                 x-init="$watch('tab', value => { if (value === 'health' && state === 'idle') run() }); if (tab === 'health') run()">
            <div class="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-gray-200 dark:border-gray-800">
                <div>
                    <h2 class="section-title">Build health</h2>
                    <p class="text-xs text-gray-500 mt-0.5">Missing files, wrong loader or Minecraft version, missing dependencies and duplicates.</p>
                </div>
                <button type="button" class="ui-btn ui-btn-sm ui-btn-secondary" @click="run()" :disabled="state === 'loading'"
                        x-text="state === 'loading' ? 'Checking…' : 'Check again'">Check again</button>
            </div>
            <p x-show="state === 'loading'" class="px-5 py-12 text-center text-sm text-gray-500">Reading every jar in this build…</p>
            <p x-show="state === 'error'" class="px-5 py-12 text-center text-sm text-red-600 dark:text-red-400">The check failed. Try again.</p>
            <div x-show="state === 'done' && issues.length === 0" class="px-5 py-12 text-center">
                <p class="text-sm font-medium text-gray-950 dark:text-white">No problems found</p>
                <p class="mt-1 text-sm text-gray-500" x-text="'Checked ' + checked + ' mod versions.'"></p>
            </div>
            <ul x-show="state === 'done' && issues.length" class="divide-y divide-gray-100 dark:divide-gray-900">
                <template x-for="(issue, index) in issues" :key="index">
                    <li class="flex items-start gap-3 px-5 py-3 text-sm">
                        <span class="mt-1.5 size-2 shrink-0 rounded-full" :class="issue.severity === 'error' ? 'bg-red-500' : 'bg-amber-500'"></span>
                        <div class="min-w-0">
                            <p class="text-gray-950 dark:text-white" x-text="issue.message"></p>
                            <p class="text-xs text-gray-500" x-show="issue.mod" x-text="issue.mod"></p>
                        </div>
                    </li>
                </template>
            </ul>
        </section>

        {{-- Updates --}}
        <section x-show="tab === 'updates'" x-cloak class="ui-card overflow-hidden"
                 x-data="{
                     state: 'idle',
                     updates: [],
                     selected: [],
                     version: @js(old('version', preg_replace_callback('/(\d+)(?!.*\d)/', fn ($match) => $match[1] + 1, $build->version))),
                     async run() {
                         this.state = 'loading';
                         try {
                             const data = await window.ajax(@js(route('modpack.build.updates', ['build_id' => $build->id])));
                             this.updates = data.updates;
                             this.selected = data.updates.map(update => String(update.modversion_id));
                             this.state = 'done';
                         } catch (e) {
                             this.state = 'error';
                         }
                     },
                 }"
                 x-init="$watch('tab', value => { if (value === 'updates' && state === 'idle') run() }); if (tab === 'updates') run()">
            <form method="POST" action="{{ route('modpack.build.updates', ['build_id' => $build->id]) }}">
                @csrf
                <div class="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-gray-200 dark:border-gray-800">
                    <div>
                        <h2 class="section-title">Updates</h2>
                        <p class="text-xs text-gray-500 mt-0.5">Newer versions of mods imported from Modrinth, CurseForge and the loader sites, for Minecraft {{ $build->minecraft }}.</p>
                    </div>
                    <button type="button" class="ui-btn ui-btn-sm ui-btn-secondary" @click="run()" :disabled="state === 'loading'"
                            x-text="state === 'loading' ? 'Checking…' : 'Check again'">Check again</button>
                </div>
                <p x-show="state === 'loading'" class="px-5 py-12 text-center text-sm text-gray-500">Asking the mod providers for newer versions…</p>
                <p x-show="state === 'error'" class="px-5 py-12 text-center text-sm text-red-600 dark:text-red-400">The check failed. Try again.</p>
                <div x-show="state === 'done' && updates.length === 0" class="px-5 py-12 text-center">
                    <p class="text-sm font-medium text-gray-950 dark:text-white">Everything is up to date</p>
                    <p class="mt-1 text-sm text-gray-500">Mods added by hand can't be checked; import them from a provider to track updates.</p>
                </div>
                <div x-show="state === 'done' && updates.length">
                    <div class="overflow-x-auto">
                        <table class="w-full text-sm">
                            <thead>
                                <tr class="ui-table-head">
                                    <th class="pl-5 pr-2 py-3 w-8">
                                        <input type="checkbox" class="ui-checkbox" aria-label="Select all"
                                               :checked="selected.length === updates.length"
                                               @change="selected = $event.target.checked ? updates.map(update => String(update.modversion_id)) : []">
                                    </th>
                                    <th class="px-3 py-3">Mod</th>
                                    <th class="px-3 py-3">Current</th>
                                    <th class="px-3 py-3">Available</th>
                                    <th class="px-5 py-3 hidden sm:table-cell">Source</th>
                                </tr>
                            </thead>
                            <tbody class="ui-table-body">
                                <template x-for="update in updates" :key="update.modversion_id">
                                    <tr class="hover:bg-gray-50 dark:hover:bg-gray-900/50">
                                        <td class="pl-5 pr-2 py-2.5">
                                            <input type="checkbox" name="modversions[]" class="ui-checkbox" :value="String(update.modversion_id)" x-model="selected" :aria-label="'Update ' + update.name">
                                        </td>
                                        <td class="px-3 py-2.5 font-medium text-gray-950 dark:text-white" x-text="update.name"></td>
                                        <td class="px-3 py-2.5 font-mono text-xs text-gray-500" x-text="update.current"></td>
                                        <td class="px-3 py-2.5 font-mono text-xs text-gray-950 dark:text-white" x-text="update.latest_label"></td>
                                        <td class="px-5 py-2.5 text-xs text-gray-500 hidden sm:table-cell" x-text="update.provider"></td>
                                    </tr>
                                </template>
                            </tbody>
                        </table>
                    </div>
                    <div class="flex flex-col sm:flex-row sm:items-end justify-between gap-3 px-5 py-4 border-t border-gray-200 dark:border-gray-800">
                        <div>
                            <label for="update-version" class="ui-label">New build version</label>
                            <input id="update-version" name="version" x-model="version" class="ui-control sm:w-48 font-mono" required>
                        </div>
                        <div class="flex items-center gap-3">
                            <p class="text-xs text-gray-500 max-w-xs">Creates a new unpublished build; this one stays as it is.</p>
                            <button type="submit" class="ui-btn ui-btn-primary" :disabled="!selected.length || !version"
                                    x-text="'Create build with ' + selected.length + ' update' + (selected.length === 1 ? '' : 's')">Create build</button>
                        </div>
                    </div>
                </div>
            </form>
        </section>

        {{-- Activity --}}
        <section x-show="tab === 'activity'" x-cloak class="ui-card overflow-hidden">
            <div class="ui-card-header"><h2 class="section-title">Activity</h2></div>
            @include('partial.activity-list', ['entries' => $activity, 'empty' => 'No changes to this build have been recorded yet.'])
        </section>
    </div>
@endsection

@push('scripts')
<script>
document.addEventListener('alpine:init', () => {
    Alpine.data('modSearch', () => ({
        query: '',
        selectedMod: null,
        selectedModName: '',
        showDropdown: false,
        modHighlight: -1,
        versions: [],
        selectedVersion: '',
        versionQuery: '',
        showVersionDropdown: false,
        versionHighlight: -1,
        loadingVersions: false,
        mods: @json($mods->map(fn($m) => ['name' => $m->name, 'pretty_name' => $m->pretty_name ?: $m->name])),
        modsInBuild: new Set(@json($build->modversions->pluck('mod.name'))),

        get filteredMods() {
            let list = this.mods.filter(m => !this.modsInBuild.has(m.name));
            if (!this.query) return list;
            const q = this.query.toLowerCase();
            return list.filter(m =>
                m.pretty_name.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
            );
        },

        get filteredVersions() {
            if (!this.versionQuery) return this.versions;
            const q = this.versionQuery.toLowerCase();
            return this.versions.filter(v => v.toLowerCase().includes(q));
        },

        scrollToHighlight(ref, index) {
            this.$nextTick(() => {
                const container = this.$refs[ref];
                const item = container?.children[index];
                item?.scrollIntoView({ block: 'nearest' });
            });
        },

        modArrow(dir) {
            const len = this.filteredMods.length;
            if (!len) return;
            this.modHighlight = dir === 'down'
                ? (this.modHighlight + 1) % len
                : (this.modHighlight - 1 + len) % len;
            this.scrollToHighlight('modDropdown', this.modHighlight);
        },

        versionArrow(dir) {
            const len = this.filteredVersions.length;
            if (!len) return;
            this.versionHighlight = dir === 'down'
                ? (this.versionHighlight + 1) % len
                : (this.versionHighlight - 1 + len) % len;
            this.scrollToHighlight('versionDropdown', this.versionHighlight);
        },

        selectMod(mod) {
            this.selectedMod = mod;
            this.selectedModName = mod.name;
            this.query = mod.pretty_name;
            this.showDropdown = false;
            this.modHighlight = -1;
            this.versions = [];
            this.selectedVersion = '';
            this.versionQuery = '';
            this.loadVersions(mod.name);
        },

        selectVersion(v) {
            this.selectedVersion = v;
            this.versionQuery = v;
            this.showVersionDropdown = false;
            this.versionHighlight = -1;
        },

        clearSelection() {
            this.selectedMod = null;
            this.selectedModName = '';
            this.versions = [];
            this.selectedVersion = '';
            this.versionQuery = '';
        },

        async loadVersions(modName) {
            this.loadingVersions = true;
            try {
                const data = await window.ajax("{{ url('mod/versions') }}/" + modName);
                if (data.versions && data.versions.length > 0) {
                    this.versions = data.versions;
                    this.selectedVersion = data.versions[0];
                    this.versionQuery = data.versions[0];
                    this.$nextTick(() => {
                        this.$refs.versionInput?.focus();
                        this.showVersionDropdown = true;
                    });
                } else {
                    this.versions = [];
                    Alpine.store('toasts').add('No mod versions found for ' + (data.pretty_name || modName), 'warning');
                }
            } catch (e) {
                Alpine.store('toasts').add('Failed to load mod versions', 'error');
            }
            this.loadingVersions = false;
        },

        async addToBuild() {
            if (!this.selectedVersion) {
                Alpine.store('toasts').add('Please select a mod version', 'warning');
                return;
            }
            try {
                const params = new URLSearchParams();
                params.append('_token', window.csrfToken);
                params.append('build', '{{ $build->id }}');
                params.append('action', 'add');
                params.append('mod-name', this.selectedModName);
                params.append('mod-version', this.selectedVersion);

                const res = await fetch("{{ url('modpack/modify/add') }}", {
                    method: 'POST',
                    headers: {
                        'X-Requested-With': 'XMLHttpRequest',
                        'Accept': 'application/json',
                    },
                    body: params,
                });
                const data = await res.json();

                if (data.status === 'success') {
                    Alpine.store('toasts').add('Mod ' + data.pretty_name + ' added at ' + data.version, 'success');
                    this.modsInBuild.add(data.mod_name);
                    this.$dispatch('mod-added', {
                        mod_id: data.mod_id,
                        mod_name: data.mod_name,
                        pretty_name: data.pretty_name,
                        version: data.version,
                        modversion_id: data.modversion_id,
                        versions: data.versions,
                    });
                    this.query = '';
                    this.clearSelection();
                    return true;
                } else {
                    Alpine.store('toasts').add(data.reason, 'error');
                    return false;
                }
            } catch (e) {
                Alpine.store('toasts').add('Failed to add mod: ' + e.message, 'error');
                return false;
            }
        }
    }));

    Alpine.data('modList', () => ({
        buildId: {{ $build->id }},
        savingAll: false,
        filter: '',
        mods: @js($build->modversions->sortBy(fn($v) => strtolower($v->mod->pretty_name ?: $v->mod->name))->values()->map(fn($v) => [
            'mod_id' => $v->mod->id,
            'mod_name' => $v->mod->name,
            'pretty_name' => $v->mod->pretty_name ?: $v->mod->name,
            'modversion_id' => $v->pivot->modversion_id,
            'versions' => $v->mod->versions->map(fn($ver) => ['id' => $ver->id, 'version' => $ver->version]),
        ])).map(m => ({ ...m, selected_version_id: String(m.modversion_id), just_added: false, changing: false })),

        get filteredMods() {
            const query = this.filter.trim().toLowerCase();

            if (query === '') {
                return this.mods;
            }

            return this.mods.filter(mod => {
                const selectedVersion = mod.versions.find(version =>
                    String(version.id) === String(mod.selected_version_id)
                )?.version ?? '';

                return mod.pretty_name.toLowerCase().includes(query)
                    || mod.mod_name.toLowerCase().includes(query)
                    || selectedVersion.toLowerCase().includes(query);
            });
        },

        get pendingMods() {
            return this.mods.filter(m => String(m.selected_version_id) !== String(m.modversion_id));
        },

        async saveAll() {
            if (this.pendingMods.length === 0) return;
            this.savingAll = true;
            try {
                const changes = this.pendingMods.map(m => ({
                    old_modversion_id: m.modversion_id,
                    new_modversion_id: m.selected_version_id,
                }));
                const res = await fetch('{{ url("modpack/modify/batch-version") }}', {
                    method: 'POST',
                    headers: {
                        'X-Requested-With': 'XMLHttpRequest',
                        'Accept': 'application/json',
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        _token: window.csrfToken,
                        build_id: String(this.buildId),
                        changes: changes,
                    }),
                });
                const data = await res.json();
                if (data.status === 'success') {
                    this.pendingMods.forEach(m => m.modversion_id = m.selected_version_id);
                    Alpine.store('toasts').add(data.updated + ' mod version(s) updated', 'success');
                } else {
                    Alpine.store('toasts').add('Unable to save all changes', 'warning');
                }
            } catch {
                Alpine.store('toasts').add('Failed to save all changes', 'error');
            }
            this.savingAll = false;
        },

        addMod(detail) {
            this.mods.unshift({
                mod_id: detail.mod_id,
                mod_name: detail.mod_name,
                pretty_name: detail.pretty_name,
                modversion_id: detail.modversion_id,
                selected_version_id: String(detail.modversion_id),
                versions: detail.versions,
                just_added: true,
                changing: false,
            });
        },

        async changeVersion(mod) {
            mod.changing = true;
            try {
                const params = new URLSearchParams();
                params.append('_token', window.csrfToken);
                params.append('build_id', String(this.buildId));
                params.append('modversion_id', String(mod.modversion_id));
                params.append('action', 'version');
                params.append('version', String(mod.selected_version_id));
                const res = await fetch('{{ url("modpack/modify/version") }}', {
                    method: 'POST',
                    headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json' },
                    body: params,
                });
                const data = await res.json();
                if (data.status === 'success') {
                    mod.modversion_id = mod.selected_version_id;
                    Alpine.store('toasts').add('Mod version updated', 'success');
                } else if (data.status === 'aborted') {
                    Alpine.store('toasts').add('Mod was already set to that version', 'success');
                } else {
                    Alpine.store('toasts').add('Unable to update mod version', 'warning');
                }
            } catch {
                Alpine.store('toasts').add('Failed to update mod version', 'error');
            }
            mod.changing = false;
        },

        async removeMod(mod) {
            try {
                const params = new URLSearchParams();
                params.append('_token', window.csrfToken);
                params.append('build_id', String(this.buildId));
                params.append('modversion_id', String(mod.modversion_id));
                params.append('action', 'delete');
                const res = await fetch('{{ url("modpack/modify/delete") }}', {
                    method: 'POST',
                    headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json' },
                    body: params,
                });
                const data = await res.json();
                if (data.status === 'success') {
                    Alpine.store('toasts').add('Mod version removed', 'success');
                    this.mods = this.mods.filter(m => m !== mod);
                    this.$dispatch('mod-removed', { mod_name: mod.mod_name });
                } else {
                    Alpine.store('toasts').add('Unable to remove mod version', 'warning');
                }
            } catch {
                Alpine.store('toasts').add('Failed to remove mod version', 'error');
            }
        },
    }));
});
</script>
@endpush
