@extends('layouts.master')
@section('title')
    <title>Compare {{ $build->modpack->name }} {{ $build->version }} - Technic Solder</title>
@stop
@section('content')
    @php($label = fn ($modversion) => $modversion->mod->pretty_name ?: $modversion->mod->name)

    <div class="page-header">
        <div class="min-w-0">
            <p class="text-sm text-gray-500"><a href="{{ url('modpack/view/'.$build->modpack->id) }}" class="hover:text-gray-950 dark:hover:text-white">{{ $build->modpack->name }}</a></p>
            <h1 class="page-title">Compare builds</h1>
            <p class="page-subtitle">
                What changed in <span class="font-mono text-gray-950 dark:text-white">{{ $build->version }}</span>
                @if ($base)
                    since <span class="font-mono text-gray-950 dark:text-white">{{ $base->version }}</span>
                @endif
            </p>
        </div>
        <div class="flex items-center gap-2">
            @if ($others->isNotEmpty())
                <form method="GET" class="flex items-center gap-2">
                    <label for="with" class="text-sm text-gray-500 whitespace-nowrap">Compare with</label>
                    <select id="with" name="with" class="ui-control w-auto py-1.5" onchange="this.form.submit()">
                        @foreach ($others as $other)
                            <option value="{{ $other->id }}" @selected($base?->id === $other->id)>{{ $other->version }}</option>
                        @endforeach
                    </select>
                </form>
            @endif
            <a href="{{ url('modpack/build/'.$build->id) }}" class="ui-btn ui-btn-secondary">Back to build</a>
        </div>
    </div>

    @if (! $base)
        <div class="ui-card border-dashed px-6 py-14 text-center text-sm text-gray-500">
            This is the only build of {{ $build->modpack->name }}, so there is nothing to compare it with.
        </div>
    @else
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
            <div class="ui-stat"><p class="ui-stat-label">Added</p><p class="ui-stat-value text-emerald-600 dark:text-emerald-400">{{ $added->count() }}</p></div>
            <div class="ui-stat"><p class="ui-stat-label">Updated</p><p class="ui-stat-value text-blue-600 dark:text-blue-400">{{ $updated->count() }}</p></div>
            <div class="ui-stat"><p class="ui-stat-label">Removed</p><p class="ui-stat-value text-red-600 dark:text-red-400">{{ $removed->count() }}</p></div>
            <div class="ui-stat"><p class="ui-stat-label">Unchanged</p><p class="ui-stat-value">{{ $unchanged }}</p></div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <section class="ui-card lg:col-span-2 overflow-hidden">
                <div class="ui-card-header"><h2 class="section-title">Changes</h2></div>
                @if ($added->isEmpty() && $updated->isEmpty() && $removed->isEmpty())
                    <p class="px-5 py-12 text-center text-sm text-gray-500">These builds contain the same mod versions.</p>
                @else
                    <ul class="divide-y divide-gray-100 dark:divide-gray-900 text-sm">
                        @foreach ($added as $modversion)
                            <li class="flex items-center gap-3 px-5 py-2.5">
                                <span class="ui-badge ui-badge-success w-20 justify-center">Added</span>
                                <span class="font-medium text-gray-950 dark:text-white truncate">{{ $label($modversion) }}</span>
                                <span class="ml-auto font-mono text-xs text-gray-500 truncate">{{ $modversion->version }}</span>
                            </li>
                        @endforeach
                        @foreach ($updated as $change)
                            <li class="flex items-center gap-3 px-5 py-2.5">
                                <span class="ui-badge ui-badge-primary w-20 justify-center">Updated</span>
                                <span class="font-medium text-gray-950 dark:text-white truncate">{{ $label($change['to']) }}</span>
                                <span class="ml-auto font-mono text-xs text-gray-500 truncate">
                                    {{ $change['from']->version }} <span class="text-gray-300 dark:text-gray-700">→</span> <span class="text-gray-950 dark:text-white">{{ $change['to']->version }}</span>
                                </span>
                            </li>
                        @endforeach
                        @foreach ($removed as $modversion)
                            <li class="flex items-center gap-3 px-5 py-2.5">
                                <span class="ui-badge w-20 justify-center text-red-600! dark:text-red-400!">Removed</span>
                                <span class="font-medium text-gray-500 line-through truncate">{{ $label($modversion) }}</span>
                                <span class="ml-auto font-mono text-xs text-gray-400 truncate">{{ $modversion->version }}</span>
                            </li>
                        @endforeach
                    </ul>
                @endif
            </section>

            <section class="ui-card overflow-hidden" x-data="{ copied: false }">
                <div class="ui-card-header flex items-center justify-between">
                    <h2 class="section-title">Changelog</h2>
                    <button type="button" class="ui-btn ui-btn-sm ui-btn-secondary"
                            @click="navigator.clipboard.writeText($refs.markdown.value); copied = true; setTimeout(() => copied = false, 1500)"
                            x-text="copied ? 'Copied' : 'Copy'">Copy</button>
                </div>
                <textarea x-ref="markdown" readonly rows="16"
                          class="block w-full border-0 bg-transparent! p-5 font-mono text-xs text-gray-700 dark:text-gray-300 resize-none focus:ring-0">{{ $markdown }}</textarea>
            </section>
        </div>
    @endif
@endsection
