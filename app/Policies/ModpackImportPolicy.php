<?php

namespace App\Policies;

use App\Models\ModpackImport;
use App\Models\User;

class ModpackImportPolicy
{
    /**
     * Whoever started the import, or anyone who manages the modpack it went into.
     */
    public function view(User $user, ModpackImport $import): bool
    {
        return $import->user_id === $user->id
            || ($import->modpack !== null && $user->can('update', $import->modpack));
    }

    /**
     * Deciding what to do with a waiting import changes the modpack's builds.
     */
    public function update(User $user, ModpackImport $import): bool
    {
        return $import->modpack !== null && $user->can('update', $import->modpack);
    }
}
