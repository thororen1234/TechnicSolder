import { config } from '../config.js'
import { Cache } from '../support/cache.js'
import { toIso8601String } from '../support/dates.js'
import { ConnectionError, request, type HttpResponse } from '../support/http.js'
import { logger } from '../support/logger.js'
import { limit } from '../support/str.js'

/**
 * Sends short notices to Discord: posted to the webhook in SOLDER_DISCORD_WEBHOOK and/or sent as direct messages
 * by the bot in SOLDER_DISCORD_BOT_TOKEN to the users in SOLDER_DISCORD_USER_ID. Does nothing when neither is set,
 * and never lets a failed message interrupt what triggered it.
 */

/** Embed colors */
export const NEUTRAL = 0x737373
export const SUCCESS = 0x10b981
export const WARNING = 0xf59e0b
export const DANGER = 0xef4444

const API_URL = 'https://discord.com/api/v10'

function hasWebhook(): boolean {
    return Boolean(config.solder.discord_webhook)
}

/** Discord user IDs to message, from a comma-separated SOLDER_DISCORD_USER_ID */
function directMessageUserIds(): string[] {
    return String(config.solder.discord_user_id ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id !== '' && id !== '0')
}

function sendsDirectMessages(): boolean {
    return Boolean(config.solder.discord_bot_token) && directMessageUserIds().length > 0
}

export function isConfigured(): boolean {
    return hasWebhook() || sendsDirectMessages()
}

/** The response, or null when Discord couldn't be reached or refused the request */
async function send(via: 'webhook' | 'bot', url: string, body: unknown, headers: Record<string, string> = {}): Promise<HttpResponse | null> {
    let response: HttpResponse
    try {
        response = await request(url, { method: 'POST', json: body, headers, timeout: 10 })
    } catch (error) {
        if (error instanceof ConnectionError) {
            logger.warn(`Could not reach Discord (${via}): ${error.message}`)
            return null
        }
        throw error
    }
    if (!response.ok) {
        logger.warn(`Discord rejected a message (${via}, HTTP ${response.status}): ${limit(await response.text(), 300)}`)
        return null
    }
    return response
}

function botHeaders(): Record<string, string> {
    return { Authorization: `Bot ${config.solder.discord_bot_token}` }
}

async function sendDirectMessage(userId: string, embed: Record<string, unknown>): Promise<boolean> {
    const cacheKey = `solder-discord-dm-channel:${userId}`
    let channelId = await Cache.get<string>(cacheKey)
    if (channelId === null) {
        const response = await send('bot', `${API_URL}/users/@me/channels`, { recipient_id: userId }, botHeaders())
        channelId = response ? ((await response.json<{ id?: string }>()).id ?? null) : null
        if (channelId === null) {
            return false
        }
        await Cache.forever(cacheKey, channelId)
    }
    const sent = (await send('bot', `${API_URL}/channels/${channelId}/messages`, { embeds: [embed] }, botHeaders())) !== null
    if (!sent) {
        // The channel may be gone; open a new one next time
        await Cache.forget(cacheKey)
    }
    return sent
}

/** @returns Whether every configured destination accepted the message */
export async function notify(title: string, description: string, url: string | null = null, color = NEUTRAL): Promise<boolean> {
    if (!isConfigured()) {
        return false
    }
    const embed: Record<string, unknown> = Object.fromEntries(
        Object.entries({
            title: limit(title, 250),
            description: limit(description, 4000),
            url,
            color,
            timestamp: toIso8601String(),
        }).filter(([, value]) => Boolean(value)),
    )
    let sent = true
    if (hasWebhook()) {
        sent = (await send('webhook', String(config.solder.discord_webhook), { username: 'Technic Solder', embeds: [embed] })) !== null
    }
    if (config.solder.discord_bot_token) {
        for (const userId of directMessageUserIds()) {
            sent = (await sendDirectMessage(userId, embed)) && sent
        }
    }
    return sent
}

export const DiscordNotifier = { isConfigured, send: notify, NEUTRAL, SUCCESS, WARNING, DANGER }
