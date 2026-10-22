<?php

namespace App\Services;

use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

/**
 * Sends short notices to Discord: posted to the webhook in SOLDER_DISCORD_WEBHOOK and/or sent as direct messages
 * by the bot in SOLDER_DISCORD_BOT_TOKEN to the users in SOLDER_DISCORD_USER_ID. Does nothing when neither is set,
 * and never lets a failed message interrupt what triggered it.
 */
class DiscordNotifier
{
    /** Embed colors */
    public const NEUTRAL = 0x737373;

    public const SUCCESS = 0x10B981;

    public const WARNING = 0xF59E0B;

    public const DANGER = 0xEF4444;

    private const API_URL = 'https://discord.com/api/v10';

    public static function isConfigured(): bool
    {
        return self::hasWebhook() || self::sendsDirectMessages();
    }

    public static function hasWebhook(): bool
    {
        return ! empty(config('solder.discord_webhook'));
    }

    public static function sendsDirectMessages(): bool
    {
        return ! empty(config('solder.discord_bot_token')) && self::directMessageUserIds() !== [];
    }

    /**
     * @return bool Whether every configured destination accepted the message
     */
    public static function send(string $title, string $description, ?string $url = null, int $color = self::NEUTRAL): bool
    {
        if (! self::isConfigured()) {
            return false;
        }

        $embed = array_filter([
            'title' => Str::limit($title, 250),
            'description' => Str::limit($description, 4000),
            'url' => $url,
            'color' => $color,
            'timestamp' => now()->toIso8601String(),
        ]);

        $sent = true;

        if (self::hasWebhook()) {
            $sent = self::request('webhook', fn () => Http::timeout(10)->post((string) config('solder.discord_webhook'), [
                'username' => 'Technic Solder',
                'embeds' => [$embed],
            ])) !== null;
        }

        if (! empty(config('solder.discord_bot_token'))) {
            foreach (self::directMessageUserIds() as $userId) {
                $sent = self::sendDirectMessage($userId, $embed) && $sent;
            }
        }

        return $sent;
    }

    /**
     * @return list<string> Discord user IDs to message, from a comma-separated SOLDER_DISCORD_USER_ID
     */
    private static function directMessageUserIds(): array
    {
        return array_values(array_filter(array_map('trim', explode(',', (string) config('solder.discord_user_id')))));
    }

    /**
     * @param  array<string, mixed>  $embed
     */
    private static function sendDirectMessage(string $userId, array $embed): bool
    {
        $cacheKey = "solder-discord-dm-channel:$userId";
        $channelId = Cache::get($cacheKey);

        if ($channelId === null) {
            $channelId = self::request('bot', fn () => self::bot()->post(self::API_URL.'/users/@me/channels', ['recipient_id' => $userId]))?->json('id');

            if ($channelId === null) {
                return false;
            }

            Cache::forever($cacheKey, $channelId);
        }

        $sent = self::request('bot', fn () => self::bot()->post(self::API_URL."/channels/$channelId/messages", ['embeds' => [$embed]])) !== null;
        if (! $sent) {
            // The channel may be gone; open a new one next time
            Cache::forget($cacheKey);
        }

        return $sent;
    }

    private static function bot(): PendingRequest
    {
        return Http::timeout(10)->withHeaders(['Authorization' => 'Bot '.config('solder.discord_bot_token')]);
    }

    /**
     * @param  'webhook'|'bot'  $via
     * @param  callable(): Response  $send
     * @return Response|null The response, or null when Discord couldn't be reached or refused the request
     */
    private static function request(string $via, callable $send): ?Response
    {
        try {
            $response = $send();
        } catch (ConnectionException $e) {
            Log::warning("Could not reach Discord ($via): ".$e->getMessage());

            return null;
        }

        if (! $response->successful()) {
            Log::warning("Discord rejected a message ($via, HTTP {$response->status()}): ".Str::limit($response->body(), 300));

            return null;
        }

        return $response;
    }
}
