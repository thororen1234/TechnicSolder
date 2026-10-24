import { writeFileSync } from 'node:fs'
import { describe as describeJar, detectVersionFromFile, minecraftVersionFromRange } from '../../src/mods/jar-metadata.js'
import { removeFile, tempFile } from '../../src/support/files.js'
import { ZipReader } from '../../src/support/zip.js'
import { makeArchive } from '../support/helpers.js'

function detect(files: Record<string, string>): string | null {
    const path = tempFile('jar_metadata_test_')
    writeFileSync(path, makeArchive(files))
    try {
        return detectVersionFromFile(path)
    } finally {
        removeFile(path)
    }
}

const metadata = (files: Record<string, string>) => describeJar(ZipReader.open(makeArchive(files))!)

describe('JarMetadata', () => {
    describe('detecting versions', () => {
        it.each<[string, Record<string, string>, string]>([
            ['prefixes the Minecraft version of a Fabric mod', { 'fabric.mod.json': JSON.stringify({ version: '0.5.13', depends: { minecraft: '>=1.20 <1.21' } }) }, '1.20-0.5.13'],
            ['reads a Fabric Minecraft dependency list', { 'fabric.mod.json': JSON.stringify({ version: '2.0', depends: { minecraft: ['1.20.1', '1.20.2'] } }) }, '1.20.1-2.0'],
            ['does not repeat the Minecraft prefix', { 'fabric.mod.json': JSON.stringify({ version: '1.20.1-2.0', depends: { minecraft: '~1.20.1' } }) }, '1.20.1-2.0'],
            ['reads year-based Minecraft versions', { 'fabric.mod.json': JSON.stringify({ version: '3.1.0', depends: { minecraft: '>=26.1' } }) }, '26.1-3.1.0'],
            [
                'reads Quilt mods',
                { 'quilt.mod.json': JSON.stringify({ quilt_loader: { version: '1.4.0', depends: [{ id: 'quilt_loader' }, { id: 'minecraft', versions: '>=1.20.1' }] } }) },
                '1.20.1-1.4.0',
            ],
            ['reads a legacy mcmod.info list', { 'mcmod.info': JSON.stringify([{ modid: 'jei', version: '4.16.1', mcversion: '1.12.2' }]) }, '1.12.2-4.16.1'],
            ['reads a legacy mcmod.info modList', { 'mcmod.info': JSON.stringify({ modListVersion: 2, modList: [{ version: '1.0', mcversion: '1.7.10' }] }) }, '1.7.10-1.0'],
            ['ignores unexpanded placeholders', { 'mcmod.info': JSON.stringify([{ version: '${version}', mcversion: '${mcversion}' }]) }, ''],
            [
                'reads a Forge mods.toml',
                {
                    'META-INF/mods.toml': `modLoader="javafml"
[[mods]]
modId="examplemod"
version="15.2.0"
[[dependencies.examplemod]]
    modId="forge"
    versionRange="[47,)"
[[dependencies.examplemod]]
    modId="minecraft"
    versionRange="[1.20.1,1.21)"`,
                },
                '1.20.1-15.2.0',
            ],
            [
                'takes ${file.jarVersion} from the manifest',
                {
                    'META-INF/neoforge.mods.toml': `[[mods]]
modId="examplemod"
version="\${file.jarVersion}"
[[dependencies.examplemod]]
    modId="minecraft"
    versionRange="[26.1,)"`,
                    'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\nImplementation-Version: 4.2.0\n',
                },
                '26.1-4.2.0',
            ],
            ['returns an empty string without metadata', { 'assets/minecraft/textures/stone.png': 'png' }, ''],
        ])('%s', (_name, files, expected) => {
            expect(detect(files)).toBe(expected)
        })

        it('returns null for something that is not an archive', () => {
            const path = tempFile('jar_metadata_test_')
            writeFileSync(path, '<html>Not found</html>')
            try {
                expect(detectVersionFromFile(path)).toBeNull()
            } finally {
                removeFile(path)
            }
        })
    })

    describe('describing jars', () => {
        it('describes a Fabric mod with its dependencies and nested jars', () => {
            const info = metadata({
                'fabric.mod.json': JSON.stringify({
                    id: 'fabric-api',
                    name: 'Fabric API',
                    version: '0.92.0',
                    authors: ['FabricMC'],
                    depends: { fabricloader: '>=0.15', minecraft: '~1.20.1' },
                    provides: ['fabric'],
                    jars: [{ file: 'META-INF/jars/fabric-api-base.jar' }],
                }),
            })
            expect(info.loaders).toEqual(['fabric'])
            expect(info.nested).toEqual(['META-INF/jars/fabric-api-base.jar'])
            expect(info.mods[0]).toMatchObject({
                id: 'fabric-api',
                name: 'Fabric API',
                authors: 'FabricMC',
                depends: ['fabricloader', 'minecraft'],
                provides: ['fabric'],
                minecraft: '~1.20.1',
            })
        })

        it('keeps only the mandatory dependencies of a Forge mod', () => {
            const info = metadata({
                'META-INF/mods.toml': `[[mods]]
modId="create"
version="0.5.1"
displayName="Create"
authors="simibubi"
[[dependencies.create]]
    modId="forge"
    mandatory=true
    versionRange="[47,)"
[[dependencies.create]]
    modId="flywheel"
    type="required"
    versionRange="[0.6,)"
[[dependencies.create]]
    modId="jei"
    mandatory=false
[[dependencies.create]]
    modId="minecraft"
    mandatory=true
    versionRange="[1.20.1,1.20.2)"`,
                'META-INF/jarjar/metadata.json': JSON.stringify({ jars: [{ path: 'META-INF/jarjar/flywheel.jar' }] }),
            })
            expect(info.loaders).toEqual(['forge'])
            expect(info.nested).toEqual(['META-INF/jarjar/flywheel.jar'])
            expect(info.mods[0]).toMatchObject({ name: 'Create', depends: ['forge', 'flywheel', 'minecraft'], minecraft: '[1.20.1,1.20.2)' })
        })

        it('recognizes a NeoForge mod using the old mods.toml name', () => {
            // From starlight-1.1.3+neoforge.2e9f705.jar: NeoForge for 1.20.2-1.20.4 still read META-INF/mods.toml
            const info = metadata({
                'META-INF/mods.toml': `modLoader = "javafml"
loaderVersion = "[1,)"
[[mods]]
 modId = "starlight"
 version = "1.1.3+neoforge.2e9f705"
 displayName = "Starlight"
 [[dependencies.starlight]]
  modId = "neoforge"
  required = true
  versionRange = "[20.4,)"
[[dependencies.starlight]]
  modId = "minecraft"
  required = true
  versionRange = "[1.20.4,1.20.5)"`,
            })
            expect(info.loaders).toEqual(['neoforge'])
            expect(info.mods[0]).toMatchObject({ depends: ['neoforge', 'minecraft'], minecraft: '[1.20.4,1.20.5)' })
        })

        it('tolerates malformed metadata', () => {
            const info = metadata({ 'fabric.mod.json': JSON.stringify({ id: 'odd', name: ['not', 'a', 'string'], version: 3, contact: { homepage: ['x'] } }) })
            expect(info.mods[0]).toMatchObject({ id: 'odd', name: '', version: '3', url: '' })
        })

        it('reads the required mods of a legacy Forge mod', () => {
            const info = metadata({
                'mcmod.info': JSON.stringify([{ modid: 'thaumcraft', name: 'Thaumcraft', version: '6.1', mcversion: '1.12.2', requiredMods: ['baubles@[1.5.2,)'] }]),
            })
            expect(info.loaders).toEqual(['forge'])
            expect(info.mods[0].depends).toEqual(['baubles'])
        })
    })

    it.each<[string, unknown, string]>([
        ['tilde', '~1.20.1', '1.20.1'],
        ['range', '>=1.19.2 <1.20', '1.19.2'],
        ['wildcard', '1.20.x', '1.20'],
        ['year based', '>=26.1', '26.1'],
        ['list', ['1.18.2', '1.19'], '1.18.2'],
        ['any', '*', ''],
        ['not a string', null, ''],
    ])('pulls the Minecraft version out of a %s range', (_name, range, expected) => {
        expect(minecraftVersionFromRange(range)).toBe(expected)
    })
})
