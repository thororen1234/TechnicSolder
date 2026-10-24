import { readFileSync } from 'node:fs'
import AdmZip from 'adm-zip'

/**
 * Reading and writing zip archives (mod zips, jars, modpack archives), with the ZipArchive methods the PHP
 * version used.
 */
export class ZipReader {
    private readonly entries: AdmZip.IZipEntry[]
    private readonly byName: Map<string, AdmZip.IZipEntry>

    private constructor(private readonly zip: AdmZip) {
        this.entries = zip.getEntries()
        this.byName = new Map(this.entries.map((entry) => [entry.entryName, entry]))
    }

    /** Open an archive from a path or its contents; null when it isn't a readable zip */
    static open(source: string | Buffer): ZipReader | null {
        try {
            const contents = typeof source === 'string' ? readFileSync(source) : source
            // The end of central directory signature; adm-zip accepts some non-zips without it
            if (contents.length < 22 || contents.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) === -1) {
                return null
            }
            return new ZipReader(new AdmZip(contents))
        } catch {
            return null
        }
    }

    get numFiles(): number {
        return this.entries.length
    }

    getNameIndex(index: number): string {
        return this.entries[index]?.entryName ?? ''
    }

    getFromIndex(index: number): Buffer {
        const entry = this.entries[index]
        return entry ? entry.getData() : Buffer.alloc(0)
    }

    /** The entry's contents, or null when there is no such entry */
    getFromName(name: string): Buffer | null {
        const entry = this.byName.get(name)
        if (!entry || entry.isDirectory) {
            return null
        }
        try {
            return entry.getData()
        } catch {
            return null
        }
    }

    /** The entry's contents as text, or null */
    getText(name: string): string | null {
        return this.getFromName(name)?.toString('utf8') ?? null
    }

    locateName(name: string): boolean {
        return this.byName.has(name)
    }

    names(): string[] {
        return this.entries.map((entry) => entry.entryName)
    }
}

export class ZipWriter {
    // Keep entries in the order they were added, as ZipArchive does
    private readonly zip = new AdmZip(undefined, { noSort: true })
    private readonly added = new Set<string>()

    addFromString(name: string, contents: string | Buffer): void {
        // Like ZipArchive, a later entry with the same name replaces the earlier one
        if (this.added.has(name)) {
            this.zip.deleteFile(name)
        }
        this.added.add(name)
        this.zip.addFile(name, typeof contents === 'string' ? Buffer.from(contents) : contents)
    }

    addFile(path: string, name: string): void {
        this.addFromString(name, readFileSync(path))
    }

    get count(): number {
        return this.added.size
    }

    async save(path: string): Promise<void> {
        await this.zip.writeZipPromise(path, { overwrite: true })
    }

    toBuffer(): Buffer {
        return this.zip.toBuffer()
    }
}
