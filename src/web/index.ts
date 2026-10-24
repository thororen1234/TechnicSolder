import { AuthController } from './auth.controller.js'
import { ClientController, KeyController } from './client-key.controller.js'
import { DashboardController } from './dashboard.controller.js'
import { ModController } from './mod.controller.js'
import { ModpackController } from './modpack.controller.js'
import { SolderController, TaskController } from './solder.controller.js'
import { UserController } from './user.controller.js'

export const WEB_CONTROLLERS = [
    AuthController,
    DashboardController,
    ClientController,
    KeyController,
    TaskController,
    SolderController,
    UserController,
    ModController,
    ModpackController,
]
