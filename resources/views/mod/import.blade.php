@extends('layouts.master')

@section('title')
    <title>Import Mod - Technic Solder</title>
@stop

@section('content')
    <div class="mb-6">
        <h1 class="text-2xl font-bold">Mod Library</h1>
    </div>

    <div class="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-800">
        <div class="px-5 py-4 border-b border-gray-200 dark:border-gray-800">
            <h2 class="text-sm font-semibold text-gray-900 dark:text-gray-100">Import Mod</h2>
        </div>

        <div class="p-5">

            @if ($errors->any())
                <div class="mb-4 p-4 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
                    @foreach ($errors->all() as $error)
                        <p class="text-sm text-red-700 dark:text-red-300">{{ $error }}</p>
                    @endforeach
                </div>
            @endif

            @if (session('success'))
                <div class="mb-4 p-4 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800">
                    <p class="text-sm text-green-700 dark:text-green-300">{{ session('success') }}</p>
                </div>
            @endif

            {{-- SEARCH FORM --}}
            <form method="GET" id="searchForm" class="flex flex-wrap gap-2 mb-5">
                <input
                    type="text"
                    id="inputSearch"
                    name="query"
                    placeholder="Mod name"
                    value="{{ $query }}"
                    class="flex-1 min-w-40 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm px-3 py-2 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >

                <input
                    type="text"
                    id="inputGameVersion"
                    name="game_version"
                    placeholder="Minecraft version"
                    value="{{ $gameVersion }}"
                    class="w-44 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm px-3 py-2 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >

                <select
                    id="inputLoader"
                    name="loader"
                    class="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm px-3 py-2 text-gray-900 dark:text-gray-100"
                >
                    @foreach (['' => 'Any Loader', 'fabric' => 'Fabric', 'quilt' => 'Quilt', 'forge' => 'Forge', 'neoforge' => 'NeoForge'] as $value => $label)
                        <option value="{{ $value }}" {{ $loader === $value ? 'selected' : '' }}>{{ $label }}</option>
                    @endforeach
                </select>

                <select
                    id="inputReleaseType"
                    name="release_type"
                    class="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm px-3 py-2 text-gray-900 dark:text-gray-100"
                >
                    @foreach (['release' => 'Release', 'beta' => 'Beta', 'alpha' => 'Alpha', 'any' => 'Any'] as $value => $label)
                        <option value="{{ $value }}" {{ $releaseType === $value ? 'selected' : '' }}>{{ $label }}</option>
                    @endforeach
                </select>

                <select
                    id="inputProvider"
                    name="provider"
                    class="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm px-3 py-2 text-gray-900 dark:text-gray-100"
                >
                    @foreach ($providers as $providerKey => $tmpProvider)
                        <option value="{{ $providerKey }}" {{ $provider == $providerKey ? 'selected' : '' }}>
                            {{ $tmpProvider::name() }}
                        </option>
                    @endforeach
                </select>

                <button
                    type="submit"
                    class="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
                >
                    Search
                </button>
            </form>

            {{-- BATCH IMPORT FORM wraps the results table --}}
            <form method="POST" action="{{ route('mod.import_batch') }}">
                @csrf
                <input type="hidden" name="provider" value="{{ $provider }}">
                <input type="hidden" name="game_version" value="{{ $gameVersion }}">
                <input type="hidden" name="release_type" value="{{ $releaseType }}">
                <input type="hidden" name="loader" value="{{ $loader }}">

                <div class="overflow-x-auto">
                    <table class="w-full text-sm border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
                        <thead class="bg-gray-50 dark:bg-gray-800">
                            <tr>
                                <th class="px-4 py-2 text-center w-8">
                                    <input
                                        type="checkbox"
                                        id="selectAll"
                                        class="rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500"
                                        title="Select all"
                                    >
                                </th>
                                <th class="px-4 py-2 text-left">#</th>
                                <th class="px-4 py-2 text-left">Mod Name</th>
                                <th class="px-4 py-2 text-left">Author</th>
                                <th class="px-4 py-2 text-left">Website</th>
                                <th class="px-4 py-2 text-left">Actions</th>
                            </tr>
                        </thead>

                        <tbody class="divide-y divide-gray-200 dark:divide-gray-800">
                            @foreach ($mods as $mod)
                                <tr>
                                    <td class="px-4 py-2 text-center">
                                        <input
                                            type="checkbox"
                                            name="mods[]"
                                            value="{{ $mod->id }}"
                                            class="mod-checkbox rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500"
                                        >
                                    </td>

                                    <td class="px-4 py-2">
                                        @if (!empty($mod->thumbnailUrl))
                                            <img src="{{ $mod->thumbnailUrl }}" alt="{{ $mod->thumbnailDesc }}" class="h-8 w-8 object-contain">
                                        @endif
                                    </td>

                                    <td class="px-4 py-2">
                                        <p class="font-semibold text-gray-900 dark:text-gray-100">
                                            {{ property_exists($mod, 'displayName') ? $mod->displayName : $mod->name }}
                                        </p>
                                        <p class="text-gray-600 dark:text-gray-400 text-xs">
                                            {{ property_exists($mod, 'displaySummary') ? $mod->displaySummary : $mod->summary }}
                                        </p>
                                    </td>

                                    <td class="px-4 py-2 text-gray-700 dark:text-gray-300">
                                        {{ $mod->authors }}
                                    </td>

                                    <td class="px-4 py-2">
                                        <a href="{{ $mod->websiteUrl }}" target="_blank"
                                           class="text-blue-600 hover:underline text-xs break-all">
                                            {{ $mod->websiteUrl }}
                                        </a>
                                    </td>

                                    <td class="px-4 py-2 whitespace-nowrap">
                                        <a href="{{ url('mod/import/details/'.$provider.'/'.$mod->id) }}"
                                           class="bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200 text-xs font-medium px-3 py-1.5 rounded-md">
                                            Choose Versions
                                        </a>
                                    </td>
                                </tr>
                            @endforeach
                        </tbody>
                    </table>
                </div>

                @if (!empty($mods))
                    <div class="flex items-center gap-3 mt-4">
                        <button
                            type="submit"
                            id="importSelectedBtn"
                            class="bg-green-600 hover:bg-green-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors disabled:opacity-50 disabled:pointer-events-none"
                        >
                            Import Selected
                        </button>
                        <span class="text-xs text-gray-500 dark:text-gray-400">
                            Imports the latest
                            {{ $releaseType !== 'any' ? $releaseType : '' }}
                            @if (!empty($gameVersion))
                                {{ $gameVersion }}
                            @endif
                            version for each selected mod
                        </span>
                    </div>
                @endif
            </form>

            @php
                $baseUrl = url('mod/import') . '?' . http_build_query(array_filter(['provider' => $provider, 'query' => $query, 'game_version' => $gameVersion, 'release_type' => $releaseType, 'loader' => $loader]));
            @endphp

            <div class="flex items-center justify-center gap-3 mt-6 text-sm">
                <a
                    class="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-700 {{ $pagination->currentPage <= 1 ? 'opacity-50 pointer-events-none' : '' }}"
                    href="{{ $pagination->currentPage <= 1 ? '#' : $baseUrl . '&page=' . ($pagination->currentPage - 1) }}"
                >
                    ←
                </a>

                <span class="text-gray-700 dark:text-gray-300">
                    Page {{ number_format($pagination->currentPage) }}
                    of {{ number_format($pagination->totalPages) }}
                    ({{ number_format($pagination->totalItems) }})
                </span>

                <a
                    class="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-700 {{ $pagination->currentPage >= $pagination->totalPages ? 'opacity-50 pointer-events-none' : '' }}"
                    href="{{ $pagination->currentPage >= $pagination->totalPages ? '#' : $baseUrl . '&page=' . ($pagination->currentPage + 1) }}"
                >
                    →
                </a>
            </div>
        </div>
    </div>
@endsection

@push('scripts')
<script>
(function () {
    const selectAll = document.getElementById('selectAll');
    const checkboxes = document.querySelectorAll('.mod-checkbox');

    if (selectAll) {
        selectAll.addEventListener('change', function () {
            checkboxes.forEach(function (cb) {
                cb.checked = selectAll.checked;
            });
        });

        checkboxes.forEach(function (cb) {
            cb.addEventListener('change', function () {
                selectAll.checked = Array.from(checkboxes).every(function (c) { return c.checked; });
                selectAll.indeterminate = !selectAll.checked && Array.from(checkboxes).some(function (c) { return c.checked; });
            });
        });
    }
})();
</script>
@endpush
