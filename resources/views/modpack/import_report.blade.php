@extends('layouts.master')
@section('title')
    <title>Import of {{ $import->name }} - Technic Solder</title>
@stop
@section('content')
    @php
        $log = $import->log ?? [];
        $problems = $import->problems ?? [];
        $errorCount = collect($log)->where('level', 'error')->count();
    @endphp
    <div class="max-w-4xl mx-auto"
         @if (in_array($import->status, [App\Models\ModpackImport::QUEUED, App\Models\ModpackImport::RUNNING], true))
             x-data x-init="setTimeout(() => window.location.reload(), 5000)"
         @endif>
        <div class="page-header">
            <div class="min-w-0">
                <div class="flex items-center gap-3 flex-wrap">
                    <h1 class="page-title truncate">Import of {{ $import->name }}</h1>
                    <x-import-status :import="$import" />
                </div>
                <p class="page-subtitle break-all">From {{ $import->source }}</p>
            </div>
            <a href="{{ route('modpack.import') }}" class="ui-btn ui-btn-secondary shrink-0">Imports</a>
        </div>

        @session('success')
            <div class="ui-alert ui-alert-success mb-6 p-4">{{ $value }}</div>
        @endsession
        @include('partial.form-errors')

        @if ($import->status === App\Models\ModpackImport::WAITING)
            <section class="ui-card mb-6 overflow-hidden">
                <div class="ui-alert ui-alert-warning rounded-none border-0 p-5">
                    <p class="font-medium">{{ $import->modpack?->name }} already has a build {{ $import->build_version }}.</p>
                    <p class="mt-1 text-sm">Nothing has been changed yet. Choose what to do with this pack.</p>
                </div>
                @can('update', $import)
                    @if ($import->archiveExists())
                        <div class="p-5 grid grid-cols-1 md:grid-cols-3 gap-5 text-sm">
                            <form method="POST" action="{{ url('modpack/imports/'.$import->id) }}" class="space-y-2"
                                  onsubmit="return confirm(@js("Replace every mod in build {$import->build_version} with the ones in this pack?"))">
                                @csrf
                                <input type="hidden" name="action" value="overwrite">
                                <p class="font-medium text-gray-950 dark:text-white">Overwrite it</p>
                                <p class="text-gray-500">Replace the build's mods with the pack's. Its published and recommended settings stay as they are.</p>
                                <button type="submit" class="ui-btn ui-btn-sm ui-btn-danger">Overwrite {{ $import->build_version }}</button>
                            </form>
                            <form method="POST" action="{{ url('modpack/imports/'.$import->id) }}" class="space-y-2">
                                @csrf
                                <input type="hidden" name="action" value="rename">
                                <label for="version" class="block font-medium text-gray-950 dark:text-white">Import as another version</label>
                                <input type="text" name="version" id="version" value="{{ old('version') }}" required
                                       placeholder="{{ $import->build_version }}-1" class="ui-control font-mono">
                                <button type="submit" class="ui-btn ui-btn-sm ui-btn-primary">Import as new build</button>
                            </form>
                            <form method="POST" action="{{ url('modpack/imports/'.$import->id) }}" class="space-y-2">
                                @csrf
                                <input type="hidden" name="action" value="cancel">
                                <p class="font-medium text-gray-950 dark:text-white">Don't import it</p>
                                <p class="text-gray-500">Discard the uploaded pack and leave the modpack as it is.</p>
                                <button type="submit" class="ui-btn ui-btn-sm ui-btn-secondary">Cancel import</button>
                            </form>
                        </div>
                    @else
                        <p class="p-5 text-sm text-gray-500">The uploaded pack is no longer available. Start the import again.</p>
                    @endif
                @else
                    <p class="p-5 text-sm text-gray-500">Only someone who manages {{ $import->modpack?->name }} can decide.</p>
                @endcan
                <p class="px-5 pb-4 text-xs text-gray-500">Undecided imports are cancelled after {{ App\Models\ModpackImport::WAITING_DAYS }} days.</p>
            </section>
        @endif

        <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
            <div class="ui-stat">
                <p class="ui-stat-label">Mods imported</p>
                <p class="ui-stat-value">{{ $import->imported }}</p>
            </div>
            <div class="ui-stat">
                <p class="ui-stat-label">Skipped</p>
                <p class="ui-stat-value">{{ $import->skipped }}</p>
            </div>
            <div class="ui-stat">
                <p class="ui-stat-label">Problems</p>
                <p class="ui-stat-value">{{ count($problems) }}</p>
            </div>
            <div class="ui-stat">
                <p class="ui-stat-label">Build</p>
                <p class="ui-stat-value font-mono text-xl truncate">
                    @if ($import->build)
                        <a href="{{ url('modpack/build/'.$import->build->id) }}" class="hover:underline underline-offset-2">{{ $import->build->version }}</a>
                    @else
                        {{ $import->build_version ?: '-' }}
                    @endif
                </p>
            </div>
        </div>

        <section class="ui-card mb-6">
            <dl class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 p-5 text-sm">
                <div>
                    <dt class="text-xs text-gray-500">Modpack</dt>
                    <dd class="mt-0.5 text-gray-950 dark:text-white">
                        @if ($import->modpack)
                            <a href="{{ url('modpack/view/'.$import->modpack->id) }}" class="hover:underline underline-offset-2">{{ $import->modpack->name }}</a>
                            <span class="text-gray-500">{{ $import->slug === null ? '(existing)' : '(created by this import)' }}</span>
                        @else
                            {{ $import->name }}
                        @endif
                    </dd>
                </div>
                <div>
                    <dt class="text-xs text-gray-500">Started by</dt>
                    <dd class="mt-0.5 text-gray-950 dark:text-white">
                        {{ $import->user?->username ?? 'Unknown' }} ·
                        <time datetime="{{ $import->created_at->toIso8601String() }}" title="{{ $import->created_at }}">{{ $import->created_at->diffForHumans() }}</time>
                    </dd>
                </div>
            </dl>
        </section>

        @if ($problems !== [])
            <section class="ui-card mb-6 overflow-hidden">
                <div class="ui-card-header flex items-center justify-between">
                    <h2 class="section-title">{{ $import->status === App\Models\ModpackImport::FAILED ? 'Errors' : 'Problems' }}</h2>
                    <span class="ui-badge ui-badge-warning">{{ count($problems) }}</span>
                </div>
                <ul class="divide-y divide-gray-100 dark:divide-gray-900">
                    @foreach ($problems as $problem)
                        <li class="px-5 py-2.5 text-sm text-gray-700 dark:text-gray-300">{{ $problem }}</li>
                    @endforeach
                </ul>
            </section>
        @endif

        <section class="ui-card overflow-hidden" x-data="{ errorsOnly: false }">
            <div class="ui-card-header flex items-center justify-between gap-3">
                <h2 class="section-title">Log</h2>
                @if ($errorCount > 0)
                    <label class="flex items-center gap-2 text-xs text-gray-500 cursor-pointer">
                        <input type="checkbox" x-model="errorsOnly" class="ui-checkbox">
                        Only problems ({{ $errorCount }})
                    </label>
                @endif
            </div>
            @if ($log === [])
                <p class="px-5 py-10 text-center text-sm text-gray-500">Nothing logged yet.</p>
            @else
                <ol class="divide-y divide-gray-100 dark:divide-gray-900 font-mono text-xs max-h-144 overflow-y-auto">
                    @foreach ($log as $entry)
                        <li class="flex gap-3 px-5 py-1.5 {{ $entry['level'] === 'error' ? 'bg-red-50/60 dark:bg-red-500/5 text-red-700 dark:text-red-300' : 'text-gray-700 dark:text-gray-300' }}"
                            @if ($entry['level'] !== 'error') x-show="!errorsOnly" @endif>
                            <time class="shrink-0 text-gray-400 tabular-nums" datetime="{{ $entry['time'] }}">{{ \Illuminate\Support\Carbon::parse($entry['time'])->format('H:i:s') }}</time>
                            <span class="min-w-0 wrap-break-word">{{ $entry['message'] }}</span>
                        </li>
                    @endforeach
                </ol>
            @endif
        </section>
    </div>
@endsection
