@props(['url' => null, 'name' => ''])
{{-- A mod's icon, falling back to its initial when there is no icon or the image doesn't load --}}
<span {{ $attributes->class('shrink-0 grid place-items-center overflow-hidden border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900') }}>
    <span class="font-semibold text-gray-400 dark:text-gray-500 select-none" @if (! empty($url)) hidden @endif aria-hidden="true">{{ mb_strtoupper(mb_substr(trim((string) $name), 0, 1)) ?: '?' }}</span>
    @if (! empty($url))
        <img src="{{ $url }}" alt="" class="size-full object-contain" loading="lazy"
             onerror="this.hidden = true; this.previousElementSibling.hidden = false">
    @endif
</span>
