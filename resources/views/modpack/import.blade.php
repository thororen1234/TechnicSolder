@extends('layouts.master')
@section('title')
    <title>Import Modpack - Technic Solder</title>
@stop
@section('content')
    <div class="page-header">
        <div>
            <h1 class="page-title">Import modpack</h1>
            <p class="page-subtitle">Create a modpack from a CurseForge or Modrinth pack, or restore a Solder backup.</p>
        </div>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <form action="{{ route('modpack.import') }}" method="POST" enctype="multipart/form-data"
              class="ui-card lg:col-span-2"
              x-data="{
                  source: @js(old('source', 'file')),
                  name: @js(old('name', '')),
                  slug: @js(old('slug', '')),
                  slugEdited: @js(old('slug', '') !== ''),
                  submitting: false,
              }"
              @submit="submitting = true">
            @csrf

            <div class="p-5 sm:p-6 space-y-5">
                @include('partial.form-errors')

                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                        <label for="name" class="ui-label">Modpack name</label>
                        <input type="text" name="name" id="name" x-model="name"
                               @input="if (!slugEdited) slug = window.slugify(name)"
                               placeholder="My Awesome Pack" class="ui-control">
                    </div>
                    <div>
                        <label for="slug" class="ui-label">Slug</label>
                        <input type="text" name="slug" id="slug" x-model="slug" @input="slugEdited = true"
                               placeholder="my-awesome-pack" class="ui-control font-mono">
                    </div>
                </div>

                <div>
                    <span class="ui-label">Source</span>
                    <div class="inline-flex p-0.5 rounded-lg bg-gray-100 dark:bg-gray-900 text-sm" role="radiogroup">
                        <label class="px-3 py-1.5 rounded-md cursor-pointer transition-colors"
                               :class="source === 'file' ? 'bg-white dark:bg-gray-800 text-gray-950 dark:text-white shadow-xs' : 'text-gray-500'">
                            <input type="radio" name="source" value="file" x-model="source" class="sr-only">
                            Upload file
                        </label>
                        <label class="px-3 py-1.5 rounded-md cursor-pointer transition-colors"
                               :class="source === 'url' ? 'bg-white dark:bg-gray-800 text-gray-950 dark:text-white shadow-xs' : 'text-gray-500'">
                            <input type="radio" name="source" value="url" x-model="source" class="sr-only">
                            From URL
                        </label>
                    </div>
                </div>

                <div x-show="source === 'file'">
                    <label for="file" class="ui-label">Pack file</label>
                    <input type="file" name="file" id="file" accept=".zip,.mrpack,.json" class="ui-file">
                    <p class="mt-1.5 text-xs text-gray-500">CurseForge .zip, Modrinth .mrpack or Solder backup .json</p>
                </div>

                <div x-show="source === 'url'" x-cloak>
                    <label for="url" class="ui-label">Pack URL</label>
                    <input type="url" name="url" id="url" value="{{ old('url') }}" placeholder="https://example.com/modpack.mrpack" class="ui-control">
                    <p class="mt-1.5 text-xs text-gray-500">Direct download link to a .zip, .mrpack or .json file</p>
                </div>
            </div>

            <div class="flex items-center justify-between gap-3 px-5 sm:px-6 py-4 border-t border-gray-200 dark:border-gray-800">
                <p class="text-xs text-gray-500" x-show="!submitting">Large packs can take a few minutes.</p>
                <p class="text-xs text-gray-500 flex items-center gap-2" x-show="submitting" x-cloak>
                    <svg class="size-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z"/></svg>
                    Downloading mods, keep this tab open…
                </p>
                <div class="flex items-center gap-2">
                    <a href="{{ url('modpack/list') }}" class="ui-btn ui-btn-secondary">Cancel</a>
                    <button type="submit" class="ui-btn ui-btn-primary" :disabled="submitting">Import modpack</button>
                </div>
            </div>
        </form>

        <aside class="space-y-3 text-sm">
            <div class="ui-card p-5">
                <h2 class="section-title">What gets imported</h2>
                <ul class="mt-3 space-y-2 text-gray-600 dark:text-gray-400">
                    <li>Every mod is downloaded into your mod library and linked to a new build.</li>
                    <li>The pack's mod loader (Forge, NeoForge, Fabric or Quilt) is added to the build.</li>
                    <li>Configs and other bundled files are kept as a <span class="font-mono text-xs">…-overrides</span> mod.</li>
                    <li>The new modpack starts hidden so you can review it first.</li>
                </ul>
            </div>
            <div class="ui-card p-5">
                <h2 class="section-title">CurseForge packs</h2>
                <p class="mt-2 text-gray-600 dark:text-gray-400">
                    Need a <span class="font-mono text-xs">CURSEFORGE_API_KEY</span> in your .env. Mods whose authors disabled third-party downloads are skipped and listed after the import.
                </p>
            </div>
        </aside>
    </div>
@endsection
