<?php

namespace App\Mods;

use App\Mods\Providers\CurseForge;
use App\Mods\Providers\Fabric;
use App\Mods\Providers\Forge;
use App\Mods\Providers\Modrinth;
use App\Mods\Providers\NeoForge;
use App\Mods\Providers\Quilt;

class ModProviders
{
    public static function providers(): array
    {
        return [
            'modrinth' => Modrinth::class,
            'curseforge' => CurseForge::class,
            'fabric' => Fabric::class,
            'quilt' => Quilt::class,
            'forge' => Forge::class,
            'neoforge' => NeoForge::class,
        ];
    }
}
