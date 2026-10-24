/** Mojang Java runtimes a build can ask the launcher for, with their labels */
export const JAVA_RUNTIME_LABELS = {
    'jre-legacy': 'Java 8 (jre-legacy)',
    'java-runtime-alpha': 'Java 16 (java-runtime-alpha)',
    'java-runtime-beta': 'Java 17 (java-runtime-beta)',
    'java-runtime-gamma': 'Java 17 (java-runtime-gamma)',
    'java-runtime-delta': 'Java 21 (java-runtime-delta)',
    'java-runtime-epsilon': 'Java 25 (java-runtime-epsilon)',
} as const

export const JAVA_RUNTIMES = Object.keys(JAVA_RUNTIME_LABELS)

/** Minimum Java versions a build can require, newest first */
export const JAVA_VERSIONS = ['25', '21', '17', '16', '1.8', '1.7', '1.6'] as const
