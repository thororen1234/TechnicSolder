import { versionCompare } from '../support/version-compare.js'

/**
 * Evaluates the version ranges mods declare for Minecraft: Fabric/npm style ("~1.20.1", ">=1.20 <1.21",
 * "1.20.x", alternatives joined with "||") and Maven style ("[1.20.1,1.21)", "[1.20.1]").
 * Anything it can't parse counts as satisfied, so a mod is never flagged because of unusual syntax.
 */
export function satisfies(range: string, version: string): boolean {
    range = range.trim()
    if (range === '' || range === '*' || !/^\d+\.\d+/.test(version)) {
        return true
    }
    if (range.includes('||')) {
        return range.split('||').some((alternative) => satisfies(alternative, version))
    }
    if (/^[[(]/.test(range)) {
        return maven(range, version)
    }
    return range.split(/\s+/).every((comparator) => matchesComparator(comparator, version))
}

function matchesComparator(comparator: string, version: string): boolean {
    // 1.20.x / 1.20.* / 1.x
    let match = /^=?(\d+(?:\.\d+)*)\.[x*]$/i.exec(comparator)
    if (match) {
        return version === match[1] || version.startsWith(`${match[1]}.`)
    }
    // ~1.20.1: same minor version, at least the patch given
    match = /^~(\d+)\.(\d+)(?:\.\d+)?/.exec(comparator)
    if (match) {
        const upper = `${match[1]}.${Number(match[2]) + 1}`
        return versionCompare(version, comparator.slice(1), '>=') && versionCompare(version, upper, '<')
    }
    // ^1.20: same major version
    match = /^\^(\d+)/.exec(comparator)
    if (match) {
        return versionCompare(version, comparator.slice(1), '>=') && versionCompare(version, String(Number(match[1]) + 1), '<')
    }
    match = /^(>=|<=|>|<|=)?\s*(\d+(?:\.\d+)*(?:[-+][\w.]+)?)$/.exec(comparator)
    if (match) {
        const operator = match[1] || '='
        return operator === '=' ? equal(version, match[2]) : versionCompare(version, match[2], operator)
    }
    return true
}

/** A Maven range: one or more intervals such as "[1.20,1.21)" or "[1.20.1]"; any interval may match */
function maven(range: string, version: string): boolean {
    const intervals = [...range.matchAll(/([[(])\s*([^,\])]*?)\s*(,\s*([^\])]*?)\s*)?([\])])/g)]
    if (intervals.length === 0) {
        return true
    }
    for (const [, open, lower, hasComma = '', upper = '', close] of intervals) {
        // "[1.20.1]" pins an exact version
        if (hasComma === '') {
            if (equal(version, lower)) {
                return true
            }
            continue
        }
        const aboveLower = lower === '' || versionCompare(version, lower, open === '[' ? '>=' : '>')
        const belowUpper = upper === '' || versionCompare(version, upper, close === ']' ? '<=' : '<')
        if (aboveLower && belowUpper) {
            return true
        }
    }
    return false
}

/** Versions are equal when they only differ by trailing ".0" parts ("1.21" and "1.21.0") */
function equal(a: string, b: string): boolean {
    return versionCompare(a, b, '==') || versionCompare(a.replace(/(\.0)+$/, ''), b.replace(/(\.0)+$/, ''), '==')
}
