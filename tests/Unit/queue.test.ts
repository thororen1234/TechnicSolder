import { jobFailed, registerJob } from '../../src/jobs/queue.js'
import { useSolder } from '../support/helpers.js'

describe('Failed queue jobs', () => {
    useSolder({ seed: false })

    it('runs failed() for a job interrupted by a stopped worker', async () => {
        const failed = vi.fn(async () => {})
        const job = registerJob<{ taskId: string }>({ name: 'TestInterruptedJob', handle: async () => {}, failed })
        const error = new Error('job stalled more than allowable limit')

        await jobFailed({ id: '41', name: job.name, data: { taskId: 'abc' } }, error)

        expect(failed).toHaveBeenCalledWith({ taskId: 'abc' }, error)
    })

    it('ignores failures of unknown jobs', async () => {
        await expect(jobFailed({ id: '42', name: 'NoSuchJob', data: {} }, new Error('stalled'))).resolves.toBeUndefined()
        await expect(jobFailed(undefined, new Error('stalled'))).resolves.toBeUndefined()
    })

    it('keeps going when failed() itself throws', async () => {
        const job = registerJob({
            name: 'TestBrokenFailedJob',
            handle: async () => {},
            failed: async () => {
                throw new Error('database gone')
            },
        })

        await expect(jobFailed({ id: '43', name: job.name, data: {} }, new Error('stalled'))).resolves.toBeUndefined()
    })
})
