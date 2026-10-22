<?php

namespace App\Mods;

/**
 * Evaluates the version ranges mods declare for Minecraft: Fabric/npm style ("~1.20.1", ">=1.20 <1.21",
 * "1.20.x", alternatives joined with "||") and Maven style ("[1.20.1,1.21)", "[1.20.1]").
 *
 * Anything it can't parse counts as satisfied, so a mod is never flagged because of unusual syntax.
 */
final class VersionRange
{
    public static function satisfies(string $range, string $version): bool
    {
        $range = trim($range);

        if ($range === '' || $range === '*' || ! preg_match('/^\d+\.\d+/', $version)) {
            return true;
        }

        if (str_contains($range, '||')) {
            foreach (explode('||', $range) as $alternative) {
                if (self::satisfies($alternative, $version)) {
                    return true;
                }
            }

            return false;
        }

        if (preg_match('/^[\[(]/', $range)) {
            return self::maven($range, $version);
        }

        foreach (preg_split('/\s+/', $range) as $comparator) {
            if (! self::comparator($comparator, $version)) {
                return false;
            }
        }

        return true;
    }

    private static function comparator(string $comparator, string $version): bool
    {
        // 1.20.x / 1.20.* / 1.x
        if (preg_match('/^=?(\d+(?:\.\d+)*)\.[x*]$/i', $comparator, $match)) {
            return $version === $match[1] || str_starts_with($version, $match[1].'.');
        }

        // ~1.20.1: same minor version, at least the patch given
        if (preg_match('/^~(\d+)\.(\d+)(?:\.\d+)?/', $comparator, $match)) {
            $upper = $match[1].'.'.($match[2] + 1);

            return version_compare($version, substr($comparator, 1), '>=') && version_compare($version, $upper, '<');
        }

        // ^1.20: same major version
        if (preg_match('/^\^(\d+)/', $comparator, $match)) {
            return version_compare($version, substr($comparator, 1), '>=') && version_compare($version, ($match[1] + 1).'', '<');
        }

        if (preg_match('/^(>=|<=|>|<|=)?\s*(\d+(?:\.\d+)*(?:[-+][\w.]+)?)$/', $comparator, $match)) {
            $operator = $match[1] ?: '=';

            return $operator === '='
                ? self::equal($version, $match[2])
                : version_compare($version, $match[2], $operator);
        }

        return true;
    }

    /**
     * A Maven range: one or more intervals such as "[1.20,1.21)" or "[1.20.1]"; any interval may match.
     */
    private static function maven(string $range, string $version): bool
    {
        if (! preg_match_all('/([\[(])\s*([^,\])]*?)\s*(,\s*([^\])]*?)\s*)?([\])])/', $range, $intervals, PREG_SET_ORDER)) {
            return true;
        }

        foreach ($intervals as [, $open, $lower, $hasComma, $upper, $close]) {
            // "[1.20.1]" pins an exact version
            if ($hasComma === '') {
                if (self::equal($version, $lower)) {
                    return true;
                }

                continue;
            }

            $aboveLower = $lower === '' || version_compare($version, $lower, $open === '[' ? '>=' : '>');
            $belowUpper = $upper === '' || version_compare($version, $upper, $close === ']' ? '<=' : '<');

            if ($aboveLower && $belowUpper) {
                return true;
            }
        }

        return false;
    }

    /**
     * Versions are equal when they only differ by trailing ".0" parts ("1.21" and "1.21.0").
     */
    private static function equal(string $a, string $b): bool
    {
        return version_compare($a, $b, '==') || version_compare(preg_replace('/(\.0)+$/', '', $a), preg_replace('/(\.0)+$/', '', $b), '==');
    }
}
