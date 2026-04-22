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

            {{-- MOD INFO --}}
            <div class="flex gap-4 mb-6">
                @if (!empty($mod->thumbnailUrl))
                    <div class="shrink-0">
                        <img
                            src="{{ $mod->thumbnailUrl }}"
                            alt="{{ $mod->thumbnailDesc }}"
                            class="h-16 w-16 object-contain rounded-lg border border-gray-200 dark:border-gray-700"
                        >
                    </div>
                @endif

                <div class="flex flex-col gap-1 text-sm">
                    <p class="font-semibold text-gray-900 dark:text-gray-100 text-base">
                        {{ property_exists($mod, 'displayName') ? $mod->displayName : $mod->name }}
                    </p>
                    <p class="text-gray-600 dark:text-gray-400">
                        {{ property_exists($mod, 'displaySummary') ? $mod->displaySummary : $mod->summary }}
                    </p>
                    <p class="text-gray-700 dark:text-gray-300">
                        <span class="font-medium">Author(s):</span> {{ $mod->authors }}
                    </p>
                    @if (!empty($mod->websiteUrl))
                        <a href="{{ $mod->websiteUrl }}" target="_blank" rel="noopener noreferrer"
                           class="text-blue-600 hover:underline text-xs break-all">
                            {{ $mod->websiteUrl }}
                        </a>
                    @endif
                </div>
            </div>

            {{-- IMPORT FORM --}}
            <form method="post">
                @csrf

                <div class="overflow-x-auto">
                    <table class="w-full text-sm border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
                        <thead class="bg-gray-50 dark:bg-gray-800">
                            <tr>
                                <th class="px-4 py-2 text-left w-8">#</th>
                                <th class="px-4 py-2 text-left">Name</th>
                                <th class="px-4 py-2 text-left">Filename</th>
                                <th class="px-4 py-2 text-left">MC Versions</th>
                            </tr>
                        </thead>

                        <tbody id="versionsTableBody" class="divide-y divide-gray-200 dark:divide-gray-800">
                            @foreach ($mod->versions as $versionName => $version)
                                <tr class="version-row">
                                    <td class="px-4 py-2 text-center">
                                        <input
                                            type="checkbox"
                                            name="{{ base64_encode($versionName) }}"
                                            class="rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500"
                                        >
                                    </td>

                                    <td class="px-4 py-2 text-gray-900 dark:text-gray-100 font-medium">
                                        {{ $versionName }}
                                    </td>

                                    <td class="px-4 py-2 text-gray-600 dark:text-gray-400 font-mono text-xs">
                                        {{ $version->filename ?? 'unknown' }}
                                    </td>

                                    <td class="px-4 py-2 text-gray-700 dark:text-gray-300">
                                        {{ isset($version->gameVersions) ? implode(', ', $version->gameVersions) : '' }}
                                    </td>
                                </tr>
                            @endforeach
                        </tbody>
                    </table>
                </div>

                {{-- PAGINATION --}}
                <div class="flex items-center justify-center gap-3 mt-6 mb-6 text-sm">
                    <button
                        type="button"
                        id="prevPage"
                        class="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-700 disabled:opacity-50 disabled:pointer-events-none"
                    >
                        ←
                    </button>

                    <span id="pageInfo" class="text-gray-700 dark:text-gray-300"></span>

                    <button
                        type="button"
                        id="nextPage"
                        class="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-700 disabled:opacity-50 disabled:pointer-events-none"
                    >
                        →
                    </button>
                </div>

                <div class="flex gap-2">
                    <button type="submit"
                        class="bg-green-600 hover:bg-green-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
                        Import
                    </button>

                    <a href="{{ url()->previous() }}"
                       class="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
                        Go Back
                    </a>
                </div>
            </form>

        </div>
    </div>
@endsection

@push('scripts')
<script>
(function () {
    const PAGE_SIZE = 20;
    let currentPage = 1;

    const rows = Array.from(document.querySelectorAll('tr.version-row'));
    const totalItems = rows.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));

    const prevBtn  = document.getElementById('prevPage');
    const nextBtn  = document.getElementById('nextPage');
    const pageInfo = document.getElementById('pageInfo');

    function setDisabled(btn, isDisabled) {
        btn.disabled = isDisabled;
        btn.style.opacity = isDisabled ? '0.4' : '';
        btn.style.pointerEvents = isDisabled ? 'none' : '';
    }

    function render() {
        const start = (currentPage - 1) * PAGE_SIZE;
        const end   = start + PAGE_SIZE;

        rows.forEach(function (row, i) {
            row.style.display = (i >= start && i < end) ? '' : 'none';
        });

        pageInfo.textContent =
            'Page ' + currentPage.toLocaleString() +
            ' of ' + totalPages.toLocaleString() +
            ' (' + totalItems.toLocaleString() + ')';

        setDisabled(prevBtn, currentPage <= 1);
        setDisabled(nextBtn, currentPage >= totalPages);
    }

    prevBtn.addEventListener('click', function () {
        if (currentPage > 1) { currentPage--; render(); }
    });

    nextBtn.addEventListener('click', function () {
        if (currentPage < totalPages) { currentPage++; render(); }
    });

    render();
})();
</script>
@endpush