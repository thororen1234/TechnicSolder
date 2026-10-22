<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    @section('title')
        <title>Technic Solder</title>
    @show
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="csrf-token" content="{{ csrf_token() }}">
    <link rel="shortcut icon" href="{{ asset('favicon.ico') }}">
    @fonts
    @include('partial.dark-mode-script')
    <script>
        // Resolve the active nav section before first paint so the sub-navigation doesn't shift the page.
        (function () {
            var path = window.location.pathname, section = null;
            if (/^\/(dashboard)?\/?$/.test(path)) section = 'dashboard';
            else if (/^\/modpack(\/|$)/.test(path)) section = 'modpacks';
            else if (/^\/mod(\/|$)/.test(path)) section = 'mods';
            else if (/^\/(solder|user|client|key)(\/|$)/.test(path)) section = 'settings';
            if (section) document.documentElement.dataset.section = section;
        })();
    </script>
    @vite(['resources/css/app.css', 'resources/js/app.js'])
    @stack('head')
</head>
<body class="app-bg text-gray-950 dark:text-gray-100 min-h-screen"
      x-data="shell({
          modpacks: @js($allModpacks->map(fn($mp) => [
              'id' => $mp->id,
              'name' => $mp->name,
              'slug' => $mp->slug,
              'icon_url' => $mp->icon_url ?? asset('/resources/default/icon.png'),
              'hidden' => $mp->hidden,
              'private' => $mp->private,
          ])->values()),
          currentModpackId: @js(isset($build) ? $build->modpack_id : null),
      })">

    {{-- Modpack rail --}}
    <aside class="hidden md:flex fixed inset-y-0 left-0 z-30 w-18 flex-col items-center border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950">
        <a href="{{ url('dashboard') }}" class="flex h-14 w-full shrink-0 items-center justify-center" aria-label="Solder dashboard">
            <img src="{{ asset('img/wrenchIcon.svg') }}" alt="" class="size-7">
        </a>
        <div class="w-8 h-px shrink-0 bg-gray-200 dark:bg-gray-800"></div>

        <nav class="flex-1 w-full overflow-y-auto no-scrollbar py-3 flex flex-col items-center gap-2.5" aria-label="Modpacks">
            @foreach ($allModpacks as $railModpack)
                <a href="{{ url('modpack/view/'.$railModpack->id) }}"
                   class="rail-item shrink-0"
                   aria-label="{{ $railModpack->name }}"
                   :aria-current="currentModpackId === {{ $railModpack->id }} ? 'page' : null"
                   @mouseenter="showTip($el, @js($railModpack->name))"
                   @mouseleave="tip.show = false"
                   @focus="showTip($el, @js($railModpack->name))"
                   @blur="tip.show = false">
                    <span class="rail-indicator"></span>
                    <img src="{{ $railModpack->icon_url ?? asset('/resources/default/icon.png') }}" alt="" onerror="this.onerror = null; this.src = '{{ asset('/resources/default/icon.png') }}'" class="size-full rounded-[inherit] object-cover">
                    @if ($railModpack->private || $railModpack->hidden)
                        <span class="absolute -bottom-1 -right-1 flex items-center justify-center size-4 rounded-full bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                            @if ($railModpack->private)
                                <x-icons.lock-closed class="size-2.5" />
                            @else
                                <x-icons.eye-slash class="size-2.5" />
                            @endif
                        </span>
                    @endif
                </a>
            @endforeach

            @if ($allModpacks->isNotEmpty())
                <div class="w-6 h-px shrink-0 bg-gray-200 dark:bg-gray-800"></div>
            @endif

            <a href="{{ url('modpack/create') }}" class="rail-item shrink-0 border-dashed bg-transparent dark:bg-transparent"
               aria-label="New modpack"
               @mouseenter="showTip($el, 'New modpack')" @mouseleave="tip.show = false"
               @focus="showTip($el, 'New modpack')" @blur="tip.show = false">
                <svg class="size-5" fill="none" viewBox="0 0 24 24" stroke-width="1.75" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15"/></svg>
            </a>
            <a href="{{ url('modpack/import') }}" class="rail-item shrink-0 border-dashed bg-transparent dark:bg-transparent"
               aria-label="Import modpack"
               @mouseenter="showTip($el, 'Import modpack')" @mouseleave="tip.show = false"
               @focus="showTip($el, 'Import modpack')" @blur="tip.show = false">
                <svg class="size-5" fill="none" viewBox="0 0 24 24" stroke-width="1.75" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3"/></svg>
            </a>
        </nav>
    </aside>

    {{-- Rail tooltip (fixed so the scrolling rail can't clip it) --}}
    <div x-show="tip.show" x-cloak role="tooltip"
         class="hidden md:block fixed left-20 z-50 -translate-y-1/2 px-2 py-1 rounded-md bg-gray-950 text-white dark:bg-white dark:text-gray-950 text-xs font-medium whitespace-nowrap pointer-events-none shadow-float"
         :style="`top: ${tip.top}px`" x-text="tip.text"></div>

    <div class="md:pl-18 min-h-screen flex flex-col min-w-0">
        {{-- Top bar --}}
        <header class="sticky top-0 z-20 bg-white/80 dark:bg-gray-950/80 backdrop-blur-xl border-b border-gray-200 dark:border-gray-800">
            <div class="flex items-center gap-2 h-14 px-4 sm:px-6">
                <a href="{{ url('dashboard') }}" class="md:hidden shrink-0" aria-label="Solder dashboard">
                    <img src="{{ asset('img/wrenchIcon.svg') }}" alt="" class="size-6">
                </a>

                {{-- Section tabs --}}
                <nav class="flex-1 min-w-0 self-stretch flex items-center gap-0.5 overflow-x-auto no-scrollbar" aria-label="Sections">
                    <a href="{{ url('dashboard') }}" class="nav-tab" :aria-current="section === 'dashboard' ? 'page' : null">Overview</a>
                    <a href="{{ url('modpack/list') }}" class="nav-tab" :aria-current="section === 'modpacks' ? 'page' : null">Modpacks</a>
                    <a href="{{ url('mod/list') }}" class="nav-tab" :aria-current="section === 'mods' ? 'page' : null">Mods</a>
                    <a href="{{ url('solder/configure') }}" class="nav-tab" :aria-current="section === 'settings' ? 'page' : null">Settings</a>
                </nav>

                <div class="flex shrink-0 items-center gap-1.5 sm:gap-2">
                    @if (Cache::get('update'))
                        <a href="{{ url('solder/update') }}" class="hidden sm:inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-xs font-medium text-amber-700 border border-amber-200 bg-amber-50 hover:bg-amber-100 dark:text-amber-300 dark:border-amber-500/30 dark:bg-amber-500/10 dark:hover:bg-amber-500/15 transition-colors">
                            <span class="size-1.5 rounded-full bg-amber-500"></span>
                            Update available
                        </a>
                    @endif

                    {{-- Command palette trigger --}}
                    <button type="button" @click="$dispatch('open-palette')"
                            class="hidden sm:flex items-center gap-2 w-44 lg:w-60 h-8 pl-2.5 pr-1.5 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 text-sm text-gray-400 dark:text-gray-500 hover:border-gray-300 dark:hover:border-gray-700 transition-colors">
                        <svg class="size-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"/></svg>
                        Search or jump to…
                        <span class="ml-auto flex items-center gap-0.5">
                            <kbd class="ui-kbd" x-text="isMac ? '⌘' : 'Ctrl'">Ctrl</kbd><kbd class="ui-kbd">K</kbd>
                        </span>
                    </button>
                    <button type="button" @click="$dispatch('open-palette')" class="sm:hidden ui-btn-ghost ui-btn-icon" aria-label="Search">
                        <svg class="size-5" fill="none" viewBox="0 0 24 24" stroke-width="1.75" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"/></svg>
                    </button>

                    {{-- Dark mode toggle --}}
                    <button type="button" @click="$store.darkMode.toggle()"
                            class="ui-btn-ghost ui-btn-icon"
                            :aria-label="$store.darkMode.on ? 'Switch to light mode' : 'Switch to dark mode'">
                        <svg x-show="!$store.darkMode.on" class="size-5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z"/></svg>
                        <svg x-show="$store.darkMode.on" class="size-5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" style="display: none"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z"/></svg>
                    </button>

                    {{-- User menu --}}
                    <div class="relative" x-data="{ open: false }" @keydown.escape="open = false">
                        <button type="button" @click="open = !open" @click.outside="open = false"
                                class="flex items-center justify-center size-8 rounded-full bg-gray-950 text-white dark:bg-white dark:text-gray-950 text-xs font-semibold hover:opacity-85 transition-opacity"
                                :aria-expanded="open" aria-label="Account menu"
                                data-name="{{ Auth::user()->username }}"
                                x-text="$el.dataset.name.charAt(0).toUpperCase()"></button>
                        <div x-show="open"
                             x-transition:enter="transition ease-out duration-100"
                             x-transition:enter-start="opacity-0 scale-95"
                             x-transition:enter-end="opacity-100 scale-100"
                             x-transition:leave="transition ease-in duration-75"
                             x-transition:leave-start="opacity-100 scale-100"
                             x-transition:leave-end="opacity-0 scale-95"
                             class="ui-menu absolute right-0 mt-2 w-56 origin-top-right"
                             style="display: none">
                            <div class="px-2.5 py-2 mb-1 border-b border-gray-100 dark:border-gray-900">
                                <p class="text-sm font-medium text-gray-950 dark:text-white truncate">{{ Auth::user()->username }}</p>
                                <p class="text-xs text-gray-500 truncate">{{ Auth::user()->email }}</p>
                            </div>
                            <a href="{{ url('user/edit/'.Auth::user()->id) }}" class="ui-menu-item">
                                <svg class="size-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z"/></svg>
                                Profile
                            </a>
                            <a href="{{ url('solder/configure') }}" class="ui-menu-item">
                                <svg class="size-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 1 1-3 0m3 0a1.5 1.5 0 1 0-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-9.75 0h9.75"/></svg>
                                Settings
                            </a>
                            <div class="my-1 h-px bg-gray-100 dark:bg-gray-900"></div>
                            <form method="POST" action="{{ route('logout') }}">
                                @csrf
                                <button type="submit" class="ui-menu-item">
                                    <svg class="size-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 9V5.25A2.25 2.25 0 0 1 10.5 3h6a2.25 2.25 0 0 1 2.25 2.25v13.5A2.25 2.25 0 0 1 16.5 21h-6a2.25 2.25 0 0 1-2.25-2.25V15m-3 0-3-3m0 0 3-3m-3 3H15"/></svg>
                                    Log out
                                </button>
                            </form>
                        </div>
                    </div>
                </div>
            </div>
        </header>

        <main class="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            {{-- Section sub-navigation; the matching one is shown via html[data-section] --}}
            <nav data-subnav="modpacks" class="subnav" aria-label="Modpacks">
                <a href="{{ url('modpack/list') }}" class="subnav-link" :aria-current="isCurrent(['/modpack/list']) ? 'page' : null">All modpacks</a>
                <a href="{{ url('modpack/create') }}" class="subnav-link" :aria-current="isCurrent(['/modpack/create']) ? 'page' : null">New modpack</a>
                <a href="{{ url('modpack/import') }}" class="subnav-link" :aria-current="isCurrent(['/modpack/import']) ? 'page' : null">Import</a>
            </nav>
            <nav data-subnav="mods" class="subnav" aria-label="Mods">
                <a href="{{ url('mod/list') }}" class="subnav-link" :aria-current="isCurrent(['/mod/list', '/mod/view', '/mod/delete']) ? 'page' : null">All mods</a>
                <a href="{{ url('mod/create') }}" class="subnav-link" :aria-current="isCurrent(['/mod/create']) ? 'page' : null">New mod</a>
                <a href="{{ url('mod/import') }}" class="subnav-link" :aria-current="isCurrent(['/mod/import']) ? 'page' : null">Import</a>
                <a href="{{ url('mod/unused') }}" class="subnav-link" :aria-current="isCurrent(['/mod/unused']) ? 'page' : null">Unused</a>
            </nav>
            <nav data-subnav="settings" class="subnav" aria-label="Settings">
                <a href="{{ url('solder/configure') }}" class="subnav-link" :aria-current="isCurrent(['/solder/configure']) ? 'page' : null">Configuration</a>
                <a href="{{ url('solder/update') }}" class="subnav-link" :aria-current="isCurrent(['/solder/update']) ? 'page' : null">Updates</a>
                <a href="{{ url('solder/repository') }}" class="subnav-link" :aria-current="isCurrent(['/solder/repository']) ? 'page' : null">Repository</a>
                <a href="{{ url('solder/activity') }}" class="subnav-link" :aria-current="isCurrent(['/solder/activity']) ? 'page' : null">Activity</a>
                <a href="{{ url('user/list') }}" class="subnav-link" :aria-current="isCurrent(['/user']) ? 'page' : null">Users</a>
                <a href="{{ url('client/list') }}" class="subnav-link" :aria-current="isCurrent(['/client']) ? 'page' : null">Clients</a>
                <a href="{{ url('key/list') }}" class="subnav-link" :aria-current="isCurrent(['/key']) ? 'page' : null">Platform keys</a>
            </nav>

            @yield('content')
        </main>
    </div>

    {{-- Command palette --}}
    <div x-data="commandPalette({ modpacks, profileUrl: @js(url('user/edit/'.Auth::user()->id)) })"
         @open-palette.window="show()"
         @keydown.escape.window="open && close()">
        <div x-show="open" x-cloak class="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Command palette">
            <div class="absolute inset-0 bg-gray-950/30 dark:bg-black/60" @click="close()"
                 x-show="open" x-transition.opacity.duration.150ms></div>
            <div class="ui-menu relative mx-auto mt-[12vh] w-[calc(100%-2rem)] max-w-xl p-0 overflow-hidden"
                 x-show="open"
                 x-transition:enter="transition ease-out duration-150"
                 x-transition:enter-start="opacity-0 scale-[0.98] -translate-y-1"
                 x-transition:enter-end="opacity-100 scale-100 translate-y-0">
                <div class="flex items-center gap-3 px-4 border-b border-gray-200 dark:border-gray-800">
                    <svg class="size-4 shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"/></svg>
                    <input x-ref="input" x-model="query" type="text" autocomplete="off" spellcheck="false"
                           @keydown.arrow-down.prevent="move(1)"
                           @keydown.arrow-up.prevent="move(-1)"
                           @keydown.enter.prevent="choose()"
                           placeholder="Search modpacks, pages, actions…"
                           aria-label="Search"
                           class="flex-1 h-12 px-0 border-0 bg-transparent! text-sm text-gray-950 dark:text-white placeholder:text-gray-400 dark:placeholder:text-gray-600 focus:ring-0 focus:outline-none">
                    <kbd class="ui-kbd">Esc</kbd>
                </div>
                <div x-ref="list" class="max-h-[min(24rem,60vh)] overflow-y-auto p-1.5">
                    <template x-for="group in groups" :key="group.label">
                        <div class="pb-1">
                            <p class="px-2.5 pt-2 pb-1 text-[11px] font-medium text-gray-500" x-text="group.label"></p>
                            <template x-for="item in group.items" :key="group.label + item.label">
                                <button type="button"
                                        @click="choose(item)"
                                        @mousemove="active = item.index"
                                        :data-active="active === item.index"
                                        class="flex w-full items-center gap-3 px-2.5 py-2 rounded-lg text-sm text-left text-gray-700 dark:text-gray-300 data-[active=true]:bg-gray-100 data-[active=true]:text-gray-950 dark:data-[active=true]:bg-gray-900 dark:data-[active=true]:text-white">
                                    <span class="flex items-center justify-center size-6 shrink-0 rounded-md border border-gray-200 dark:border-gray-800 text-gray-400 overflow-hidden">
                                        <template x-if="item.icon"><img :src="item.icon" alt="" onerror="this.onerror = null; this.src = '{{ asset('/resources/default/icon.png') }}'" class="size-full object-cover"></template>
                                        <template x-if="!item.icon && item.type === 'page'">
                                            <svg class="size-3.5" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5"/></svg>
                                        </template>
                                        <template x-if="!item.icon && item.type === 'search'">
                                            <svg class="size-3.5" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"/></svg>
                                        </template>
                                        <template x-if="!item.icon && item.type === 'action'">
                                            <svg class="size-3.5" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m3.75 13.5 10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z"/></svg>
                                        </template>
                                    </span>
                                    <span class="truncate" x-text="item.label"></span>
                                    <span class="ml-auto pl-3 text-xs text-gray-400 dark:text-gray-500 truncate" x-text="item.hint"></span>
                                </button>
                            </template>
                        </div>
                    </template>
                    <p x-show="flat.length === 0" class="px-3 py-10 text-center text-sm text-gray-500">No results.</p>
                </div>
                <div class="flex items-center gap-4 px-4 py-2.5 border-t border-gray-200 dark:border-gray-800 text-xs text-gray-500">
                    <span class="flex items-center gap-1.5"><kbd class="ui-kbd">↑</kbd><kbd class="ui-kbd">↓</kbd> Navigate</span>
                    <span class="flex items-center gap-1.5"><kbd class="ui-kbd">↵</kbd> Open</span>
                    <span class="flex items-center gap-1.5"><kbd class="ui-kbd">Esc</kbd> Close</span>
                </div>
            </div>
        </div>
    </div>

    {{-- Toast notifications --}}
    <div class="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2" x-data>
        <template x-for="toast in $store.toasts.items" :key="toast.id">
            <div x-show="true"
                 x-transition:enter="transition ease-out duration-200"
                 x-transition:enter-start="opacity-0 translate-y-2"
                 x-transition:enter-end="opacity-100 translate-y-0"
                 x-transition:leave="transition ease-in duration-150"
                 x-transition:leave-start="opacity-100"
                 x-transition:leave-end="opacity-0 translate-y-2"
                 class="ui-menu flex items-center gap-3 px-4 py-3 max-w-sm cursor-pointer text-sm text-gray-800 dark:text-gray-200"
                 @click="$store.toasts.remove(toast.id)">
                <span class="size-1.5 shrink-0 rounded-full"
                      :class="{
                          'bg-emerald-500': toast.type === 'success',
                          'bg-red-500': toast.type === 'error',
                          'bg-amber-500': toast.type === 'warning',
                          'bg-blue-500': toast.type === 'info',
                      }"></span>
                <span x-text="toast.message"></span>
            </div>
        </template>
    </div>

    @stack('scripts')
</body>
</html>
