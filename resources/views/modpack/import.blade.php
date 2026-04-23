@extends('layouts.master')
@section('title')
    <title>Import Modpack - Technic Solder</title>
@stop
@section('content')
    <div class="mb-6">
        <h1 class="text-2xl font-bold text-gray-900 dark:text-white">Modpack Management</h1>
        <p class="text-gray-500 dark:text-gray-400 text-sm mt-1">Import an existing modpack</p>
    </div>

    <div class="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-800">
        <div class="px-5 py-4 border-b border-gray-200 dark:border-gray-800">
            <span class="font-semibold text-gray-900 dark:text-white">Import Modpack</span>
        </div>
        <div class="p-5">
            @include('partial.form-errors')

            <p class="text-sm text-gray-500 dark:text-gray-400 mb-5">
                Import a modpack from a <strong>CurseForge</strong> (.zip with manifest.json) or
                <strong>Modrinth</strong> (.mrpack) export. All mods will be downloaded from their
                respective APIs and added to your mod library, then linked to the new build.
                Requires a CurseForge API key for CurseForge packs.
            </p>

            <form
                action="{{ route('modpack.import') }}"
                method="POST"
                enctype="multipart/form-data"
                x-data="{
                    source: '{{ old('source', 'file') }}',
                    name: '{{ old('name', '') }}',
                    slug: '{{ old('slug', '') }}',
                }"
            >
                @csrf

                <div class="space-y-5">
                    {{-- Name & Slug --}}
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                            <label for="name" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                Modpack Name
                            </label>
                            <input
                                type="text"
                                name="name"
                                id="name"
                                x-model="name"
                                @input="if (!slug || slug === window.slugify($event.target.dataset.prev || '')) slug = window.slugify(name); $event.target.dataset.prev = name"
                                placeholder="My Awesome Pack"
                                value="{{ old('name') }}"
                                class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-colors"
                            >
                        </div>
                        <div>
                            <label for="slug" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                Modpack Slug
                            </label>
                            <input
                                type="text"
                                name="slug"
                                id="slug"
                                x-model="slug"
                                placeholder="my-awesome-pack"
                                value="{{ old('slug') }}"
                                class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-colors"
                            >
                        </div>
                    </div>

                    {{-- Source toggle --}}
                    <div>
                        <span class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Source</span>
                        <div class="flex gap-4 text-sm">
                            <label class="flex items-center gap-2 cursor-pointer">
                                <input type="radio" name="source" value="file" x-model="source"
                                    class="text-blue-600 focus:ring-blue-500">
                                <span class="text-gray-700 dark:text-gray-300">Upload ZIP / mrpack</span>
                            </label>
                            <label class="flex items-center gap-2 cursor-pointer">
                                <input type="radio" name="source" value="url" x-model="source"
                                    class="text-blue-600 focus:ring-blue-500">
                                <span class="text-gray-700 dark:text-gray-300">URL</span>
                            </label>
                        </div>
                    </div>

                    {{-- File upload --}}
                    <div x-show="source === 'file'">
                        <label for="file" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                            Modpack Archive
                        </label>
                        <input
                            type="file"
                            name="file"
                            id="file"
                            accept=".zip,.mrpack"
                            class="w-full text-sm text-gray-700 dark:text-gray-300 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-blue-50 file:text-blue-700 dark:file:bg-blue-500/15 dark:file:text-blue-400 hover:file:bg-blue-100 dark:hover:file:bg-blue-500/25 transition-colors"
                        >
                        <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">CurseForge .zip or Modrinth .mrpack</p>
                    </div>

                    {{-- URL input --}}
                    <div x-show="source === 'url'">
                        <label for="url" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                            Archive URL
                        </label>
                        <input
                            type="url"
                            name="url"
                            id="url"
                            placeholder="https://example.com/modpack.zip"
                            value="{{ old('url') }}"
                            class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-colors"
                        >
                        <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">Direct link to a CurseForge .zip or Modrinth .mrpack archive</p>
                    </div>
                </div>

                <div class="mt-6 flex items-center gap-3">
                    <button
                        type="submit"
                        class="bg-green-600 hover:bg-green-700 text-white dark:bg-green-500/15 dark:text-green-400 dark:hover:bg-green-500/25 font-medium py-2 px-4 rounded-lg text-sm transition-colors"
                    >
                        Import Modpack
                    </button>
                    <a href="{{ url('modpack/list') }}"
                       class="bg-blue-600 hover:bg-blue-700 text-white dark:bg-blue-500/15 dark:text-blue-400 dark:hover:bg-blue-500/25 font-medium py-2 px-4 rounded-lg text-sm transition-colors">
                        Go Back
                    </a>
                    <span class="text-xs text-gray-500 dark:text-gray-400 ml-2">
                        This may take several minutes depending on the number of mods.
                    </span>
                </div>
            </form>
        </div>
    </div>
@endsection
