<?php

namespace App\Services;

use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

/**
 * Posts short notices to the Discord webhook in SOLDER_DISCORD_WEBHOOK. Does nothing when it isn't set,
 * and never lets a failed post interrupt what triggered it.
 */
class DiscordNotifier
{
    /** Embed colors */
    public const NEUTRAL = 0x737373;

    public const SUCCESS = 0x10B981;

    public const WARNING = 0xF59E0B;

    public const DANGER = 0xEF4444;

    public static function isConfigured(): bool
    {
        return ! empty(config('solder.discord_webhook'));
    }

    /**
     * @return bool Whether Discord accepted the message
     */
    public static function send(string $title, string $description, ?string $url = null, int $color = self::NEUTRAL): bool
    {
        if (! self::isConfigured()) {
            return false;
        }

        try {
            $response = Http::timeout(10)->post((string) config('solder.discord_webhook'), [
                'username' => 'Technic Solder',
                'embeds' => [array_filter([
                    'title' => Str::limit($title, 250),
                    'description' => Str::limit($description, 4000),
                    'url' => $url,
                    'color' => $color,
                    'timestamp' => now()->toIso8601String(),
                ])],
            ]);
        } catch (ConnectionException $e) {
            Log::warning('Could not reach the Discord webhook: '.$e->getMessage());

            return false;
        }

        if (! $response->successful()) {
            Log::warning("Discord webhook rejected a message (HTTP {$response->status()})");
        }

        return $response->successful();
    }
}
