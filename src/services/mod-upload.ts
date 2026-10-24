import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { db } from '../database/prisma.js'
import type { UploadedFile } from '../http/uploaded-file.js'
import type { Mod } from '../models/types.js'
import { describe, detectVersion, environment as jarEnvironment } from '../mods/jar-metadata.js'
import { Cache } from '../support/cache.js'
import { fileSize, hashFile } from '../support/files.js'
import { basename, filenameWithoutExtension, headline, limit, slug } from '../support/str.js'
import { ZipReader, ZipWriter } from '../support/zip.js'
import { ModRepository } from './mod-repository.js'

/** Length of the mods table's string columns */
const MAX_COLUMN = 255

export interface UploadResult {
    created: { mod_id: number; mod: string; version: string }[]
    errors: string[]
}

/**
 * Adds uploaded mod files to the mod repository.
 * A .jar is wrapped into a Solder zip under mods/, and its mod ID, name, author and version are read from the
 * jar's metadata. A .zip is assumed to already be in Solder's layout (mods/, config/, bin/...) and stored as-is.
 */
export class ModUploadService {
    /**
     * @param mod Add the files as versions of this mod; when null each jar creates or extends the mod it declares
     * @param version Version name to use instead of the detected one (single file uploads)
     */
    async upload(files: UploadedFile[], mod: Mod | null = null, version: string | null = null): Promise<UploadResult> {
        const result: UploadResult = { created: [], errors: [] }
        if (ModRepository.isRemote()) {
            result.errors.push('The mod repository is a remote URL, so uploaded files cannot be saved. Set SOLDER_REPO_LOCATION to a local path.')
            return result
        }
        for (const file of files) {
            const outcome = await this.store(file, mod, files.length === 1 ? version : null)
            if ('error' in outcome) {
                result.errors.push(`${file.getClientOriginalName()}: ${outcome.error}`)
            } else {
                result.created.push(outcome)
            }
        }
        if (result.created.length > 0) {
            await Cache.forget('mods')
        }
        return result
    }

    private async store(file: UploadedFile, mod: Mod | null, version: string | null): Promise<UploadResult['created'][number] | { error: string }> {
        const filename = basename(file.getClientOriginalName())
        const extension = file.getClientOriginalExtension().toLowerCase()
        if (extension !== 'jar' && extension !== 'zip') {
            return { error: 'only .jar and .zip files can be uploaded' }
        }
        const zip = ZipReader.open(file.path)
        if (zip === null) {
            return { error: 'not a valid jar or zip file' }
        }
        const metadata = describe(zip)
        const detected = detectVersion(zip)
        const environment = jarEnvironment(zip)
        const declared = metadata.mods[0] ?? null

        if (mod === null) {
            if (extension === 'zip') {
                return { error: 'zips can only be added to an existing mod; upload the .jar instead' }
            }
            const modSlug = slug(declared?.id ?? '') || slug(filenameWithoutExtension(filename))
            mod =
                (await db.mod.findUnique({ where: { name: modSlug } })) ??
                (await db.mod.create({
                    data: {
                        name: modSlug,
                        // The columns hold 255 characters, and MySQL rejects longer values
                        pretty_name: limit((declared?.name ?? '') || headline(modSlug), MAX_COLUMN - 3),
                        author: declared?.authors ? limit(declared.authors, MAX_COLUMN - 3) : null,
                        description: declared?.description ?? null,
                        link: declared?.url && declared.url.length <= MAX_COLUMN ? declared.url : null,
                    },
                }))
        }

        let versionName = version || detected || filenameWithoutExtension(filename)
        versionName = versionName.replace(/[^A-Za-z0-9._+-]+/g, '-').replace(/^-+|-+$/g, '')
        if (versionName === '') {
            return { error: 'could not work out a version name; enter one' }
        }
        if ((await db.modversion.count({ where: { mod_id: mod.id, version: versionName } })) > 0) {
            return { error: `${mod.name} ${versionName} already exists` }
        }

        const finalPath = ModRepository.location({ version: versionName, mod })
        try {
            mkdirSync(dirname(finalPath), { recursive: true, mode: 0o775 })
        } catch {
            return { error: 'could not create the folder in the mod repository' }
        }
        if (extension === 'zip') {
            copyFileSync(file.path, finalPath)
        } else {
            const out = new ZipWriter()
            out.addFile(file.path, `mods/${filename}`)
            await out.save(finalPath)
        }
        await db.modversion.create({
            data: {
                mod_id: mod.id,
                version: versionName,
                environment,
                md5: await hashFile(finalPath),
                filesize: fileSize(finalPath),
            },
        })
        return { mod_id: mod.id, mod: mod.pretty_name || mod.name, version: versionName }
    }
}
