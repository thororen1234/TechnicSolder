import { satisfies } from '../../src/mods/version-range.js'

const ranges: [string, string, string, boolean][] = [
    ['empty', '', '1.20.1', true],
    ['wildcard', '*', '1.20.1', true],
    ['exact match', '1.20.1', '1.20.1', true],
    ['exact mismatch', '1.20.1', '1.20.2', false],
    ['trailing zero', '1.21', '1.21.0', true],
    ['x range', '1.20.x', '1.20.4', true],
    ['x range other minor', '1.20.x', '1.21', false],
    ['tilde', '~1.20.1', '1.20.4', true],
    ['tilde below', '~1.20.1', '1.20', false],
    ['tilde next minor', '~1.20.1', '1.21', false],
    ['caret', '^1.20', '1.21.1', true],
    ['and', '>=1.20 <1.21', '1.20.6', true],
    ['and above', '>=1.20 <1.21', '1.21', false],
    ['or', '1.19.2 || 1.20.1', '1.20.1', true],
    ['or neither', '1.19.2 || 1.20.1', '1.20.2', false],
    ['maven half open', '[1.20.1,1.21)', '1.20.6', true],
    ['maven upper excluded', '[1.20.1,1.21)', '1.21', false],
    ['maven lower excluded', '(1.20.1,)', '1.20.1', false],
    ['maven unbounded', '[1.20,)', '1.21.4', true],
    ['maven exact', '[1.20.1]', '1.20.1', true],
    ['maven exact mismatch', '[1.20.1]', '1.20.2', false],
    ['maven union', '[1.19,1.19.2],[1.20.1,)', '1.20.4', true],
    ['year based at least', '>=26.1', '26.3', true],
    ['year based newer than classic', '>=1.21', '26.1', true],
    ['year based maven', '[26.1,26.2)', '1.21.4', false],
    ['unparseable counts as satisfied', 'banana', '1.20.1', true],
    ['snapshot build is not checked', '1.20.1', '23w31a', true],
]

describe('VersionRange', () => {
    it.each(ranges)('%s', (_name, range, version, expected) => {
        expect(satisfies(range, version)).toBe(expected)
    })
})
