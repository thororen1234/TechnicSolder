/**
 * PHP's version_compare(), ported exactly: mod loaders and update checks depend on its ordering
 * ("1.0" < "1.0.0", "1.0-beta" < "1.0", "dev" < "alpha" < "beta" < "RC" < "#" < "pl").
 */

/** php_canonicalize_version() from ext/standard/versioning.c */
function canonicalize(version: string): string {
    if (version === '') {
        return ''
    }
    const isDigit = (c: string) => c >= '0' && c <= '9'
    const isNonDigit = (c: string) => !isDigit(c) && c !== '.'
    const isAlnum = (c: string) => /^[A-Za-z0-9]$/.test(c)
    let result = version[0]
    let previous = version[0]
    for (const char of version.slice(1)) {
        const last = result[result.length - 1]
        if (char === '-' || char === '_' || char === '+') {
            if (last !== '.') {
                result += '.'
            }
        } else if ((isNonDigit(previous) && isDigit(char)) || (isDigit(previous) && isNonDigit(char))) {
            if (last !== '.') {
                result += '.'
            }
            result += char
        } else if (!isAlnum(char)) {
            if (last !== '.') {
                result += '.'
            }
        } else {
            result += char
        }
        previous = char
    }
    return result
}

const SPECIAL_FORMS: [string, number][] = [
    ['dev', 0],
    ['alpha', 1],
    ['a', 1],
    ['beta', 2],
    ['b', 2],
    ['RC', 3],
    ['rc', 3],
    ['#', 4],
    ['pl', 5],
    ['p', 5],
]

function specialFormOrder(form: string): number {
    for (const [name, order] of SPECIAL_FORMS) {
        if (form.startsWith(name)) {
            return order
        }
    }
    return -1
}

function compareSpecialForms(a: string, b: string): number {
    return Math.sign(specialFormOrder(a) - specialFormOrder(b))
}

const isNumber = (part: string) => /^\d/.test(part)

function compare(a: string, b: string): number {
    if (a === '') {
        return b === '' ? 0 : compare('#N#', b)
    }
    if (b === '') {
        return compare(a, '#N#')
    }
    const partsA = canonicalize(a).split('.')
    const partsB = canonicalize(b).split('.')
    let result = 0
    let i = 0
    for (; i < partsA.length && i < partsB.length && result === 0; i++) {
        const p1 = partsA[i]
        const p2 = partsB[i]
        if (isNumber(p1) && isNumber(p2)) {
            result = Math.sign(Number.parseInt(p1, 10) - Number.parseInt(p2, 10))
        } else if (!isNumber(p1) && !isNumber(p2)) {
            result = compareSpecialForms(p1, p2)
        } else if (isNumber(p1)) {
            result = compareSpecialForms('#N#', p2)
        } else {
            result = compareSpecialForms(p1, '#N#')
        }
    }
    if (result === 0) {
        if (i < partsA.length) {
            result = isNumber(partsA[i]) ? 1 : compare(partsA.slice(i).join('.'), '#N#')
        } else if (i < partsB.length) {
            result = isNumber(partsB[i]) ? -1 : compare('#N#', partsB.slice(i).join('.'))
        }
    }
    return result
}

export type VersionOperator = '<' | 'lt' | '<=' | 'le' | '>' | 'gt' | '>=' | 'ge' | '==' | 'eq' | '=' | '!=' | '<>' | 'ne'

export function versionCompare(a: string, b: string): number
export function versionCompare(a: string, b: string, operator: VersionOperator | string): boolean
export function versionCompare(a: string, b: string, operator?: string): number | boolean {
    const result = compare(String(a), String(b))
    switch (operator) {
        case undefined:
            return result
        case '<':
        case 'lt':
            return result < 0
        case '<=':
        case 'le':
            return result <= 0
        case '>':
        case 'gt':
            return result > 0
        case '>=':
        case 'ge':
            return result >= 0
        case '==':
        case '=':
        case 'eq':
            return result === 0
        case '!=':
        case '<>':
        case 'ne':
            return result !== 0
        default:
            throw new Error(`Unknown version_compare operator "${operator}"`)
    }
}
