@extends('layouts.master')
@section('title')
    <title>{{ $task['title'] }} - Technic Solder</title>
@stop
@section('content')
    <div class="max-w-2xl mx-auto"
         x-data="{
             status: @js($task['status']),
             done: @js($task['done']),
             total: @js($task['total']),
             message: @js($task['message']),
             errors: @js($task['errors']),
             url: null,
             label: null,
             download: false,
             downloaded: false,
             redirect: false,
             report_url: null,
             get percent() {
                 if (this.status === 'completed') return 100;
                 return this.total > 0 ? Math.min(99, Math.round(this.done / this.total * 100)) : 0;
             },
             get finished() { return this.status === 'completed' || this.status === 'failed' },
             async poll() {
                 try {
                     const data = await window.ajax(@js(route('task.status', $task['id'])));
                     Object.assign(this, data);
                     if (this.status === 'completed' && (this.download || this.redirect) && !this.downloaded) {
                         this.downloaded = true;
                         window.location.href = this.url;
                     }
                 } catch (e) {}
                 if (!this.finished) setTimeout(() => this.poll(), 1000);
             },
         }"
         x-init="poll()">
        <div class="page-header">
            <div>
                <h1 class="page-title">{{ $task['title'] }}</h1>
                <p class="page-subtitle">You can leave this page; the task keeps running in the background.</p>
            </div>
        </div>

        <section class="ui-card p-5 sm:p-6">
            <div class="flex items-center justify-between gap-3 mb-3">
                <p class="flex items-center gap-2 text-sm font-medium text-gray-950 dark:text-white">
                    <span class="size-2 rounded-full"
                          :class="{
                              'bg-gray-300 dark:bg-gray-700': status === 'queued',
                              'bg-blue-500 animate-pulse': status === 'running',
                              'bg-emerald-500': status === 'completed',
                              'bg-red-500': status === 'failed',
                          }"></span>
                    <span x-text="{ queued: 'Queued', running: 'Working', completed: 'Finished', failed: 'Failed' }[status]"></span>
                </p>
                <span class="text-xs text-gray-500 tabular-nums" x-show="total > 0 && !finished" x-text="done + ' / ' + total"></span>
            </div>

            <div class="h-1.5 rounded-full bg-gray-100 dark:bg-gray-900 overflow-hidden">
                <div class="h-full rounded-full transition-all duration-500"
                     :class="status === 'failed' ? 'bg-red-500' : 'bg-gray-950 dark:bg-white'"
                     :style="`width: ${status === 'failed' ? 100 : percent}%`"></div>
            </div>

            <p class="mt-3 text-sm text-gray-600 dark:text-gray-400" x-text="message"></p>

            <template x-if="status === 'queued' && !finished">
                <p class="mt-2 text-xs text-gray-500">
                    Waiting for the queue worker. If this never starts, check that <span class="font-mono">php artisan queue:work</span> is running.
                </p>
            </template>

            <div class="mt-5 flex items-center gap-2" x-show="status === 'completed' && url" x-cloak>
                <a :href="url" class="ui-btn ui-btn-primary" x-text="label || 'Continue'"></a>
                <a :href="report_url" class="ui-btn ui-btn-secondary" x-show="report_url">Import report</a>
                <span class="text-xs text-gray-500" x-show="download">The download should start automatically.</span>
            </div>
        </section>

        <section class="ui-card mt-4 overflow-hidden" x-show="errors.length" x-cloak>
            <div class="ui-card-header flex items-center justify-between">
                <h2 class="section-title" x-text="status === 'failed' ? 'Error' : 'Problems'"></h2>
                <span class="ui-badge ui-badge-warning" x-text="errors.length"></span>
            </div>
            <ul class="divide-y divide-gray-100 dark:divide-gray-900 max-h-96 overflow-y-auto">
                <template x-for="(error, index) in errors" :key="index">
                    <li class="px-5 py-2.5 text-sm text-gray-700 dark:text-gray-300" x-text="error"></li>
                </template>
            </ul>
        </section>
    </div>
@endsection
