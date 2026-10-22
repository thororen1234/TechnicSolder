@extends('layouts.master')
@section('title')
    <title>Unused Mod Versions - Technic Solder</title>
@stop
@section('content')
    <div class="page-header">
        <div>
            <h1 class="page-title">Unused mod versions</h1>
            <p class="page-subtitle">
                {{ $modversions->count() }} {{ Str::plural('version', $modversions->count()) }} not used by any build,
                {{ App\Models\Modversion::formatFilesize((int) $modversions->sum('filesize')) }} in total.
            </p>
        </div>
    </div>

    @session('success')
        <div class="ui-alert ui-alert-success mb-6 p-4">{{ $value }}</div>
    @endsession
    @include('partial.form-errors')

    @if ($modversions->isEmpty())
        <div class="ui-card border-dashed px-6 py-14 text-center">
            <p class="text-sm font-medium text-gray-950 dark:text-white">Nothing to clean up</p>
            <p class="mt-1 text-sm text-gray-500">Every mod version is used by at least one build.</p>
        </div>
    @else
        <form method="POST" action="{{ route('mod.unused') }}" class="ui-card overflow-hidden"
              x-data="{ selected: [], all: @js($modversions->pluck('id')->map(fn ($id) => (string) $id)->values()) }">
            @csrf
            <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-5 py-3.5 border-b border-gray-200 dark:border-gray-800">
                <label class="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 {{ $isRemote ? 'opacity-50' : '' }}">
                    <input type="checkbox" name="delete_files" value="1" class="ui-checkbox" @checked(! $isRemote) @disabled($isRemote)>
                    Also delete the files from the mod repository
                    @if ($isRemote)
                        <span class="text-xs text-gray-500">(not possible with a remote repository)</span>
                    @endif
                </label>
                <div class="flex items-center gap-2">
                    <button type="submit" class="ui-btn ui-btn-sm ui-btn-secondary" :disabled="!selected.length"
                            x-text="'Delete ' + selected.length + ' selected'">Delete selected</button>
                    <button type="submit" name="all" value="1" class="ui-btn ui-btn-sm ui-btn-danger"
                            onclick="return confirm('Delete all {{ $modversions->count() }} unused mod versions?')">Delete all</button>
                </div>
            </div>
            <div class="overflow-x-auto">
                <table class="w-full text-sm">
                    <thead>
                        <tr class="ui-table-head">
                            <th class="pl-5 pr-2 py-3 w-8">
                                <input type="checkbox" class="ui-checkbox" aria-label="Select all"
                                       :checked="selected.length === all.length" @change="selected = $event.target.checked ? [...all] : []">
                            </th>
                            <th class="px-3 py-3">Mod</th>
                            <th class="px-3 py-3">Version</th>
                            <th class="px-3 py-3 hidden sm:table-cell">Size</th>
                            <th class="px-5 py-3 hidden md:table-cell">Added</th>
                        </tr>
                    </thead>
                    <tbody class="ui-table-body">
                        @foreach ($modversions as $modversion)
                            <tr class="hover:bg-gray-50 dark:hover:bg-gray-900/50">
                                <td class="pl-5 pr-2 py-2.5">
                                    <input type="checkbox" name="modversions[]" value="{{ $modversion->id }}" x-model="selected" class="ui-checkbox"
                                           aria-label="Select {{ $modversion->mod->name }} {{ $modversion->version }}">
                                </td>
                                <td class="px-3 py-2.5">
                                    <a href="{{ url('mod/view/'.$modversion->mod_id) }}" class="font-medium text-gray-950 dark:text-white hover:underline underline-offset-2">{{ $modversion->mod->pretty_name ?: $modversion->mod->name }}</a>
                                </td>
                                <td class="px-3 py-2.5 font-mono text-xs text-gray-700 dark:text-gray-300">
                                    {{ $modversion->version }}
                                    @if (! $isRemote && ! is_file(App\Services\ModRepository::location($modversion)))
                                        <span class="ml-1 ui-badge text-red-600! dark:text-red-400!">File missing</span>
                                    @endif
                                </td>
                                <td class="px-3 py-2.5 text-gray-500 hidden sm:table-cell whitespace-nowrap">{{ $modversion->filesize ? $modversion->humanFilesize() : '-' }}</td>
                                <td class="px-5 py-2.5 text-gray-500 hidden md:table-cell whitespace-nowrap">{{ $modversion->created_at?->diffForHumans() }}</td>
                            </tr>
                        @endforeach
                    </tbody>
                </table>
            </div>
        </form>
    @endif
@endsection
