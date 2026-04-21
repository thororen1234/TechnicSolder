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

            <form method="GET" id="searchForm" class="flex gap-2 mb-5">
                <input
                    type="text"
                    id="inputSearch"
                    name="query"
                    placeholder="Mod name"
                    value="{{ $query }}"
                    class="flex-1 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm px-3 py-2 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >

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

            <div class="overflow-x-auto">
                <table class="w-full text-sm border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
                    <thead class="bg-gray-50 dark:bg-gray-800">
                        <tr>
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

                                <td class="px-4 py-2">
                                    <a href="{{ url('mod/import/details/'.$provider.'/'.$mod->id) }}"
                                       class="bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium px-3 py-1.5 rounded-md">
                                        Import
                                    </a>
                                </td>
                            </tr>
                        @endforeach
                    </tbody>
                </table>
            </div>

            @php
                $baseUrl = url('mod/import') . '?provider=' . urlencode($provider) . '&query=' . urlencode($query);
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