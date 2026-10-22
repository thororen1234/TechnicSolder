@props(['entries', 'showModpack' => false, 'empty' => 'No activity yet.'])
@if ($entries->isEmpty())
    <p class="px-5 py-10 text-center text-sm text-gray-500">{{ $empty }}</p>
@else
    <ul class="divide-y divide-gray-100 dark:divide-gray-900">
        @foreach ($entries as $entry)
            <li class="flex items-start gap-3 px-5 py-3 text-sm">
                <span class="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-900 text-[11px] font-semibold text-gray-600 dark:text-gray-400"
                      title="{{ $entry->user?->username ?? 'System' }}">
                    {{ strtoupper(substr($entry->user?->username ?? 'S', 0, 1)) }}
                </span>
                <div class="min-w-0 flex-1">
                    <p class="text-gray-950 dark:text-white">{{ $entry->description }}</p>
                    <p class="mt-0.5 text-xs text-gray-500">
                        {{ $entry->user?->username ?? 'System' }}
                        @if ($showModpack && $entry->modpack)
                            · <a href="{{ url('modpack/view/'.$entry->modpack->id) }}" class="hover:text-gray-950 dark:hover:text-white">{{ $entry->modpack->name }}</a>
                        @endif
                        @if ($entry->build)
                            · <a href="{{ url('modpack/build/'.$entry->build->id) }}" class="font-mono hover:text-gray-950 dark:hover:text-white">{{ $entry->build->version }}</a>
                        @endif
                        · <time datetime="{{ $entry->created_at->toIso8601String() }}" title="{{ $entry->created_at }}">{{ $entry->created_at->diffForHumans() }}</time>
                    </p>
                </div>
            </li>
        @endforeach
    </ul>
@endif
