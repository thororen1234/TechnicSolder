import { config } from '../config.js'
import { repositoryPath } from '../models/modversion.js'
import type { Mod, Modversion } from '../models/types.js'
import { downloadFile } from '../mods/mod-provider.js'
import { fileSize, hashFile, isFile, isUrl, removeFile, tempFile } from '../support/files.js'
import { remoteMd5 } from './url-utils.js'

type ModversionWithMod = Pick<Modversion, 'version'> & { mod: Pick<Mod, 'name'> }

/**
 * Access to mod version zips in the mod repository (SOLDER_REPO_LOCATION), which is either a local path or a
 * remote URL. Remote files are downloaded to temporary files on demand.
 */
export class ModRepository {
    private tempFiles: string[] = []

    static isRemote(): boolean {
        return isUrl(config.solder.repo_location)
    }

    /** Full path or URL of a mod version's zip */
    static location(modversion: ModversionWithMod): string {
        return config.solder.repo_location + repositoryPath(modversion.mod, modversion.version)
    }

    /** Path to a readable copy of the zip, downloading it when the repository is remote */
    async localCopy(modversion: ModversionWithMod): Promise<{ path: string } | { error: string }> {
        const location = ModRepository.location(modversion)
        if (!ModRepository.isRemote()) {
            return isFile(location)
                ? { path: location }
                : { error: `${repositoryPath(modversion.mod, modversion.version)} is missing from the mod repository` }
        }
        const tmp = tempFile('solder_repo_')
        this.tempFiles.push(tmp)
        const error = await downloadFile(location, tmp)
        return error === null ? { path: tmp } : { error }
    }

    /** Current checksum and size of the file in the repository */
    static async checksum(
        modversion: ModversionWithMod,
    ): Promise<{ success: true; md5: string; filesize: number } | { success: false; message: string }> {
        const location = ModRepository.location(modversion)
        if (ModRepository.isRemote()) {
            const result = await remoteMd5(location)
            return result.success
                ? { success: true, md5: result.md5, filesize: result.filesize }
                : { success: false, message: result.message || 'Could not fetch the file' }
        }
        if (!isFile(location)) {
            return { success: false, message: 'File not found' }
        }
        return { success: true, md5: await hashFile(location), filesize: fileSize(location) }
    }

    /** Delete any temporary downloads */
    cleanup(): void {
        for (const file of this.tempFiles) {
            removeFile(file)
        }
        this.tempFiles = []
    }
}
