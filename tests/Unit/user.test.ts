import { hashPassword, verifyPassword } from '../../src/auth/passwords.js'
import { db } from '../../src/database/prisma.js'
import { permissionFor } from '../../src/models/relations.js'
import { actingAs, admin, agent, flashed, flashedErrors, makeUser, redirectPath, useSolder } from '../support/helpers.js'

const NEW_PASSWORD = 'N3wP@ssw0rd!'

describe('Users', () => {
    useSolder()
    const as = async () => actingAs(await admin())
    const permission = async (userId: number) => (await permissionFor(userId))!

    it('redirects the index to the list and shows the list and create form', async () => {
        expect(redirectPath(await (await as()).get('/user'))).toBe('/user/list')
        await (await as()).get('/user/list').expect(200)
        await (await as()).get('/user/create').expect(200)
    })

    it('hints a new password on the create form', async () => {
        const response = await (await as()).get('/user/create').expect(200)
        expect(response.text.split('autocomplete="new-password"').length - 1).toBe(1)
    })

    it('rejects a duplicate email or username', async () => {
        const email = await (await as()).post('/user/create', { email: 'admin@example.com', username: 'test', password: 'B3sTp@ss' })
        expect(redirectPath(email)).toBe('/user/create')
        expect(flashedErrors(email)).toHaveProperty('email')
        const username = await (await as()).post('/user/create', { email: 'test@example.com', username: 'admin', password: 'B3sTp@ss' })
        expect(redirectPath(username)).toBe('/user/create')
        expect(flashedErrors(username)).toHaveProperty('username')
    })

    it('creates a user', async () => {
        const response = await (await as()).post('/user/create', { email: 'test@example.com', username: 'test', password: 'B3sTp@ss' })
        expect(redirectPath(response)).toBe('/user/edit/2')
        expect(flashed(response)).toHaveProperty('success')
    })

    it('shows the edit form with password manager hints', async () => {
        const response = await (await as()).get('/user/edit/1').expect(200)
        expect(response.text.split('autocomplete="new-password"').length - 1).toBe(2)
        expect(response.text.split('autocomplete="current-password"').length - 1).toBe(2)
    })

    it('rejects a duplicate email when editing', async () => {
        await makeUser({}, { email: 'test@example.com', username: 'test' })
        const response = await (await as()).post('/user/edit/1', { email: 'test@example.com', username: 'test' })
        expect(redirectPath(response)).toBe('/user/edit/1')
        expect(flashedErrors(response)).toHaveProperty('email')
    })

    it('rejects a duplicate username when editing', async () => {
        const user = await makeUser({}, { email: 'test@example.com', username: 'test' })
        const response = await (await as()).post(`/user/edit/${user.id}`, { email: 'test@example.com', username: 'admin' })
        expect(redirectPath(response)).toBe(`/user/edit/${user.id}`)
        expect(flashedErrors(response)).toHaveProperty('username')
    })

    it('edits a user without touching their permissions', async () => {
        await db.userPermission.updateMany({ where: { user_id: 1 }, data: { solder_users: true, mods_manage: true } })
        const response = await (await as()).post('/user/edit/1', { email: 'admin2@example.com', username: 'admin2' })
        expect(redirectPath(response)).toBe('/user/edit/1')
        expect(flashed(response)).toHaveProperty('success')
        expect(await permission(1)).toMatchObject({ solder_full: true, solder_users: true, mods_manage: true })
    })

    it('keeps the last superadmin from demoting themselves', async () => {
        const remaining = await makeUser({ solder_full: true }, { email: 'remaining-admin@example.com', username: 'remaining-admin' })
        expect(flashed(await actingAs(remaining).post('/user/delete/1'))).toHaveProperty('success')
        const response = await actingAs(remaining).post(`/user/edit/${remaining.id}`, {
            'permissions-present': '1',
            email: 'changed@example.com',
            username: remaining.username,
        })
        expect(redirectPath(response)).toBe(`/user/edit/${remaining.id}`)
        expect(flashedErrors(response)).toHaveProperty('solder-full')
        expect((await db.user.findUniqueOrThrow({ where: { id: remaining.id } })).email).toBe('remaining-admin@example.com')
        expect((await permission(remaining.id)).solder_full).toBe(true)
    })

    it('demotes user 1 when another superadmin exists', async () => {
        const other = await makeUser({ solder_full: true }, { email: 'other-admin@example.com', username: 'other-admin' })
        const response = await (await as()).post('/user/edit/1', { 'permissions-present': '1', email: 'admin@example.com', username: 'admin' })
        expect(redirectPath(response)).toBe('/user/edit/1')
        expect(flashedErrors(response)).toEqual({})
        expect(flashed(response)).toHaveProperty('success')
        expect((await permission(1)).solder_full).toBe(false)
        expect((await permission(other.id)).solder_full).toBe(true)
    })

    it('does not promote user 1 when a manager edits them', async () => {
        await db.userPermission.updateMany({ where: { user_id: 1 }, data: { solder_full: false } })
        const manager = await makeUser({ solder_users: true }, { email: 'manager@example.com', username: 'manager' })
        const response = await actingAs(manager).post('/user/edit/1', { 'permissions-present': '1', email: 'admin@example.com', username: 'admin' })
        expect(redirectPath(response)).toBe('/user/list')
        expect(flashedErrors(response)).toEqual({})
        expect(flashed(response)).toHaveProperty('success')
        expect((await permission(1)).solder_full).toBe(false)
    })

    describe('changing passwords', () => {
        const change = async (userId: number, currentPassword?: unknown) =>
            (await as()).post(`/user/edit/${userId}`, {
                email: (await db.user.findUniqueOrThrow({ where: { id: userId } })).email,
                username: (await db.user.findUniqueOrThrow({ where: { id: userId } })).username,
                ...(currentPassword === undefined ? {} : { current_password: currentPassword }),
                password1: NEW_PASSWORD,
                password2: NEW_PASSWORD,
            })
        const passwordIs = async (userId: number, password: string) => verifyPassword(password, (await db.user.findUniqueOrThrow({ where: { id: userId } })).password)

        it.each([
            ['missing', undefined],
            ['wrong', 'not-my-password'],
            ['an array', ['x']],
        ])('needs the current password (%s)', async (_name, current) => {
            const response = await change(1, current)
            expect(redirectPath(response)).toBe('/user/edit/1')
            expect(flashedErrors(response)).toHaveProperty('current_password')
            expect(await passwordIs(1, 'admin')).toBe(true)
        })

        it('changes the password with the current one', async () => {
            const response = await change(1, 'admin')
            expect(flashedErrors(response)).toEqual({})
            expect(redirectPath(response)).toBe('/user/edit/1')
            expect(await passwordIs(1, NEW_PASSWORD)).toBe(true)
        })

        it("takes the admin's own password when changing someone else's", async () => {
            const target = await makeUser({}, { email: 'target@example.com', username: 'target', password: await hashPassword('targetpassword') })
            expect(flashedErrors(await change(target.id, 'admin'))).toEqual({})
            expect(await passwordIs(target.id, NEW_PASSWORD)).toBe(true)
        })

        it("rejects the target's own password", async () => {
            const target = await makeUser({}, { email: 'target2@example.com', username: 'target2', password: await hashPassword('targetpassword') })
            expect(flashedErrors(await change(target.id, 'targetpassword'))).toHaveProperty('current_password')
            expect(await passwordIs(target.id, 'targetpassword')).toBe(true)
        })
    })

    describe('deleting', () => {
        it('shows the delete page and redirects for an unknown user', async () => {
            const user = await makeUser({}, { email: 'test@example.com', username: 'test' })
            await (await as()).get(`/user/delete/${user.id}`).expect(200)
            expect(redirectPath(await (await as()).get('/user/delete/100000'))).toBe('/user/list')
            expect(redirectPath(await (await as()).post('/user/delete/100000'))).toBe('/user/list')
        })

        it('deletes a user', async () => {
            const user = await makeUser({}, { email: 'test@example.com', username: 'test' })
            const response = await (await as()).post(`/user/delete/${user.id}`)
            expect(redirectPath(response)).toBe('/user/list')
            expect(flashed(response)).toHaveProperty('success')
        })

        it('keeps a manager from deleting a superadmin', async () => {
            const manager = await makeUser({ solder_users: true })
            expect(redirectPath(await actingAs(manager).post('/user/delete/1'))).toBe('/dashboard')
            expect(await db.user.count({ where: { id: 1 } })).toBe(1)
        })

        it('keeps users from deleting themselves', async () => {
            const self = await (await as()).post('/user/delete/1')
            expect(redirectPath(self)).toBe('/user/list')
            expect(Object.keys(flashedErrors(self)).length).toBeGreaterThan(0)
            const manager = await makeUser({ solder_users: true })
            const managerSelf = await actingAs(manager).post(`/user/delete/${manager.id}`)
            expect(redirectPath(managerSelf)).toBe('/user/list')
            expect(Object.keys(flashedErrors(managerSelf)).length).toBeGreaterThan(0)
            expect(await db.user.count({ where: { id: { in: [1, manager.id] } } })).toBe(2)
            const confirmation = await (await as()).get('/user/delete/1')
            expect(redirectPath(confirmation)).toBe('/user/list')
            expect(Object.keys(flashedErrors(confirmation)).length).toBeGreaterThan(0)
        })

        it('lets another superadmin delete user 1', async () => {
            const other = await makeUser({ solder_full: true }, { email: 'test@example.com', username: 'test' })
            expect(other.id).toBe(2)
            const response = await actingAs(other).post('/user/delete/1')
            expect(redirectPath(response)).toBe('/user/list')
            expect(flashed(response)).toHaveProperty('success')
        })
    })

    it('creates another superadmin', async () => {
        const response = await (await as()).post('/user/create', {
            email: 'test-sadmin@example.com',
            username: 'sadmin',
            password: 'B3sT3Re4p@ss',
            'permissions-present': '1',
            'solder-full': '1',
        })
        expect(redirectPath(response)).toBe('/user/edit/2')
        expect(flashed(response)).toHaveProperty('success')
    })

    it('lets a created user sign in', async () => {
        await (await as()).post('/user/create', { email: 'logintest@example.com', username: 'logintest', password: 'TestPassword123' })
        const browser = agent()
        expect(redirectPath(await browser.post('/login', { email: 'logintest@example.com', password: 'TestPassword123' }))).toBe('/dashboard')
        expect(await browser.isAuthenticated()).toBe(true)
        // Signed in as the new user, not the admin who created it
        const created = await db.user.findFirstOrThrow({ where: { username: 'logintest' } })
        expect((await browser.get(`/user/edit/${created.id}`)).status).toBe(200)
        expect(redirectPath(await browser.get('/user/edit/1'))).toBe('/dashboard')
    })
})
