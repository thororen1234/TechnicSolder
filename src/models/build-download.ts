import { db, dialect } from '../database/prisma.js'
import { toDateString } from '../support/dates.js'

/**
 * How many times the launcher fetched a build on a given day (GET /api/modpack/{slug}/{version}).
 */

/** Count one launcher request for a build today, in a single query */
export async function recordBuildDownload(buildId: number): Promise<void> {
    const today = toDateString(new Date())
    if (dialect() === 'mysql') {
        await db.$executeRawUnsafe(
            'INSERT INTO build_downloads (build_id, date, count) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE count = count + 1',
            buildId,
            today,
        )
        return
    }
    const placeholders = dialect() === 'postgresql' ? ['$1', '$2::date'] : ['?', '?']
    await db.$executeRawUnsafe(
        `INSERT INTO build_downloads (build_id, date, count) VALUES (${placeholders[0]}, ${placeholders[1]}, 1) ` +
            'ON CONFLICT (build_id, date) DO UPDATE SET count = build_downloads.count + 1',
        buildId,
        today,
    )
}

interface DownloadRow {
    build_id: number | bigint
    date: Date | string
    count: number | bigint | string
}

async function rowsSince(buildIds: number[], days: number): Promise<DownloadRow[]> {
    if (buildIds.length === 0) {
        return []
    }
    const since = new Date()
    since.setUTCDate(since.getUTCDate() - days)
    const ids = buildIds.map(Number).filter(Number.isInteger)
    const cutoff = toDateString(since)
    const cast = dialect() === 'postgresql' ? '::date' : ''
    const param = dialect() === 'postgresql' ? '$1' : '?'
    return db.$queryRawUnsafe<DownloadRow[]>(
        `SELECT build_id, date, count FROM build_downloads WHERE build_id IN (${ids.join(',')}) AND date > ${param}${cast}`,
        cutoff,
    )
}

function dateKey(date: Date | string): string {
    return date instanceof Date ? toDateString(date) : String(date).slice(0, 10)
}

/** Total requests per build over the last $days days: build ID => count */
export async function buildDownloadTotals(buildIds: number[], days = 30): Promise<Record<number, number>> {
    const totals: Record<number, number> = {}
    for (const row of await rowsSince(buildIds, days)) {
        totals[Number(row.build_id)] = (totals[Number(row.build_id)] ?? 0) + Number(row.count)
    }
    return totals
}

/** Requests per day for one build over the last $days days, oldest first, including empty days: Y-m-d => count */
export async function buildDownloadsDaily(buildId: number, days = 30): Promise<Record<string, number>> {
    const counts = new Map<string, number>()
    for (const row of await rowsSince([buildId], days)) {
        counts.set(dateKey(row.date), Number(row.count))
    }
    const series: Record<string, number> = {}
    for (let day = days - 1; day >= 0; day--) {
        const date = new Date()
        date.setUTCDate(date.getUTCDate() - day)
        const key = toDateString(date)
        series[key] = counts.get(key) ?? 0
    }
    return series
}
