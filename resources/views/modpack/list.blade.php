@extends('layouts.master')
@section('title')
    <title>Modpacks - Technic Solder</title>
@stop
@section('content')
    <div x-data="dataTable({
        rows: @js($modpacks->map(fn($m) => [
            'id' => $m->id,
            'name' => $m->name,
            'slug' => $m->slug,
            'icon_url' => $m->icon_url ?? asset('/resources/default/icon.png'),
            'recommended' => $m->recommended ?: '',
            'latest' => $m->latest ?: '',
            'hidden' => $m->hidden,
            'private' => $m->private,
        ])->values()),
        sortKey: 'name', tableName: 'modpack-list', pageSize: 24,
        searchKeys: ['name', 'slug', 'recommended', 'latest'],
    })">
        <div class="page-header">
            <div>
                <h1 class="page-title">Modpacks</h1>
                <p class="page-subtitle"><span x-text="totalRows"></span> <span x-text="totalRows === 1 ? 'modpack' : 'modpacks'"></span></p>
            </div>
            <div class="flex items-center gap-2">
                <a href="{{ route('modpack.import') }}" class="ui-btn ui-btn-secondary">Import</a>
                <a href="{{ url('modpack/create') }}" class="ui-btn ui-btn-primary">
                    <svg class="size-4" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15"/></svg>
                    New modpack
                </a>
            </div>
        </div>

        @session('success')
            <div class="ui-alert ui-alert-success mb-6 p-4">
                {{ $value }}
            </div>
        @endsession
        @include('partial.form-errors')

        <div class="flex flex-col sm:flex-row sm:items-center gap-3 mb-5">
            <div class="relative sm:w-80">
                <svg class="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-gray-400 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"/></svg>
                <input type="text" x-model.debounce.150ms="search" placeholder="Filter modpacks…" class="ui-control pl-9">
            </div>
            <div class="flex items-center gap-1 sm:ml-auto text-sm">
                <span class="text-gray-500 mr-1">Sort</span>
                <button type="button" @click="sort('name')" class="ui-btn ui-btn-sm" :class="sortKey === 'name' ? 'ui-btn-secondary' : 'ui-btn-ghost'">
                    Name <span x-show="sortKey === 'name'" x-text="sortDir === 'asc' ? '↑' : '↓'"></span>
                </button>
                <button type="button" @click="sort('id')" class="ui-btn ui-btn-sm" :class="sortKey === 'id' ? 'ui-btn-secondary' : 'ui-btn-ghost'">
                    Created <span x-show="sortKey === 'id'" x-text="sortDir === 'asc' ? '↑' : '↓'"></span>
                </button>
            </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            <template x-for="row in paged" :key="row.id">
                <div class="ui-card relative group p-4 hover:border-gray-300 dark:hover:border-gray-700 transition-colors">
                    <div class="flex items-start gap-3.5">
                        <img :src="row.icon_url" alt="" onerror="this.onerror = null; this.src = '{{ asset('/resources/default/icon.png') }}'" class="size-12 shrink-0 rounded-xl border border-gray-200 dark:border-gray-800 object-cover">
                        <div class="min-w-0 flex-1">
                            <a :href="'/modpack/view/' + row.id" class="block font-medium text-gray-950 dark:text-white truncate after:absolute after:inset-0 after:rounded-xl" x-text="row.name"></a>
                            <p class="mt-0.5 font-mono text-xs text-gray-500 truncate" x-text="row.slug"></p>
                        </div>
                        <div class="relative z-10 -mr-1.5 -mt-1.5" x-data="{ menu: false }" @keydown.escape="menu = false">
                            <button type="button" @click="menu = !menu" @click.outside="menu = false" class="ui-btn-ghost ui-btn-icon" :aria-expanded="menu" :aria-label="'Actions for ' + row.name">
                                <svg class="size-4" fill="currentColor" viewBox="0 0 20 20"><path d="M10 3a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm0 5.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm0 5.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z"/></svg>
                            </button>
                            <div x-show="menu" x-transition.opacity.duration.100ms class="ui-menu absolute right-0 mt-1 w-44 z-20" style="display: none">
                                <a :href="'/modpack/view/' + row.id" class="ui-menu-item">Open</a>
                                <a :href="'/modpack/add-build/' + row.id" class="ui-menu-item">New build</a>
                                <a :href="'/modpack/edit/' + row.id" class="ui-menu-item">Edit details</a>
                                @can('create', App\Models\Modpack::class)
                                    <a :href="'/modpack/clone/' + row.id" class="ui-menu-item">Clone</a>
                                @endcan
                                <div class="my-1 h-px bg-gray-100 dark:bg-gray-900"></div>
                                <a :href="'/modpack/delete/' + row.id" class="ui-menu-item text-red-600! dark:text-red-400! hover:bg-red-50! dark:hover:bg-red-500/10!">Delete</a>
                            </div>
                        </div>
                    </div>

                    <div class="mt-4 flex items-center gap-1.5 flex-wrap text-xs">
                        <span class="ui-badge">
                            <span class="text-gray-500">Rec</span>
                            <span class="font-mono" x-text="row.recommended || '-'"></span>
                        </span>
                        <span class="ui-badge">
                            <span class="text-gray-500">Latest</span>
                            <span class="font-mono" x-text="row.latest || '-'"></span>
                        </span>
                        <template x-if="row.hidden">
                            <span class="ui-badge ui-badge-warning"><x-icons.eye-slash class="size-3" /> Hidden</span>
                        </template>
                        <template x-if="row.private">
                            <span class="ui-badge"><x-icons.lock-closed class="size-3" /> Private</span>
                        </template>
                    </div>
                </div>
            </template>
        </div>

        <template x-if="totalRows === 0">
            <div class="ui-card border-dashed px-6 py-16 text-center">
                <p class="text-sm font-medium text-gray-950 dark:text-white">No modpacks yet</p>
                <p class="mt-1 text-sm text-gray-500">Create one from scratch or import an existing pack.</p>
                <div class="mt-5 flex justify-center gap-2">
                    <a href="{{ route('modpack.import') }}" class="ui-btn ui-btn-secondary">Import</a>
                    <a href="{{ url('modpack/create') }}" class="ui-btn ui-btn-primary">New modpack</a>
                </div>
            </div>
        </template>
        <template x-if="totalRows > 0 && totalFiltered === 0">
            <div class="ui-card border-dashed px-6 py-12 text-center text-sm text-gray-500">
                No modpacks match “<span x-text="search"></span>”.
            </div>
        </template>

        <div x-show="totalPages > 1">
            @include('partial.data-table.pagination')
        </div>
    </div>
@endsection
