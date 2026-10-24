import { db, type Db } from '../database/prisma.js'
import type { UserPermission } from './types.js'

/**
 * The grantable boolean permission columns, mapped to the form field that sets them. Single source of truth for
 * the grant clamp (canGrantPermission), the create/edit forms, and the user-management subset check — adding a
 * permission means adding one entry here.
 *
 * Excludes the per-modpack `modpacks` scope, which is not a boolean flag.
 */
export const GRANTABLE_FIELDS = {
    solder_full: 'solder-full',
    solder_users: 'manage-users',
    solder_keys: 'manage-keys',
    solder_clients: 'manage-clients',
    mods_create: 'mod-create',
    mods_manage: 'mod-manage',
    mods_delete: 'mod-delete',
    modpacks_create: 'modpack-create',
    modpacks_manage: 'modpack-manage',
    modpacks_delete: 'modpack-delete',
} as const

export type PermissionFlag = keyof typeof GRANTABLE_FIELDS

/**
 * The permission columns compared when deciding whether one user's permissions are a subset of another's.
 * Excludes solder_full, which is handled separately by the superadmin bypass.
 */
export function permissionFlags(): Exclude<PermissionFlag, 'solder_full'>[] {
    return (Object.keys(GRANTABLE_FIELDS) as PermissionFlag[]).filter((flag) => flag !== 'solder_full') as Exclude<PermissionFlag, 'solder_full'>[]
}

/** The modpack IDs in the comma-separated `modpacks` column */
export function modpackIds(permission: Pick<UserPermission, 'modpacks'> | null | undefined): number[] {
    const value = permission?.modpacks
    if (value === null || value === undefined || value === '') {
        return []
    }
    return value
        .split(/,+/)
        .filter((id) => id !== '')
        .map(Number)
}

/** The `modpacks` column value for a list of IDs; null when empty, as Eloquent's mutator wrote it */
export function serializeModpackIds(ids: number[] | null): string | null {
    return ids && ids.length > 0 ? ids.join(',') : null
}

export function canAccessModpack(permission: UserPermission | null | undefined, modpackId: number): boolean {
    if (!permission) {
        return false
    }
    return permission.solder_full || modpackIds(permission).includes(Number(modpackId))
}

export async function grantModpackAccess(permission: UserPermission, modpackId: number, client: Db = db): Promise<void> {
    const ids = [...modpackIds(permission), modpackId]
    permission.modpacks = serializeModpackIds(ids)
    await client.userPermission.update({ where: { id: permission.id }, data: { modpacks: permission.modpacks } })
}
