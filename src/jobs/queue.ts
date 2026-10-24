import { Queue as BullQueue, Worker, type Job } from 'bullmq'
import { config } from '../config.js'
import { runWithContext } from '../http/context.js'
import { logger } from '../support/logger.js'

/**
 * Background jobs. With QUEUE_CONNECTION=redis they go to Redis and run in the worker process (`pnpm worker`);
 * otherwise (sync) they run straight away, during the request that dispatched them.
 */
export interface JobDefinition<Payload> {
    name: string
    handle(payload: Payload): Promise<unknown>
    /** Called when handle() throws, like a Laravel job's failed() */
    failed?(payload: Payload, error: Error): Promise<void>
}

const QUEUE_NAME = 'default'
/**
 * BullMQ renews a running job's lock every half of this, so it only decides how soon a job interrupted by a stopped
 * worker is noticed (and failed), and how long the event loop may stall before a running job counts as interrupted.
 */
const LOCK_DURATION_MS = 5 * 60 * 1000

const registry = new Map<string, JobDefinition<never>>()

export function registerJob<Payload>(job: JobDefinition<Payload>): JobDefinition<Payload> {
    registry.set(job.name, job as JobDefinition<never>)
    return job
}

let queue: BullQueue | null = null

function connection() {
    return { host: config.redis.host, port: config.redis.port, password: config.redis.password }
}

async function runJob<Payload>(job: JobDefinition<Payload>, payload: Payload): Promise<unknown> {
    try {
        return await runWithContext({ userId: null }, () => job.handle(payload))
    } catch (error) {
        await job.failed?.(payload, error instanceof Error ? error : new Error(String(error)))
        throw error
    }
}

let faked: { name: string; payload: unknown }[] | null = null

/** For tests, like Laravel's Queue::fake(): dispatched jobs are recorded instead of run */
export const Queue = {
    fake(): void {
        faked = []
    },
    pushed<Payload>(job: JobDefinition<Payload>): Payload[] {
        return (faked ?? []).filter((entry) => entry.name === job.name).map((entry) => entry.payload as Payload)
    },
    reset(): void {
        faked = null
    },
}

/** Queue a job, or with the sync queue run it now (rethrowing its error after failed() ran) */
export async function dispatch<Payload>(job: JobDefinition<Payload>, payload: Payload): Promise<void> {
    if (faked !== null) {
        faked.push({ name: job.name, payload })
        return
    }
    if (config.queueConnection === 'sync') {
        await runJob(job, payload)
        return
    }
    queue ??= new BullQueue(QUEUE_NAME,{ connection: connection() })
    await queue.add(job.name, payload, { attempts: 1, removeOnComplete: 1000, removeOnFail: 1000 })
}

/**
 * Dispatch a job from a request. With the sync queue it runs right away, and a failure is recorded on its task by
 * the job's failed handler rather than surfacing as an error page.
 */
export async function runTask<Payload>(job: JobDefinition<Payload>, payload: Payload): Promise<void> {
    try {
        await dispatch(job, payload)
    } catch (error) {
        logger.report(error)
    }
}

/** Process queued jobs until the process is stopped */
export function startWorker(): Worker {
    const worker = new Worker(
        QUEUE_NAME,
        async (job: Job) => {
            const definition = registry.get(job.name)
            if (!definition) {
                throw new Error(`Unknown job "${job.name}"`)
            }
            logger.info(`Processing ${job.name} (${job.id})`)
            try {
                return await runJob(definition, job.data as never)
            } catch (error) {
                failureHandled.add(String(job.id))
                throw error
            }
        },
        // An interrupted job fails rather than starting over on top of its half-finished work
        { connection: connection(), concurrency: 1, lockDuration: LOCK_DURATION_MS, maxStalledCount: 0 },
    )
    worker.on('failed', (job, error) => void jobFailed(job, error))
    return worker
}

/** Jobs whose failed() already ran in the worker, so the "failed" event doesn't run it again */
const failureHandled = new Set<string>()

/**
 * Log a failed job, and run its failed() when handle() never got to throw: the worker running it stopped (a crash
 * or a deploy) and BullMQ failed the interrupted job, which would otherwise leave its task "running" forever.
 */
export async function jobFailed(job: Pick<Job, 'id' | 'name' | 'data'> | undefined, error: Error): Promise<void> {
    logger.error(`${job?.name} (${job?.id}) failed: ${error.message}`)
    if (job === undefined || failureHandled.delete(String(job.id))) {
        return
    }
    const definition = registry.get(job.name)
    try {
        await runWithContext({ userId: null }, async () => definition?.failed?.(job.data as never, error))
    } catch (failure) {
        logger.report(failure)
    }
}

export async function closeQueue(): Promise<void> {
    await queue?.close()
    queue = null
}
