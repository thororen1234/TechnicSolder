@extends('layouts.master')

@section('title')
    <title>Import Mods - Technic Solder</title>
@stop

@section('content')
    @php
        $loaderProviders = ['fabric', 'quilt', 'forge', 'neoforge'];
        $isLoaderProvider = in_array($provider, $loaderProviders);
        $filters = array_filter(['provider' => $provider, 'query' => $query, 'game_version' => $gameVersion, 'release_type' => $releaseType, 'loader' => $loader]);
        $baseUrl = url('mod/import').'?'.http_build_query($filters);
        $detailsQuery = http_build_query(array_filter(['game_version' => $gameVersion, 'loader' => $isLoaderProvider ? '' : $loader]));
    @endphp

    <div class="page-header">
        <div>
            <h1 class="page-title">Import mods</h1>
            <p class="page-subtitle">Pull mods from Modrinth or CurseForge, or add a mod loader to your library.</p>
        </div>
    </div>

    @if ($errors->any())
        <div class="ui-alert ui-alert-danger mb-6 p-4 space-y-1">
            @foreach ($errors->all() as $error)
                <p>{{ $error }}</p>
            @endforeach
        </div>
    @endif

    @session('success')
        <div class="ui-alert ui-alert-success mb-6 p-4">{{ $value }}</div>
    @endsession

    {{-- Search --}}
    <form method="GET" action="{{ url('mod/import') }}" class="ui-card p-4 mb-6"
          x-data="{
              source: @js($isLoaderProvider ? 'loader' : $provider),
              loaderProvider: @js($isLoaderProvider ? $provider : 'fabric'),
              get provider() { return this.source === 'loader' ? this.loaderProvider : this.source },
          }">
        <input type="hidden" name="provider" :value="provider" value="{{ $provider }}">
        <div class="flex flex-wrap items-end gap-3">
            <div class="w-full sm:w-auto">
                <label for="inputSource" class="ui-label">Source</label>
                <select id="inputSource" x-model="source" class="ui-control sm:w-40">
                    <option value="modrinth">Modrinth</option>
                    <option value="curseforge">CurseForge</option>
                    <option value="loader">Mod loader</option>
                </select>
            </div>

            <div class="w-full sm:w-auto" x-show="source === 'loader'" @if (! $isLoaderProvider) x-cloak @endif>
                <label for="inputLoaderProvider" class="ui-label">Loader</label>
                <select id="inputLoaderProvider" x-model="loaderProvider" class="ui-control sm:w-36">
                    <option value="fabric">Fabric</option>
                    <option value="quilt">Quilt</option>
                    <option value="forge">Forge</option>
                    <option value="neoforge">NeoForge</option>
                </select>
            </div>

            <div class="flex-1 min-w-48">
                <label for="inputSearch" class="ui-label" x-text="source === 'loader' ? 'Minecraft version' : 'Search'">Search</label>
                <input type="text" id="inputSearch" name="query" value="{{ $query }}"
                       :placeholder="source === 'loader' ? 'e.g. 1.20.1 or 26.1' : 'Mod name'"
                       class="ui-control">
            </div>

            <div class="w-[calc(50%-0.375rem)] sm:w-36" x-show="source !== 'loader'">
                <label for="inputGameVersion" class="ui-label">Minecraft</label>
                <input type="text" id="inputGameVersion" name="game_version" value="{{ $gameVersion }}" placeholder="Any" class="ui-control"
                       :disabled="source === 'loader'">
            </div>

            <div class="w-[calc(50%-0.375rem)] sm:w-36" x-show="source !== 'loader'">
                <label for="inputLoader" class="ui-label">Mod loader</label>
                <select id="inputLoader" name="loader" class="ui-control" :disabled="source === 'loader'">
                    @foreach (['' => 'Any', 'fabric' => 'Fabric', 'quilt' => 'Quilt', 'forge' => 'Forge', 'neoforge' => 'NeoForge'] as $value => $label)
                        <option value="{{ $value }}" @selected($loader === $value)>{{ $label }}</option>
                    @endforeach
                </select>
            </div>

            <div class="w-[calc(50%-0.375rem)] sm:w-32">
                <label for="inputReleaseType" class="ui-label">Channel</label>
                <select id="inputReleaseType" name="release_type" class="ui-control">
                    @foreach (['release' => 'Release', 'beta' => 'Beta', 'alpha' => 'Alpha', 'any' => 'Any'] as $value => $label)
                        <option value="{{ $value }}" @selected($releaseType === $value)>{{ $label }}</option>
                    @endforeach
                </select>
            </div>

            <button type="submit" class="ui-btn ui-btn-primary">
                <svg class="size-4" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"/></svg>
                Search
            </button>
        </div>
    </form>

    {{-- Results --}}
    <form method="POST" action="{{ route('mod.import_batch') }}"
          x-data="{ selected: [], submitting: false }" @submit="submitting = true">
        @csrf
        <input type="hidden" name="provider" value="{{ $provider }}">
        <input type="hidden" name="game_version" value="{{ $isLoaderProvider ? '' : $gameVersion }}">
        <input type="hidden" name="release_type" value="{{ $releaseType }}">
        <input type="hidden" name="loader" value="{{ $isLoaderProvider ? '' : $loader }}">

        <section class="ui-card overflow-hidden">
            <div class="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-gray-200 dark:border-gray-800">
                <h2 class="section-title">
                    {{ number_format($pagination->totalItems) }} {{ Str::plural('result', $pagination->totalItems) }}
                </h2>
                <div class="flex items-center gap-3" x-show="selected.length" x-cloak>
                    <span class="text-xs text-gray-500">
                        Imports the newest {{ $releaseType !== 'any' ? $releaseType : '' }}
                        version{{ ! $isLoaderProvider && $gameVersion !== '' ? ' for '.$gameVersion : '' }}
                    </span>
                    <button type="submit" class="ui-btn ui-btn-sm ui-btn-primary-solid" :disabled="submitting">
                        <span x-text="submitting ? 'Importing…' : 'Import ' + selected.length + ' selected'"></span>
                    </button>
                </div>
            </div>

            @if (empty($mods))
                <p class="px-5 py-14 text-center text-sm text-gray-500">
                    No results. Try a different search or source.
                </p>
            @else
                <div class="overflow-x-auto">
                    <table class="w-full text-sm">
                        <thead>
                            <tr class="ui-table-head">
                                <th class="pl-5 pr-2 py-3 w-8">
                                    <input type="checkbox" class="ui-checkbox" aria-label="Select all"
                                           @change="selected = $event.target.checked ? @js(collect($mods)->pluck('id')->map(fn ($id) => (string) $id)->values()) : []"
                                           :checked="selected.length === {{ count($mods) }}">
                                </th>
                                <th class="px-3 py-3">{{ $isLoaderProvider ? 'Loader' : 'Mod' }}</th>
                                <th class="px-3 py-3 hidden md:table-cell">Author</th>
                                <th class="px-5 py-3"><span class="sr-only">Actions</span></th>
                            </tr>
                        </thead>
                        <tbody class="ui-table-body">
                            @foreach ($mods as $mod)
                                <tr class="hover:bg-gray-50 dark:hover:bg-gray-900/50">
                                    <td class="pl-5 pr-2 py-3">
                                        <input type="checkbox" name="mods[]" value="{{ $mod->id }}" x-model="selected" class="ui-checkbox"
                                               aria-label="Select {{ $mod->displayName ?? $mod->name }}">
                                    </td>
                                    <td class="px-3 py-3">
                                        <div class="flex items-center gap-3 min-w-0">
                                            @if (! empty($mod->thumbnailUrl))
                                                <img src="{{ $mod->thumbnailUrl }}" alt="" class="size-9 shrink-0 rounded-lg border border-gray-200 dark:border-gray-800 object-contain bg-white dark:bg-gray-900" loading="lazy">
                                            @else
                                                <span class="size-9 shrink-0 rounded-lg border border-gray-200 dark:border-gray-800"></span>
                                            @endif
                                            <div class="min-w-0">
                                                <p class="font-medium text-gray-950 dark:text-white truncate">{{ $mod->displayName ?? $mod->name }}</p>
                                                <p class="text-xs text-gray-500 line-clamp-1 max-w-xl">{{ $mod->displaySummary ?? $mod->summary }}</p>
                                            </div>
                                        </div>
                                    </td>
                                    <td class="px-3 py-3 text-gray-600 dark:text-gray-400 hidden md:table-cell whitespace-nowrap">
                                        @if (! empty($mod->websiteUrl))
                                            <a href="{{ $mod->websiteUrl }}" target="_blank" rel="noopener noreferrer" class="hover:text-gray-950 dark:hover:text-white">{{ $mod->authors }} ↗</a>
                                        @else
                                            {{ $mod->authors }}
                                        @endif
                                    </td>
                                    <td class="px-5 py-3 text-right">
                                        <a href="{{ url('mod/import/details/'.$provider.'/'.$mod->id) }}{{ $detailsQuery ? '?'.$detailsQuery : '' }}"
                                           class="ui-btn ui-btn-sm ui-btn-secondary">Choose versions</a>
                                    </td>
                                </tr>
                            @endforeach
                        </tbody>
                    </table>
                </div>

                @if ($pagination->totalPages > 1)
                    <div class="flex items-center justify-between gap-3 px-5 py-3 border-t border-gray-200 dark:border-gray-800 text-sm text-gray-500">
                        <span>Page {{ number_format($pagination->currentPage) }} of {{ number_format($pagination->totalPages) }}</span>
                        <div class="flex items-center gap-1">
                            <a href="{{ $baseUrl.'&page='.($pagination->currentPage - 1) }}" @class(['ui-page-btn', 'pointer-events-none opacity-40' => $pagination->currentPage <= 1]) aria-label="Previous page">
                                <svg class="size-4" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5"/></svg>
                            </a>
                            <a href="{{ $baseUrl.'&page='.($pagination->currentPage + 1) }}" @class(['ui-page-btn', 'pointer-events-none opacity-40' => $pagination->currentPage >= $pagination->totalPages]) aria-label="Next page">
                                <svg class="size-4" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5"/></svg>
                            </a>
                        </div>
                    </div>
                @endif
            @endif
        </section>
    </form>
@endsection
