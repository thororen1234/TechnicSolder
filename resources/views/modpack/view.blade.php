@extends('layouts.master')
@section('title')
    <title>{{ $modpack->name }} - Technic Solder</title>
@stop
@section('content')
    <div x-data="buildManager()">
        <div class="page-header">
            <div class="flex items-center gap-4 min-w-0">
                <img src="{{ $modpack->icon_url ?? asset('/resources/default/icon.png') }}" alt="" class="size-14 shrink-0 rounded-2xl border border-gray-200 dark:border-gray-800 object-cover">
                <div class="min-w-0">
                    <h1 class="page-title truncate">{{ $modpack->name }}</h1>
                    <div class="mt-1 flex items-center gap-2 flex-wrap">
                        <span class="font-mono text-xs text-gray-500">{{ $modpack->slug }}</span>
                        @if ($modpack->hidden)
                            <span class="ui-badge ui-badge-warning"><x-icons.eye-slash class="size-3" /> Hidden</span>
                        @endif
                        @if ($modpack->private)
                            <span class="ui-badge"><x-icons.lock-closed class="size-3" /> Private</span>
                        @endif
                    </div>
                </div>
            </div>
            <div class="flex items-center gap-2 shrink-0">
                <a href="{{ route('modpack.export', ['modpack_id' => $modpack->id]) }}" class="ui-btn ui-btn-secondary"
                   title="Download a JSON backup of this modpack and all its builds, for restoring with Import">Back up</a>
                <a href="{{ route('modpack.import', ['modpack' => $modpack->id]) }}" class="ui-btn ui-btn-secondary"
                   title="Add a CurseForge or Modrinth pack as a build of this modpack">Import build</a>
                <a href="{{ url('modpack/edit/'.$modpack->id) }}" class="ui-btn ui-btn-secondary">Edit</a>
                @can('create', App\Models\Modpack::class)
                    <a href="{{ url('modpack/clone/'.$modpack->id) }}" class="ui-btn ui-btn-secondary">Clone</a>
                @endcan
                <a href="{{ url('modpack/add-build/'.$modpack->id) }}" class="ui-btn ui-btn-primary">
                    <svg class="size-4" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15"/></svg>
                    New build
                </a>
            </div>
        </div>

        @session('success')
            <div class="ui-alert ui-alert-success mb-6 p-4">
                {{ $value }}
            </div>
        @endsession

        {{-- Stats --}}
        <div class="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-8">
            <div class="ui-stat">
                <p class="ui-stat-label">Builds</p>
                <p class="ui-stat-value">{{ $modpack->builds->count() }}</p>
            </div>
            <div class="ui-stat">
                <p class="ui-stat-label">Recommended</p>
                <p class="ui-stat-value font-mono text-xl" x-text="recommended || '-'">{{ $modpack->recommended ?: '-' }}</p>
            </div>
            <div class="ui-stat">
                <p class="ui-stat-label">Latest</p>
                <p class="ui-stat-value font-mono text-xl" x-text="latest || '-'">{{ $modpack->latest ?: '-' }}</p>
            </div>
            <div class="ui-stat">
                <p class="ui-stat-label">Visibility</p>
                <p class="ui-stat-value text-xl">
                    @if ($modpack->private)
                        Private
                    @elseif ($modpack->hidden)
                        Hidden
                    @else
                        Public
                    @endif
                </p>
            </div>
            <div class="ui-stat col-span-2 lg:col-span-1" title="Times the launcher fetched one of this modpack's builds">
                <p class="ui-stat-label">Launches (30 days)</p>
                <p class="ui-stat-value">{{ number_format(array_sum($launches)) }}</p>
            </div>
        </div>

        <section class="ui-card overflow-hidden"
                 x-data="dataTable({
                     rows: @js($modpack->builds->map(fn($b) => [
                         'id' => $b->id,
                         'version' => $b->version,
                         'minecraft' => $b->minecraft,
                         'mod_count' => $b->modversions_count,
                         'launches' => $launches[$b->id] ?? 0,
                         'is_published' => $b->is_published,
                         'private' => $b->private,
                         'created_at' => $b->created_at->toIso8601String(),
                         'created_at_display' => $b->created_at->format('M j, Y'),
                     ])->values()),
                     sortKey: 'id', sortDir: 'desc', tableName: 'modpack-builds',
                     types: { id: 'number', mod_count: 'number', launches: 'number', created_at: 'date' }
                 })">
            <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-5 py-3.5 border-b border-gray-200 dark:border-gray-800">
                <h2 class="section-title">Builds</h2>
                <div class="relative sm:w-64">
                    <svg class="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-gray-400 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"/></svg>
                    <input type="text" x-model.debounce.150ms="search" placeholder="Filter builds…" class="ui-control py-1.5 pl-9">
                </div>
            </div>

            <div class="overflow-x-auto">
                <table class="w-full text-sm">
                    <thead>
                        <tr class="ui-table-head">
                            @include('partial.data-table.sort-header', ['key' => 'version', 'label' => 'Build'])
                            <th class="px-5 py-3 hidden md:table-cell cursor-pointer select-none" @click="sort('minecraft')">Minecraft <span x-show="sortKey === 'minecraft'" x-text="sortDir === 'asc' ? '↑' : '↓'"></span></th>
                            <th class="px-5 py-3 hidden lg:table-cell cursor-pointer select-none" @click="sort('mod_count')">Mods <span x-show="sortKey === 'mod_count'" x-text="sortDir === 'asc' ? '↑' : '↓'"></span></th>
                            <th class="px-5 py-3 hidden xl:table-cell cursor-pointer select-none" @click="sort('launches')" title="Launcher requests in the last 30 days">Launches <span x-show="sortKey === 'launches'" x-text="sortDir === 'asc' ? '↑' : '↓'"></span></th>
                            <th class="px-3 py-3 text-center" title="Recommended build">Rec</th>
                            <th class="px-3 py-3 text-center" title="Latest build">Latest</th>
                            <th class="px-3 py-3 hidden sm:table-cell">Published</th>
                            <th class="px-3 py-3 hidden md:table-cell">Private</th>
                            <th class="px-5 py-3 hidden lg:table-cell cursor-pointer select-none" @click="sort('created_at')">Created <span x-show="sortKey === 'created_at'" x-text="sortDir === 'asc' ? '↑' : '↓'"></span></th>
                            <th class="px-5 py-3"><span class="sr-only">Actions</span></th>
                        </tr>
                    </thead>
                    <tbody class="ui-table-body">
                        <template x-for="row in paged" :key="row.id">
                            <tr class="hover:bg-gray-50 dark:hover:bg-gray-900/50">
                                <td class="px-5 py-3">
                                    <div class="flex items-center gap-2">
                                        <a :href="'/modpack/build/' + row.id" class="font-mono font-medium text-gray-950 dark:text-white hover:underline underline-offset-2" x-text="row.version"></a>
                                        <span x-show="row.version === recommended" class="ui-badge ui-badge-success">Recommended</span>
                                        <span x-show="row.version === latest" class="ui-badge ui-badge-primary">Latest</span>
                                    </div>
                                </td>
                                <td class="px-5 py-3 text-gray-600 dark:text-gray-400 hidden md:table-cell" x-text="row.minecraft"></td>
                                <td class="px-5 py-3 text-gray-600 dark:text-gray-400 hidden lg:table-cell tabular-nums" x-text="row.mod_count"></td>
                                <td class="px-5 py-3 text-gray-600 dark:text-gray-400 hidden xl:table-cell tabular-nums" x-text="row.launches.toLocaleString()"></td>
                                <td class="px-3 py-3 text-center">
                                    <input autocomplete="off" type="radio" name="recommended"
                                           :value="row.version"
                                           :checked="row.version === recommended"
                                           @change="setRecommended($event.target.value)"
                                           :aria-label="'Set ' + row.version + ' as recommended'"
                                           class="text-blue-600 focus:ring-blue-500/30 border-gray-300 dark:border-gray-700 dark:bg-gray-950 cursor-pointer">
                                </td>
                                <td class="px-3 py-3 text-center">
                                    <input autocomplete="off" type="radio" name="latest"
                                           :value="row.version"
                                           :checked="row.version === latest"
                                           @change="setLatest($event.target.value)"
                                           :aria-label="'Set ' + row.version + ' as latest'"
                                           class="text-blue-600 focus:ring-blue-500/30 border-gray-300 dark:border-gray-700 dark:bg-gray-950 cursor-pointer">
                                </td>
                                <td class="px-3 py-3 hidden sm:table-cell">
                                    <input autocomplete="off" type="checkbox" class="ui-switch"
                                           :checked="row.is_published"
                                           @change="togglePublished(row.id, $event.target.checked, $event.target)"
                                           :aria-label="'Published: ' + row.version">
                                </td>
                                <td class="px-3 py-3 hidden md:table-cell">
                                    <input autocomplete="off" type="checkbox" class="ui-switch"
                                           :checked="row.private"
                                           @change="togglePrivate(row.id, $event.target.checked)"
                                           :aria-label="'Private: ' + row.version">
                                </td>
                                <td class="px-5 py-3 text-gray-500 hidden lg:table-cell whitespace-nowrap" x-text="row.created_at_display"></td>
                                <td class="px-5 py-3">
                                    <div class="flex items-center justify-end gap-1">
                                        <a :href="'/modpack/build/' + row.id" class="ui-btn ui-btn-sm ui-btn-secondary">Open</a>
                                        <a :href="'/modpack/build/' + row.id + '/edit'" class="ui-btn-ghost ui-btn-icon" :aria-label="'Edit ' + row.version" title="Edit">
                                            <svg class="size-4" fill="none" viewBox="0 0 24 24" stroke-width="1.75" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125"/></svg>
                                        </a>
                                        <a :href="'/modpack/build/' + row.id + '/delete'" class="ui-btn-ghost ui-btn-icon hover:text-red-600! dark:hover:text-red-400!" :aria-label="'Delete ' + row.version" title="Delete">
                                            <svg class="size-4" fill="none" viewBox="0 0 24 24" stroke-width="1.75" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"/></svg>
                                        </a>
                                    </div>
                                </td>
                            </tr>
                        </template>
                        <template x-if="totalFiltered === 0">
                            <tr>
                                <td colspan="10" class="px-5 py-14 text-center">
                                    <template x-if="totalRows === 0">
                                        <div>
                                            <p class="text-sm font-medium text-gray-950 dark:text-white">No builds yet</p>
                                            <p class="mt-1 text-sm text-gray-500">Builds are the versions of this modpack that launchers install.</p>
                                            <a href="{{ url('modpack/add-build/'.$modpack->id) }}" class="ui-btn ui-btn-secondary mt-4">Create the first build</a>
                                        </div>
                                    </template>
                                    <template x-if="totalRows > 0">
                                        <p class="text-sm text-gray-500">No builds match “<span x-text="search"></span>”.</p>
                                    </template>
                                </td>
                            </tr>
                        </template>
                    </tbody>
                </table>
            </div>

            <div class="px-5 pb-4" x-show="totalPages > 1">
                @include('partial.data-table.pagination')
            </div>
        </section>

        @if ($imports->isNotEmpty())
            <section class="ui-card overflow-hidden mt-6">
                <div class="ui-card-header">
                    <h2 class="section-title">Imports</h2>
                </div>
                <ul class="divide-y divide-gray-100 dark:divide-gray-900">
                    @foreach ($imports as $import)
                        <li>
                            <a href="{{ route('modpack.import.show', $import->id) }}" class="flex items-center justify-between gap-3 px-5 py-3 text-sm hover:bg-gray-50 dark:hover:bg-gray-900/50">
                                <span class="min-w-0">
                                    <span class="block truncate text-gray-950 dark:text-white">
                                        <span class="font-mono">{{ $import->build?->version ?? $import->build_version ?? '-' }}</span>
                                        <span class="text-gray-500">from {{ $import->source }}</span>
                                    </span>
                                    <span class="block text-xs text-gray-500">
                                        {{ $import->imported }} mod(s) imported · <time datetime="{{ $import->created_at->toIso8601String() }}">{{ $import->created_at->diffForHumans() }}</time>
                                    </span>
                                </span>
                                <x-import-status :import="$import" />
                            </a>
                        </li>
                    @endforeach
                </ul>
            </section>
        @endif

        <section class="ui-card overflow-hidden mt-6">
            <div class="ui-card-header flex items-center justify-between">
                <h2 class="section-title">Recent activity</h2>
                <a href="{{ route('solder.activity', ['modpack' => $modpack->id]) }}" class="text-xs text-gray-500 hover:text-gray-950 dark:hover:text-white">All activity →</a>
            </div>
            @include('partial.activity-list', ['entries' => $activity, 'empty' => 'No changes recorded yet.'])
        </section>
    </div>
@endsection
@push('scripts')
    <script>
        function buildManager() {
            return {
                modpackId: {{ $modpack->id }},
                recommended: @js($modpack->recommended),
                latest: @js($modpack->latest),

                async setRecommended(version) {
                    try {
                        const data = await window.ajaxPost(
                            `{{ url('modpack/modify/recommended') }}?modpack=${this.modpackId}&recommended=${encodeURIComponent(version)}`
                        );
                        this.recommended = version;
                        Alpine.store('toasts').add(data.success, 'success');
                    } catch (error) {
                        Alpine.store('toasts').add(error.message || 'An unknown error occurred', 'error');
                    }
                },

                async setLatest(version) {
                    try {
                        const data = await window.ajaxPost(
                            `{{ url('modpack/modify/latest') }}?modpack=${this.modpackId}&latest=${encodeURIComponent(version)}`
                        );
                        this.latest = version;
                        Alpine.store('toasts').add(data.success, 'success');
                    } catch (error) {
                        Alpine.store('toasts').add(error.message || 'An unknown error occurred', 'error');
                    }
                },

                async togglePublished(buildId, checked, input = null, force = false) {
                    try {
                        const data = await window.ajaxPost(
                            `{{ url('modpack/modify/published') }}?build=${buildId}&published=${checked ? 1 : 0}${force ? '&force=1' : ''}`
                        );

                        // The health check found problems: confirm before publishing anyway
                        if (data.status === 'blocked') {
                            const details = data.issues.map(issue => '- ' + issue).join('\n');
                            if (confirm(`${data.reason}\n\n${details}\n\nPublish anyway?`)) {
                                return this.togglePublished(buildId, checked, input, true);
                            }
                            if (input) input.checked = false;
                            Alpine.store('toasts').add('Build was not published', 'warning');
                            return;
                        }

                        Alpine.store('toasts').add(data.success, 'success');
                    } catch (error) {
                        Alpine.store('toasts').add(error.message || 'An unknown error occurred', 'error');
                    }
                },

                async togglePrivate(buildId, checked) {
                    try {
                        const data = await window.ajaxPost(
                            `{{ url('modpack/modify/private') }}?build=${buildId}&private=${checked ? 1 : 0}`
                        );
                        Alpine.store('toasts').add(data.success, 'success');
                    } catch (error) {
                        Alpine.store('toasts').add(error.message || 'An unknown error occurred', 'error');
                    }
                }
            };
        }
    </script>
@endpush
