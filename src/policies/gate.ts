import { canAccessModpack, GRANTABLE_FIELDS, modpackIds, permissionFlags, type PermissionFlag } from '../models/permissions.js'
import type { Modpack, ModpackImport, UserPermission, UserWithPermission } from '../models/types.js'

/**
 * Authorization, ported from Laravel's policies. A user with full Solder access may do anything
 * (Laravel's Gate::before); everyone else is checked by the policy for the ability.
 */
export class AuthorizationError extends Error {
    constructor(message = 'This action is unauthorized.') {
        super(message)
    }
}

type Check = (user: UserWithPermission) => boolean

function perm(user: UserWithPermission): Partial<UserPermission> {
    return user.permission ?? {}
}

export function allows(user: UserWithPermission | null | undefined, check: Check): boolean {
    if (!user) {
        return false
    }
    if (user.permission?.solder_full) {
        return true
    }
    return check(user)
}

/** Throw unless the policy allows it ($this->authorize()) */
export function authorize(user: UserWithPermission | null | undefined, check: Check): void {
    if (!allows(user, check)) {
        throw new AuthorizationError()
    }
}

function managesModpack(user: UserWithPermission, modpack: Pick<Modpack, 'id'>): boolean {
    return Boolean(perm(user).modpacks_manage) && canAccessModpack(user.permission, modpack.id)
}

/**
 * Whether a non-superadmin manager may act on $target. They must hold solder_users, and $target's permissions
 * must be a subset of their own — so a delegate can never edit, delete, or reset 2FA for a more-privileged
 * account (and never for a solder_full superadmin). An equal peer is a subset of itself, so peer management
 * is allowed.
 */
function canManageUser(actor: UserWithPermission, target: UserWithPermission): boolean {
    const actorPerm = actor.permission
    const targetPerm = target.permission
    if (!actorPerm || !targetPerm || !actorPerm.solder_users) {
        return false
    }
    if (targetPerm.solder_full) {
        return false
    }
    for (const flag of permissionFlags()) {
        if (targetPerm[flag] && !actorPerm[flag]) {
            return false
        }
    }
    return modpackIds(targetPerm).every((modpackId) => canAccessModpack(actorPerm, modpackId))
}

export const Policies = {
    modpack: {
        viewAny: (): Check => (user) => Boolean(perm(user).modpacks_manage),
        create: (): Check => (user) => Boolean(perm(user).modpacks_create),
        /** Importing creates a modpack, or adds a build to a modpack the user manages */
        import: (): Check => (user) => Boolean(perm(user).modpacks_create || perm(user).modpacks_manage),
        update: (modpack: Pick<Modpack, 'id'>): Check => (user) => managesModpack(user, modpack),
        delete: (modpack: Pick<Modpack, 'id'>): Check => (user) => Boolean(perm(user).modpacks_delete) && canAccessModpack(user.permission, modpack.id),
    },
    build: {
        create: (modpack: Pick<Modpack, 'id'>): Check => (user) => managesModpack(user, modpack),
        update: (modpack: Pick<Modpack, 'id'>): Check => (user) => managesModpack(user, modpack),
        delete: (modpack: Pick<Modpack, 'id'>): Check => (user) => managesModpack(user, modpack),
    },
    mod: {
        viewAny: (): Check => (user) => Boolean(perm(user).mods_manage),
        create: (): Check => (user) => Boolean(perm(user).mods_create),
        import: (): Check => (user) => Boolean(perm(user).mods_create),
        update: (): Check => (user) => Boolean(perm(user).mods_manage),
        delete: (): Check => (user) => Boolean(perm(user).mods_delete),
    },
    modversion: {
        create: (): Check => (user) => Boolean(perm(user).mods_manage),
        update: (): Check => (user) => Boolean(perm(user).mods_manage),
        delete: (): Check => (user) => Boolean(perm(user).mods_manage),
    },
    client: {
        viewAny: (): Check => (user) => Boolean(perm(user).solder_clients),
        create: (): Check => (user) => Boolean(perm(user).solder_clients),
        update: (): Check => (user) => Boolean(perm(user).solder_clients),
        delete: (): Check => (user) => Boolean(perm(user).solder_clients),
    },
    key: {
        viewAny: (): Check => (user) => Boolean(perm(user).solder_keys),
        create: (): Check => (user) => Boolean(perm(user).solder_keys),
        update: (): Check => (user) => Boolean(perm(user).solder_keys),
        delete: (): Check => (user) => Boolean(perm(user).solder_keys),
    },
    user: {
        viewAny: (): Check => (user) => Boolean(perm(user).solder_users),
        create: (): Check => (user) => Boolean(perm(user).solder_users),
        /**
         * A user may always edit their own profile; the controller clamps which permissions a non-superadmin can
         * actually change. Otherwise the actor must be able to manage the target.
         */
        update: (target: UserWithPermission): Check => (user) => user.id === target.id || canManageUser(user, target),
        delete: (target: UserWithPermission): Check => (user) => canManageUser(user, target),
    },
    modpackImport: {
        /** Whoever started the import, or anyone who manages the modpack it went into */
        view: (modpackImport: ModpackImport, modpack: Modpack | null): Check => (user) =>
            modpackImport.user_id === user.id || (modpack !== null && allows(user, Policies.modpack.update(modpack))),
        /** Deciding what to do with a waiting import changes the modpack's builds */
        update: (modpack: Modpack | null): Check => (user) => modpack !== null && allows(user, Policies.modpack.update(modpack)),
    },
    /**
     * A non-superadmin may only delegate permissions they hold themselves. The permission is whitelisted so an
     * unexpected column name can never authorize a grant.
     */
    grantPermission: (permission: string): Check => (user) => {
        if (!(permission in GRANTABLE_FIELDS)) {
            return false
        }
        return Boolean(perm(user)[permission as PermissionFlag])
    },
}
