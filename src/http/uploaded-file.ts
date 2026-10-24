import { copyFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { extension } from '../support/str.js'

/**
 * A file uploaded with a request, stored in a temporary file by multer.
 */
export class UploadedFile {
    constructor(
        /** The temporary file holding the upload */
        public readonly path: string,
        /** The name the file had on the uploader's computer */
        public readonly originalName: string,
        public readonly size: number,
        public readonly mimeType: string = 'application/octet-stream',
    ) {}

    getClientOriginalName(): string {
        return this.originalName
    }

    getClientOriginalExtension(): string {
        return extension(this.originalName)
    }

    /** Move the upload into a directory (like storeAs), returning the full path */
    storeAs(directory: string, name: string): string {
        const target = join(directory, name)
        mkdirSync(dirname(target), { recursive: true })
        try {
            renameSync(this.path, target)
        } catch {
            copyFileSync(this.path, target)
        }
        return target
    }
}
