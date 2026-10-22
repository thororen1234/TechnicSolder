<?php

use App\Http\Middleware\Cors;
use App\Http\Middleware\ForceJsonResponse;
use App\Http\Middleware\RequireMail;
use App\Http\Middleware\SecurityHeaders;
use App\Models\ModpackImport;
use App\Providers\AppServiceProvider;
use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;
use Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        health: '/up',
    )
    ->withSchedule(function (Schedule $schedule): void {
        if (config('solder.scheduled_update_checks')) {
            $schedule->command('solder:check-updates')->dailyAt('04:00')->withoutOverlapping();
        }

        $schedule->call(fn () => ModpackImport::cancelAbandoned())->daily()->name('cancel-abandoned-imports');
    })
    ->withMiddleware(function (Middleware $middleware): void {
        $middleware->trustProxies(at: '*');

        $middleware->redirectTo(
            guests: fn () => route('login'),
            users: AppServiceProvider::HOME,
        );

        $middleware->append(SecurityHeaders::class);
        $middleware->web(RequireMail::class);

        $middleware->throttleApi();
        $middleware->api(prepend: [
            ForceJsonResponse::class,
        ]);
        $middleware->api(Cors::class);

        $middleware->alias([
            'cors' => Cors::class,
        ]);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->shouldRenderJsonWhen(
            fn (Request $request) => $request->is('api', 'api/*') || $request->expectsJson(),
        );

        $exceptions->renderable(function (AccessDeniedHttpException $e, $request) {
            if (! $request->expectsJson()) {
                return redirect('dashboard')
                    ->with('permission', 'You do not have permission to access this area.');
            }
        });
    })->create();
