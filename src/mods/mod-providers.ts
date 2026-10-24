import type { ProviderClass } from './mod-provider.js'
import { CurseForge } from './providers/curseforge.js'
import { Fabric, Quilt } from './providers/fabric.js'
import { Forge } from './providers/forge.js'
import { Modrinth } from './providers/modrinth.js'
import { NeoForge } from './providers/neoforge.js'

/** Every mod provider, by the key stored on imported mod versions, in the order the import page lists them */
export function providers(): Record<string, ProviderClass> {
    return {
        modrinth: Modrinth,
        curseforge: CurseForge,
        fabric: Fabric,
        quilt: Quilt,
        forge: Forge,
        neoforge: NeoForge,
    }
}

export function provider(key: string | null | undefined): ProviderClass | null {
    return key ? (Object.hasOwn(providers(), key) ? providers()[key] : null) : null
}
