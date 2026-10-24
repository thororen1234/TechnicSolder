import { loadEnv } from '../../src/config.js'

describe('Loading the env file', () => {
    const names = ['SOLDER_TEST_NAME', 'SOLDER_TEST_FROM', 'SOLDER_TEST_KEY', 'SOLDER_TEST_SET', 'SOLDER_TEST_UNKNOWN']
    afterEach(() => {
        for (const name of names) {
            delete process.env[name]
        }
    })

    it('expands references to earlier variables', () => {
        loadEnv('SOLDER_TEST_NAME="Technic Solder"\nSOLDER_TEST_FROM="${SOLDER_TEST_NAME} Mailer"\nSOLDER_TEST_UNKNOWN="${SOLDER_TEST_MISSING}x"')
        expect(process.env.SOLDER_TEST_FROM).toBe('Technic Solder Mailer')
        expect(process.env.SOLDER_TEST_UNKNOWN).toBe('x')
    })

    it('keeps a bare dollar sign', () => {
        loadEnv("SOLDER_TEST_KEY=$2a$10$HQZWabc\nSOLDER_TEST_NAME='$2a$10$quoted'")
        expect(process.env.SOLDER_TEST_KEY).toBe('$2a$10$HQZWabc')
        expect(process.env.SOLDER_TEST_NAME).toBe('$2a$10$quoted')
    })

    it('does not override variables that are already set', () => {
        process.env.SOLDER_TEST_SET = 'from docker'
        loadEnv('SOLDER_TEST_SET=from file')
        expect(process.env.SOLDER_TEST_SET).toBe('from docker')
    })
})
