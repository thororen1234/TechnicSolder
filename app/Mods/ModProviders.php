<?php

namespace App\Mods;

class ModProviders
{
    public static function providers(): array
    {
        return [
            'modrinth' => \App\Mods\Providers\Modrinth::class,
            'fabric'   => \App\Mods\Providers\Fabric::class,
            'forge'    => \App\Mods\Providers\Forge::class,
            'neoforge' => \App\Mods\Providers\NeoForge::class,
            'curseforge' => \App\Mods\Providers\Curseforge::class,
        ];
    }
}