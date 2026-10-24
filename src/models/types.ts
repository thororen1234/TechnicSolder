export type {
    ActivityLog,
    Build,
    BuildDownload,
    BuildModversion,
    Client,
    ClientModpack,
    Key,
    Mod,
    Modpack,
    ModpackImport,
    Modversion,
    PasswordResetToken,
    PersonalAccessToken,
    User,
    UserPermission,
} from '../generated/prisma/postgresql/client.js'

import type { Mod, Modversion, User, UserPermission } from '../generated/prisma/postgresql/client.js'

/** A mod version with its mod loaded, the shape most code works with */
export type ModversionWithMod = Modversion & { mod: Mod }

/** A user with their permission row, like Eloquent's always-loaded `permission` relation */
export type UserWithPermission = User & { permission: UserPermission | null }
