@extends('layouts.master')
@section('title')
    <title>Activity - Technic Solder</title>
@stop
@section('content')
    <div class="page-header">
        <div>
            <h1 class="page-title">Activity</h1>
            <p class="page-subtitle">Who changed which modpack and build, and when.</p>
        </div>
    </div>

    <section class="ui-card overflow-hidden">
        @include('partial.activity-list', ['entries' => $entries, 'showModpack' => true, 'empty' => 'Nothing has changed yet.'])
    </section>

    @if ($entries->hasPages())
        <div class="mt-4">{{ $entries->links() }}</div>
    @endif
@endsection
