<div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mt-4 text-sm text-gray-600 dark:text-gray-400">
    <div>
        <template x-if="totalFiltered > 0">
            <span>
                Showing <span class="font-medium text-gray-900 dark:text-gray-200 tabular-nums" x-text="showingFrom"></span>-<span class="font-medium text-gray-900 dark:text-gray-200 tabular-nums" x-text="showingTo"></span>
                of <span class="font-medium text-gray-900 dark:text-gray-200 tabular-nums" x-text="totalFiltered"></span> entries
                <template x-if="totalFiltered < totalRows">
                    <span>(filtered from <span class="tabular-nums" x-text="totalRows"></span> total)</span>
                </template>
            </span>
        </template>
        <template x-if="totalFiltered === 0">
            <span>No matching entries</span>
        </template>
    </div>
    <div class="flex items-center gap-0.5 p-0.5 rounded-lg bg-gray-100 dark:bg-white/5" x-show="totalPages > 1">
        <button @click="prevPage()" :disabled="page === 1" class="ui-page-btn" aria-label="Previous page">
            <svg class="size-4" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5"/></svg>
        </button>
        <template x-for="(p, index) in pageNumbers" :key="'page-'+index">
            <button x-text="p"
                    @click="typeof p === 'number' && goToPage(p)"
                    :disabled="p === '...'"
                    :aria-current="p === page ? 'page' : null"
                    :class="p === page && 'ui-page-btn-active'"
                    class="ui-page-btn tabular-nums disabled:opacity-100 disabled:cursor-default">
            </button>
        </template>
        <button @click="nextPage()" :disabled="page === totalPages" class="ui-page-btn" aria-label="Next page">
            <svg class="size-4" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5"/></svg>
        </button>
    </div>
</div>
