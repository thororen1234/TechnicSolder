import { Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common'
import type { Request, Response } from 'express'
import { hashPassword } from '../auth/passwords.js'
import { createToken, deleteTokensFor, tokensFor, TOKENABLE_TYPE } from '../auth/tokens.js'
import { decryptSecret, qrCodeSvg, recoveryCodes } from '../auth/two-factor.js'
import { db, type TransactionClient } from '../database/prisma.js'
import { AuthGuard } from '../http/guards.js'
import { Web } from '../http/web.js'
import { GRANTABLE_FIELDS, modpackIds, serializeModpackIds, type PermissionFlag } from '../models/permissions.js'
import { findUserWithPermission, usersByIds } from '../models/relations.js'
import type { UserPermission, UserWithPermission } from '../models/types.js'
import { allows, authorize, Policies } from '../policies/gate.js'
import { Rule, validate } from '../support/validation.js'

function userId(req: Request): number | null {
    const value = Number(req.params.user_id)
    return Number.isInteger(value) && value > 0 ? value : null
}

/** A user's permission row as the views expect it, with the modpack scope as IDs */
function viewUser(user: UserWithPermission) {
    return { ...user, permission: user.permission ? { ...user.permission, modpackIds: modpackIds(user.permission) } : null }
}

/**
 * Permissions from the request, clamped to what the acting user is allowed to grant. A non-superadmin may only
 * grant (or revoke) permissions they hold themselves; permissions they lack are left at the target's existing
 * value. Only a solder_full user may grant anything.
 */
async function grantablePermissions(web: Web, actor: UserWithPermission, current: Partial<UserPermission>): Promise<Partial<UserPermission>> {
    const changes: Partial<UserPermission> = {}
    for (const [column, field] of Object.entries(GRANTABLE_FIELDS) as [PermissionFlag, string][]) {
        changes[column] = allows(actor, Policies.grantPermission(column)) ? web.boolean(field) : Boolean(current[column] ?? false)
    }
    changes.modpacks = await grantableModpacks(web, actor)
    return changes
}

/**
 * The per-modpack scope to assign, clamped to what the actor may grant: the requested IDs intersected with the
 * actor's own scope (the full requested set for a solder_full actor), validated against existing modpacks.
 */
async function grantableModpacks(web: Web, actor: UserWithPermission): Promise<string | null> {
    let requested = web
        .array('modpack')
        .map((value) => Number.parseInt(String(value), 10))
        .filter((id) => Number.isInteger(id) && id !== 0)
    if (!actor.permission?.solder_full) {
        const actorPacks = modpackIds(actor.permission)
        requested = requested.filter((id) => actorPacks.includes(id))
    }
    const existing = await db.modpack.findMany({ where: { id: { in: requested } }, select: { id: true }, orderBy: { id: 'asc' } })
    return serializeModpackIds(existing.map((modpack) => modpack.id))
}

/** The modpacks the acting user may assign: all of them for a solder_full user, otherwise their own scope */
async function grantableModpackList(actor: UserWithPermission) {
    return actor.permission?.solder_full
        ? db.modpack.findMany({ orderBy: { id: 'asc' } })
        : db.modpack.findMany({ where: { id: { in: modpackIds(actor.permission) } }, orderBy: { id: 'asc' } })
}

@Controller('user')
@UseGuards(AuthGuard)
export class UserController {
    @Get()
    index(@Req() req: Request, @Res() res: Response): void {
        Web.of(req, res).redirect('user/list').send()
    }

    @Get('list')
    async list(@Req() req: Request, @Res() res: Response): Promise<void> {
        authorize(req.user, Policies.user.viewAny())
        const users = await db.user.findMany({ orderBy: { id: 'asc' } })
        const updatedBy = await usersByIds(users.map((user) => user.updated_by_user_id))
        await Web.of(req, res).view('user.list', {
            users: users.map((user) => ({ ...user, updated_by_user: user.updated_by_user_id === null ? null : (updatedBy.get(user.updated_by_user_id) ?? null) })),
        })
    }

    @Get('edit/:user_id')
    async edit(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const id = userId(req)
        // Gate non-managers out before the lookup so the response can't be used to tell which user IDs exist.
        // Editing yourself needs no permission.
        if (id !== web.userId) {
            authorize(req.user, Policies.user.viewAny())
        }
        const user = id === null ? null : await findUserWithPermission(id)
        if (!user) {
            web.redirect('user/list').withErrors(['User not found']).send()
            return
        }
        authorize(req.user, Policies.user.update(user))
        const showTwoFactor = web.userId === user.id
        const status = req.flash.status
        const actorPermission = web.user.permission
        await web.view('user.edit', {
            user: viewUser(user),
            allModpacks: await grantableModpackList(web.user),
            userUpdatedBy: user.updated_by_user_id === null ? null : await db.user.findUnique({ where: { id: user.updated_by_user_id } }),
            showTwoFactor,
            qrCodeSvg: showTwoFactor && user.two_factor_secret && !user.two_factor_confirmed_at ? await qrCodeSvg(user) : null,
            twoFactorSecret: showTwoFactor && user.two_factor_secret && !user.two_factor_confirmed_at ? decryptSecret(user) : null,
            recoveryCodes:
                showTwoFactor && user.two_factor_confirmed_at && ['two-factor-authentication-confirmed', 'recovery-codes-generated'].includes(String(status))
                    ? recoveryCodes(user)
                    : null,
            adminViewingOther2FA: web.userId !== user.id && Boolean(actorPermission?.solder_full || actorPermission?.solder_users) && user.two_factor_confirmed_at !== null,
            tokens: showTwoFactor ? await tokensFor(user.id) : [],
        })
    }

    @Post('edit/:user_id')
    async update(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const id = userId(req)
        if (id !== web.userId) {
            authorize(req.user, Policies.user.viewAny())
        }
        const user = id === null ? null : await findUserWithPermission(id)
        if (!user) {
            web.redirect('user/list').withErrors(['User not found']).send()
            return
        }
        authorize(req.user, Policies.user.update(user))
        const rules: Record<string, unknown> = {
            email: ['required', 'email', Rule.unique('users', 'email').ignore(user.id)],
            username: ['required', 'min:3', 'max:30', Rule.unique('users', 'username').ignore(user.id)],
        }
        const settingPassword = Boolean(web.input('password1'))
        if (settingPassword) {
            // Proof of identity for a session takeover, not proof of the target's password: the *actor* confirms
            // their own password, so a manager resetting someone else's password enters theirs.
            ;(rules as Record<string, unknown>).current_password = ['bail', 'required', 'string', Rule.currentPassword(web.user.password)]
            ;(rules as Record<string, unknown>).password1 = [Rule.password(), 'same:password2']
        }
        const result = await validate(web.all(), rules as never)
        if (!result.passes) {
            web.redirect(`user/edit/${user.id}`).withErrors(result.errors).send()
            return
        }
        const actor = web.user
        const outcome = await db.$transaction(async (tx: TransactionClient) => {
            // Update the user's permissions
            if (web.boolean('permissions-present') && (actor.permission?.solder_full || actor.permission?.solder_users) && user.permission) {
                const removesFullAccess = user.permission.solder_full && allows(actor, Policies.grantPermission('solder_full')) && !web.boolean('solder-full')
                if (removesFullAccess) {
                    const superadmins = await tx.userPermission.findMany({ where: { solder_full: true }, orderBy: { id: 'asc' }, select: { id: true, user_id: true } })
                    if (!superadmins.some((permission) => permission.user_id !== user.id)) {
                        return 'last-superadmin' as const
                    }
                }
                await tx.userPermission.update({ where: { id: user.permission.id }, data: await grantablePermissions(web, actor, user.permission) })
            }
            await tx.user.update({
                where: { id: user.id },
                data: {
                    email: web.string('email'),
                    username: web.string('username'),
                    ...(settingPassword ? { password: await hashPassword(web.string('password1')) } : {}),
                    // Security logging
                    updated_by_user_id: actor.id,
                    updated_by_ip: web.ip(),
                },
            })
            return 'saved' as const
        })
        if (outcome === 'last-superadmin') {
            web.redirect(`user/edit/${user.id}`).withErrors({ 'solder-full': 'At least one user must retain full Solder access.' }).send()
            return
        }
        web.redirect(actor.id === user.id ? `user/edit/${user.id}` : 'user/list').with('success', 'User edited successfully!').send()
    }

    @Get('create')
    async create(@Req() req: Request, @Res() res: Response): Promise<void> {
        authorize(req.user, Policies.user.create())
        const web = Web.of(req, res)
        await web.view('user.create', { allModpacks: await grantableModpackList(web.user) })
    }

    @Post('create')
    async store(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        authorize(req.user, Policies.user.create())
        const result = await validate(web.all(), {
            email: 'required|email|unique:users',
            username: 'required|min:3|max:30|unique:users',
            password: ['required', Rule.password()],
        })
        if (!result.passes) {
            web.redirect('user/create').withErrors(result.errors).send()
            return
        }
        const creator = web.user
        // The user and its permission row are written together: a failure between the two would otherwise leave a
        // user with no permissions at all, which no manager can then act on.
        const user = await db.$transaction(async (tx: TransactionClient) => {
            const created = await tx.user.create({
                data: {
                    email: web.string('email'),
                    username: web.string('username'),
                    password: await hashPassword(web.string('password')),
                    created_ip: web.ip(),
                    created_by_user_id: creator.id,
                    updated_by_ip: web.ip(),
                    updated_by_user_id: creator.id,
                },
            })
            const permissions = web.boolean('permissions-present') ? await grantablePermissions(web, creator, {}) : {}
            await tx.userPermission.create({ data: { ...permissions, user_id: created.id } })
            return created
        })
        web.redirect(`user/edit/${user.id}`).with('success', 'User created!').send()
    }

    @Post(':user_id/reset-2fa')
    async resetTwoFactor(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        // Admin-only recovery action: gate non-managers out before the lookup (avoids leaking which user IDs
        // exist), then confirm this manager may act on the target. Deliberately not the self-passing update ability.
        authorize(req.user, Policies.user.viewAny())
        const id = userId(req)
        const user = id === null ? null : await findUserWithPermission(id)
        if (!user) {
            web.redirect('user/list').withErrors(['User not found']).send()
            return
        }
        authorize(req.user, Policies.user.delete(user))
        await db.user.update({ where: { id: user.id }, data: { two_factor_secret: null, two_factor_recovery_codes: null, two_factor_confirmed_at: null } })
        web.redirect(`user/edit/${user.id}`).with('success', 'Two-factor authentication has been reset.').send()
    }

    @Get('delete/:user_id')
    async delete(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const user = await this.deletableUser(web)
        if (user) {
            await web.view('user.delete', { user })
        }
    }

    @Post('delete/:user_id')
    async destroy(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const user = await this.deletableUser(web)
        if (!user) {
            return
        }
        await db.userPermission.deleteMany({ where: { user_id: user.id } })
        await deleteTokensFor(user.id)
        await db.user.delete({ where: { id: user.id } })
        web.redirect('user/list').with('success', 'User deleted!').send()
    }

    @Post('token/create')
    async createToken(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const result = await validate(web.all(), { token_name: 'required|string|max:255' })
        if (!result.passes) {
            web.redirect(`user/edit/${web.userId}`).withErrors(result.errors).send()
            return
        }
        const token = await createToken(web.user, web.string('token_name'))
        web.redirect(`user/edit/${web.userId}`).with('newToken', token.plainTextToken).send()
    }

    @Post('token/delete/:tokenId')
    async deleteToken(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const id = Number(req.params.tokenId)
        const token = Number.isInteger(id)
            ? await db.personalAccessToken.findFirst({ where: { id, tokenable_type: TOKENABLE_TYPE, tokenable_id: web.userId } })
            : null
        if (!token) {
            web.redirect(`user/edit/${web.userId}`).withErrors(['Token not found']).send()
            return
        }
        await db.personalAccessToken.delete({ where: { id: token.id } })
        web.redirect(`user/edit/${web.userId}`).with('success', 'API token revoked.').send()
    }

    /** The user to delete, or null after redirecting with the reason they can't be */
    private async deletableUser(web: Web): Promise<UserWithPermission | null> {
        authorize(web.req.user, Policies.user.viewAny())
        const id = userId(web.req)
        if (id === null) {
            web.redirect('user/list').withErrors(['User ID not provided']).send()
            return null
        }
        const user = await findUserWithPermission(id)
        if (!user) {
            web.redirect('user/list').withErrors(['User not found']).send()
            return null
        }
        authorize(web.req.user, Policies.user.delete(user))
        if (id === web.userId) {
            web.redirect('user/list').withErrors(['You cannot delete your own account.']).send()
            return null
        }
        if (user.permission?.solder_full) {
            const others = await db.userPermission.count({ where: { solder_full: true, user_id: { not: id } } })
            if (others <= 0) {
                web.redirect('user/list').withErrors(['Cannot delete the only remaining super user.']).send()
                return null
            }
        }
        return user
    }
}

