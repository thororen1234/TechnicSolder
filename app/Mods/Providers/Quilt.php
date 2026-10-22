<?php

namespace App\Mods\Providers;

/**
 * Quilt Loader, packaged like Fabric as bin/version.json from Quilt Meta.
 */
class Quilt extends Fabric
{
    public static function name(): string
    {
        return 'Quilt';
    }

    protected static function apiUrl(): string
    {
        return 'https://meta.quiltmc.org/v3';
    }

    protected static function slug(): string
    {
        return 'quilt-loader';
    }

    protected static function authors(): string
    {
        return 'QuiltMC';
    }

    protected static function websiteUrl(): string
    {
        return 'https://quiltmc.org/';
    }

    protected static function thumbnailUrl(): string
    {
        return 'https://quiltmc.org/assets/img/logo.svg';
    }

    /**
     * Quilt Meta has no stable flag; pre-releases carry a "-beta"/"-pre" suffix instead.
     */
    protected static function isStable(object $loader): bool
    {
        return ! preg_match('/-(beta|pre|rc|alpha)/i', $loader->version ?? '');
    }
}
