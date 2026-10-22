@props(['import'])
@php
    $problems = count($import->problems ?? []);
    [$label, $class] = match ($import->status) {
        App\Models\ModpackImport::COMPLETED => $problems
            ? [$problems.' '.Str::plural('problem', $problems), 'ui-badge-warning']
            : ['Imported', 'ui-badge-success'],
        App\Models\ModpackImport::WAITING => ['Needs a decision', 'ui-badge-warning'],
        App\Models\ModpackImport::FAILED => ['Failed', 'ui-badge-danger'],
        App\Models\ModpackImport::CANCELLED => ['Cancelled', ''],
        default => ['In progress', 'ui-badge-primary'],
    };
@endphp
<span {{ $attributes->class(['ui-badge whitespace-nowrap', $class]) }}>{{ $label }}</span>
