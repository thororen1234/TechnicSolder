@extends('layouts.master')

@section('title')
    <title>{{ $mod->displayName ?? $mod->name }} - Import - Technic Solder</title>
@stop

@section('content')
    <div class="page-header">
        <div class="flex items-center gap-4 min-w-0">
            @if (! empty($mod->thumbnailUrl))
                <img src="{{ $mod->thumbnailUrl }}" alt="" class="size-14 shrink-0 rounded-2xl border border-gray-200 dark:border-gray-800 object-contain bg-white dark:bg-gray-900">
            @endif
            <div class="min-w-0">
                <h1 class="page-title truncate">{{ $mod->displayName ?? $mod->name }}</h1>
                <p class="page-subtitle line-clamp-2">{{ $mod->displaySummary ?? $mod->summary }}</p>
                <p class="mt-1 text-xs text-gray-500">
                    {{ $providerName }} · {{ $mod->authors }}
                    @if (! empty($mod->websiteUrl))
                        · <a href="{{ $mod->websiteUrl }}" target="_blank" rel="noopener noreferrer" class="hover:text-gray-950 dark:hover:text-white">Website ↗</a>
                    @endif
                </p>
            </div>
        </div>
        <a href="{{ url()->previous() }}" class="ui-btn ui-btn-secondary shrink-0">Back</a>
    </div>

    @if ($errors->any())
        <div class="ui-alert ui-alert-danger mb-6 p-4 space-y-1">
            @foreach ($errors->all() as $error)
                <p>{{ $error }}</p>
            @endforeach
        </div>
    @endif

    <form method="POST"
          x-data="Object.assign(dataTable({
              rows: @js(collect($mod->versions)->map(fn ($version, $key) => [
                  'key' => base64_encode((string) $key),
                  'label' => $version->label ?? (string) $key,
                  'filename' => $version->filename ?? '',
                  'game_versions' => implode(', ', (array) ($version->gameVersions ?? [])),
                  'loaders' => implode(', ', (array) ($version->loaders ?? [])),
                  'type' => $version->versionType ?? 'release',
                  'downloadable' => ! empty($version->url),
              ])->values()),
              pageSize: 25,
              searchKeys: ['label', 'filename', 'game_versions', 'loaders', 'type'],
          }), { selected: [], submitting: false })"
          @submit="submitting = true">
        @csrf
        <input type="hidden" name="game_version" value="{{ $gameVersion }}">
        <input type="hidden" name="loader" value="{{ $loader }}">
        <template x-for="key in selected" :key="key">
            <input type="hidden" name="versions[]" :value="key">
        </template>

        <section class="ui-card overflow-hidden">
            <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-5 py-3.5 border-b border-gray-200 dark:border-gray-800">
                <div class="relative sm:w-80">
                    <svg class="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-gray-400 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"/></svg>
                    <input type="text" x-model.debounce.150ms="search" placeholder="Filter by version, Minecraft, loader…" class="ui-control py-1.5 pl-9">
                </div>
                <div class="flex items-center gap-3">
                    <span class="text-xs text-gray-500" x-text="selected.length ? selected.length + ' selected' : 'Select versions to import'"></span>
                    @if (in_array($provider, ['modrinth', 'curseforge']))
                        <label class="flex items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300 whitespace-nowrap">
                            <input type="checkbox" name="with_dependencies" value="1" checked class="ui-checkbox">
                            Also import required mods
                        </label>
                    @endif
                    <button type="submit" class="ui-btn ui-btn-primary-solid" :disabled="!selected.length || submitting"
                            x-text="submitting ? 'Importing…' : 'Import'">Import</button>
                </div>
            </div>

            @if (! empty($gameVersion) || ! empty($loader))
                <p class="px-5 py-2 text-xs text-gray-500 border-b border-gray-100 dark:border-gray-900">
                    Showing files for {{ collect([$gameVersion ? 'Minecraft '.$gameVersion : null, $loader ? ucfirst($loader) : null])->filter()->implode(' · ') }}.
                </p>
            @endif

            <div class="overflow-x-auto">
                <table class="w-full text-sm">
                    <thead>
                        <tr class="ui-table-head">
                            <th class="pl-5 pr-2 py-3 w-8"><span class="sr-only">Select</span></th>
                            <th class="px-3 py-3">Version</th>
                            <th class="px-3 py-3 hidden md:table-cell">Minecraft</th>
                            <th class="px-3 py-3 hidden lg:table-cell">Loaders</th>
                            <th class="px-5 py-3 hidden sm:table-cell">File</th>
                        </tr>
                    </thead>
                    <tbody class="ui-table-body">
                        <template x-for="row in paged" :key="row.key">
                            <tr class="hover:bg-gray-50 dark:hover:bg-gray-900/50" :class="!row.downloadable && 'opacity-50'">
                                <td class="pl-5 pr-2 py-2.5">
                                    <input type="checkbox" class="ui-checkbox" :value="row.key" x-model="selected"
                                           :disabled="!row.downloadable" :aria-label="'Select ' + row.label">
                                </td>
                                <td class="px-3 py-2.5">
                                    <div class="flex items-center gap-2">
                                        <span class="font-mono text-gray-950 dark:text-white" x-text="row.label"></span>
                                        <span x-show="row.type !== 'release'" class="ui-badge ui-badge-warning" x-text="row.type"></span>
                                        <span x-show="!row.downloadable" class="ui-badge" title="The author disabled third-party downloads">No download</span>
                                    </div>
                                </td>
                                <td class="px-3 py-2.5 text-gray-600 dark:text-gray-400 hidden md:table-cell max-w-56 truncate" x-text="row.game_versions || '-'"></td>
                                <td class="px-3 py-2.5 text-gray-600 dark:text-gray-400 hidden lg:table-cell capitalize" x-text="row.loaders || '-'"></td>
                                <td class="px-5 py-2.5 font-mono text-xs text-gray-500 hidden sm:table-cell max-w-72 truncate" x-text="row.filename"></td>
                            </tr>
                        </template>
                        <template x-if="totalFiltered === 0">
                            <tr>
                                <td colspan="5" class="px-5 py-12 text-center text-sm text-gray-500" x-text="totalRows ? 'No versions match.' : 'This mod has no downloadable versions.'"></td>
                            </tr>
                        </template>
                    </tbody>
                </table>
            </div>

            <div class="px-5 pb-4" x-show="totalPages > 1">
                @include('partial.data-table.pagination')
            </div>
        </section>
    </form>
@endsection
