import { Cache } from '../support/cache.js'
import { uuid } from '../support/str.js'

/**
 * Progress and results of long-running background tasks (imports, exports, update checks), stored in the cache
 * so the web process can follow a job running in the queue worker.
 */
export interface Task {
    id: string
    user_id: number
    title: string
    status: 'queued' | 'running' | 'completed' | 'failed'
    done: number
    total: number
    message: string
    result: Record<string, unknown> | null
    errors: string[]
    updated_at: number
}

const TTL_SECONDS = 86400

const key = (id: string) => `solder-task:${id}`

async function put(id: string, task: Omit<Task, 'updated_at'>): Promise<void> {
    await Cache.put(key(id), { ...task, updated_at: Math.floor(Date.now() / 1000) }, TTL_SECONDS)
}

async function update(id: string, changes: Partial<Task>): Promise<void> {
    const task = await TaskTracker.get(id)
    if (task !== null) {
        await put(id, { ...task, ...changes })
    }
}

export const TaskTracker = {
    async create(userId: number, title: string): Promise<string> {
        const id = uuid()
        await put(id, {
            id,
            user_id: userId,
            title,
            status: 'queued',
            done: 0,
            total: 0,
            message: 'Waiting for a worker…',
            result: null,
            errors: [],
        })
        return id
    },

    async get(id: string): Promise<Task | null> {
        return Cache.get<Task>(key(id))
    },

    async progress(id: string, done: number, total: number, message: string): Promise<void> {
        await update(id, { status: 'running', done, total, message })
    },

    /**
     * @param result e.g. {url, message} or {path, filename}
     * @param errors Problems that didn't stop the task
     */
    async complete(id: string, result: Record<string, unknown>, errors: string[] = []): Promise<void> {
        const task = await TaskTracker.get(id)
        const total = Math.max(1, task?.total ?? 1)
        await update(id, {
            status: 'completed',
            done: total,
            total,
            message: typeof result.message === 'string' ? result.message : 'Done',
            result,
            errors,
        })
    },

    async fail(id: string, error: string): Promise<void> {
        await update(id, { status: 'failed', message: error, errors: [error] })
    },
}

/** A progress callback reporting to a task */
export type Progress = (done: number, total: number, message: string) => void | Promise<void>

export function taskProgress(taskId: string): Progress {
    return (done, total, message) => TaskTracker.progress(taskId, done, total, message)
}
