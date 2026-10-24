import { db } from '../../src/database/prisma.js'
import { modpackIds } from '../../src/models/permissions.js'
import { permissionFor } from '../../src/models/relations.js'
import { actingAs, admin, client, makeUser, redirectPath, useSolder } from '../support/helpers.js'

type Get = { get(url: string): PromiseLike<{ status: number; headers: Record<string, string | string[] | undefined> }> }

async function expectRedirect(request: PromiseLike<{ status: number; headers: Record<string, string | string[] | undefined> }>, path: string): Promise<void> {
    const response = await request
    expect(response.status).toBe(302)
    expect(redirectPath(response)).toBe(path)
}

async function expectOk(request: PromiseLike<{ status: number }>): Promise<void> {
    expect((await request).status).toBe(200)
}

describe('Authorization', () => {
    useSolder()

    it('sends guests to the login page', async () => {
        for (const path of ['/dashboard', '/mod/list', '/mod/create', '/modpack/list', '/modpack/create', '/key/list', '/client/list', '/user/list', '/solder/configure']) {
            await expectRedirect(client().get(path), '/login')
        }
    })

    it.each([
        ['mods_create', '/mod/create', true],
        ['mods_create', '/mod/delete/1', false],
        ['mods_manage', '/mod/list', true],
        ['mods_manage', '/mod/create', false],
        ['mods_delete', '/mod/delete/1', true],
        ['modpacks_create', '/modpack/create', true],
        ['modpacks_create', '/modpack/edit/1', false],
        ['modpacks_manage', '/modpack/list', true],
        ['modpacks_delete', '/modpack/list', false],
        ['solder_keys', '/key/list', true],
        ['solder_clients', '/client/list', true],
        ['solder_users', '/user/list', true],
        ['mods_manage', '/modpack/list', false],
        ['solder_clients', '/key/list', false],
        ['modpacks_manage', '/modpack/view/1', false],
        ['modpacks_manage', '/modpack/build/1', false],
    ])('a user with %s %s', async (flag, path, allowed) => {
        const user = await makeUser({ [flag]: true })
        if (allowed) {
            await expectOk(actingAs(user).get(path))
        } else {
            await expectRedirect(actingAs(user).get(path), '/dashboard')
        }
    })

    it('gives a user without permissions only the dashboard and their own profile', async () => {
        const user = await makeUser()
        const as: Get = actingAs(user)
        await expectOk(as.get('/dashboard'))
        await expectOk(as.get(`/user/edit/${user.id}`))
        for (const path of ['/mod/list', '/modpack/list', '/key/list', '/client/list', '/user/list', '/user/edit/1']) {
            await expectRedirect(as.get(path), '/dashboard')
        }
    })

    it('does not reveal whether a user exists', async () => {
        const user = await makeUser()
        const target = await makeUser()
        await expectRedirect(actingAs(user).get(`/user/edit/${target.id}`), '/dashboard')
        await expectRedirect(actingAs(user).get('/user/edit/999999'), '/dashboard')
        await expectRedirect(actingAs(user).post(`/user/edit/${target.id}`), '/dashboard')
        await expectRedirect(actingAs(user).post('/user/edit/999999'), '/dashboard')
    })

    it('lets a superadmin in everywhere', async () => {
        const as = actingAs(await admin())
        for (const path of ['/mod/list', '/mod/create', '/modpack/list', '/modpack/create', '/key/list', '/client/list', '/user/list', '/modpack/view/1']) {
            await expectOk(as.get(path))
        }
    })

    it('lets a modpack manager view a modpack they were given', async () => {
        const user = await makeUser({ modpacks_manage: true, modpacks: [1] })
        await expectOk(actingAs(user).get('/modpack/view/1'))
    })

    it('keeps users from giving themselves permissions', async () => {
        const user = await makeUser()
        await actingAs(user).post(`/user/edit/${user.id}`, { 'permissions-present': '1', email: user.email, username: user.username, 'solder-full': 'on' })
        expect((await permissionFor(user.id))!.solder_full).toBe(false)
    })

    describe('mod versions need mods_manage', () => {
        async function seedModversion() {
            const mod = await db.mod.create({ data: { name: 'authztest', pretty_name: 'AuthZ Test' } })
            return db.modversion.create({ data: { mod_id: mod.id, version: '1.0', md5: 'a'.repeat(32), filesize: 100 } })
        }

        it('denies changes without it', async () => {
            const user = await makeUser({ mods_create: true })
            const version = await seedModversion()
            const as = actingAs(user, { ajax: true })
            await expectRedirect(as.post('/mod/add-version', { 'mod-id': version.mod_id, 'add-version': '2.0', 'add-md5': 'c'.repeat(32) }), '/dashboard')
            expect(await db.modversion.count({ where: { mod_id: version.mod_id, version: '2.0' } })).toBe(0)
            await expectRedirect(as.post('/mod/rehash', { 'version-id': version.id, md5: 'b'.repeat(32) }), '/dashboard')
            await expectRedirect(as.post(`/mod/update-version/${version.id}`, { notes: 'tampered' }), '/dashboard')
            await expectRedirect(as.post(`/mod/delete-version/${version.id}`), '/dashboard')
            expect(await db.modversion.count({ where: { id: version.id } })).toBe(1)
        })

        it('allows them with it', async () => {
            const user = await makeUser({ mods_manage: true })
            const version = await seedModversion()
            const as = actingAs(user, { ajax: true })
            const added = await as.post('/mod/add-version', { 'mod-id': version.mod_id, 'add-version': '2.0', 'add-md5': 'c'.repeat(32) }).expect(200)
            expect(added.body.status).toBe('success')
            const deleted = await as.post(`/mod/delete-version/${version.id}`).expect(200)
            expect(deleted.body.status).toBe('success')
            expect(await db.modversion.count({ where: { id: version.id } })).toBe(0)
        })
    })

    describe('granting permissions', () => {
        it('clamps what a manager grants on create to what they hold', async () => {
            const actor = await makeUser({ solder_users: true, mods_manage: true })
            await actingAs(actor).post('/user/create', {
                'permissions-present': '1',
                username: 'delegated',
                email: 'delegated@example.com',
                password: 'B3sTp@ss',
                'manage-users': 'on',
                'mod-manage': 'on',
                'mod-delete': 'on',
                'manage-keys': 'on',
                'solder-full': 'on',
            })
            const user = await db.user.findFirstOrThrow({ where: { email: 'delegated@example.com' } })
            expect(await permissionFor(user.id)).toMatchObject({ solder_users: true, mods_manage: true, mods_delete: false, solder_keys: false, solder_full: false })
        })

        it('clamps what a manager grants on edit', async () => {
            const actor = await makeUser({ solder_users: true, mods_manage: true })
            const target = await makeUser({ mods_manage: true })
            await actingAs(actor).post(`/user/edit/${target.id}`, {
                'permissions-present': '1',
                username: target.username,
                email: target.email,
                'mod-manage': 'on',
                'mod-delete': 'on',
                'manage-keys': 'on',
            })
            expect(await permissionFor(target.id)).toMatchObject({ mods_manage: true, mods_delete: false, solder_keys: false })
        })

        it('keeps a manager from escalating their own permissions', async () => {
            const actor = await makeUser({ solder_users: true, mods_manage: true })
            await actingAs(actor).post(`/user/edit/${actor.id}`, {
                'permissions-present': '1',
                username: actor.username,
                email: actor.email,
                'manage-users': 'on',
                'mod-manage': 'on',
                'mod-delete': 'on',
                'solder-full': 'on',
            })
            expect(await permissionFor(actor.id)).toMatchObject({ solder_users: true, mods_manage: true, mods_delete: false, solder_full: false })
        })

        it('clamps the modpacks a manager grants to their own', async () => {
            const packA = await db.modpack.create({ data: { name: 'Clamp Pack A', slug: 'clamp-pack-a' } })
            const packB = await db.modpack.create({ data: { name: 'Clamp Pack B', slug: 'clamp-pack-b' } })
            const actor = await makeUser({ solder_users: true, modpacks_manage: true, modpacks: [packA.id] })
            await actingAs(actor).post('/user/create', {
                'permissions-present': '1',
                username: 'scoped',
                email: 'scoped@example.com',
                password: 'B3sTp@ss',
                'modpack-manage': 'on',
                modpack: [packA.id, packB.id],
            })
            const user = await db.user.findFirstOrThrow({ where: { email: 'scoped@example.com' } })
            const packs = modpackIds(await permissionFor(user.id))
            expect(packs).toContain(packA.id)
            expect(packs).not.toContain(packB.id)
        })

        it('lets a superadmin grant anything', async () => {
            await actingAs(await admin()).post('/user/create', {
                'permissions-present': '1',
                username: 'fullgrant',
                email: 'fullgrant@example.com',
                password: 'B3sTp@ss',
                'mod-delete': 'on',
                'modpack-delete': 'on',
                'manage-keys': 'on',
            })
            const user = await db.user.findFirstOrThrow({ where: { email: 'fullgrant@example.com' } })
            expect(await permissionFor(user.id)).toMatchObject({ mods_delete: true, modpacks_delete: true, solder_keys: true })
        })
    })

    describe('managing users', () => {
        it('keeps a manager from editing a more privileged user', async () => {
            const actor = await makeUser({ solder_users: true })
            await expectRedirect(actingAs(actor).get('/user/edit/1'), '/dashboard')
            await expectRedirect(actingAs(actor).post('/user/edit/1', { username: 'admin', email: 'admin@example.com' }), '/dashboard')
            const target = await makeUser({ solder_users: true, mods_delete: true })
            await expectRedirect(actingAs(actor).post(`/user/edit/${target.id}`, { username: target.username, email: target.email }), '/dashboard')
        })

        it('only lets a manager reset two-factor authentication of users they manage', async () => {
            const actor = await makeUser({ solder_users: true })
            await expectRedirect(actingAs(actor).post('/user/1/reset-2fa'), '/dashboard')
            const target = await makeUser()
            await db.user.update({ where: { id: target.id }, data: { two_factor_secret: 'enrolled-secret', two_factor_confirmed_at: new Date() } })
            await expectRedirect(actingAs(actor).post(`/user/${target.id}/reset-2fa`), `/user/edit/${target.id}`)
            expect(await db.user.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({ two_factor_secret: null, two_factor_confirmed_at: null })
            const regular = await makeUser()
            await expectRedirect(actingAs(regular).post(`/user/${regular.id}/reset-2fa`), '/dashboard')
        })

        it('only lets a manager delete users they manage', async () => {
            const regular = await makeUser()
            const victim = await makeUser()
            await expectRedirect(actingAs(regular).post(`/user/delete/${victim.id}`), '/dashboard')
            const actor = await makeUser({ solder_users: true })
            await expectRedirect(actingAs(actor).post('/user/delete/1'), '/dashboard')
            const privileged = await makeUser({ solder_users: true, mods_delete: true })
            await expectRedirect(actingAs(actor).post(`/user/delete/${privileged.id}`), '/dashboard')
            expect(await db.user.count({ where: { id: { in: [1, victim.id, privileged.id] } } })).toBe(3)
            await expectRedirect(actingAs(actor).post(`/user/delete/${victim.id}`), '/user/list')
            expect(await db.user.count({ where: { id: victim.id } })).toBe(0)
        })
    })
})
